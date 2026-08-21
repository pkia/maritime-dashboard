#!/usr/bin/env python3
"""NOAA APT pass scheduler + SDR capture coordinator.

Uses skyfield to predict NOAA 15/18/19 passes over the station,
pauses AIS-catcher during good passes, records the APT signal with
rtl_fm, and decodes with noaa-apt if installed (else keeps the wav).

Writes dashboard state to noaa_state.json.
"""
import json
import math
import os
import subprocess
import time
import urllib.request
from datetime import datetime, timedelta, timezone

from skyfield.api import EarthSatellite, load, wgs84

DASH = "/home/ev/maritime-dashboard"
NOAA_DIR = os.path.join(DASH, "static/images/noaa")
AUDIO_DIR = os.path.join(DASH, "noaa_audio")
STATE = os.path.join(DASH, "noaa_state.json")
TLE_FILE = os.path.join(DASH, "weather.txt")
LOG = os.path.join(DASH, "noaa.log")

# Station location: update to your exact coordinates!
LAT, LON = 52.159428, -7.14919  # station location (Waterford coast)

SAT_FREQ = {"METEOR-M2 2": 137100000, "METEOR-M2 3": 137900000, "METEOR-M2 4": 137900000}
MIN_ELEV = 20  # degrees

stations_url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle"


def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{datetime.now().isoformat()} {msg}\n")


def write_state(capturing, message, passes):
    with open(STATE, "w") as f:
        json.dump({
            "capture_in_progress": capturing,
            "status_message": message,
            "next_passes": passes,
        }, f)


def refresh_tle():
    """Download weather satellite TLEs (daily)."""
    age = time.time() - os.path.getmtime(TLE_FILE) if os.path.exists(TLE_FILE) else 1e9
    if age > 86400:
        try:
            urllib.request.urlretrieve(stations_url, TLE_FILE)
            log("TLEs refreshed")
        except Exception as e:
            log(f"TLE download failed: {e}")
            if not os.path.exists(TLE_FILE):
                raise


def get_satellites():
    sats = {}
    with open(TLE_FILE) as f:
        lines = [l.rstrip() for l in f if l.strip()]
    for i in range(0, len(lines) - 2, 3):
        name = lines[i].strip()
        for target in SAT_FREQ:
            if name.upper().startswith(target.upper()):
                sats[target] = EarthSatellite(lines[i + 1], lines[i + 2], target)
    return sats


def next_passes(sats, station, ts, hours=12):
    """Find passes in the next N hours above the horizon."""
    t0 = ts.now()
    t0_dt = t0.utc_datetime()
    end_dt = t0_dt + timedelta(hours=hours)
    passes = []

    # Build one shared time grid: 60s coarse over the window
    coarse_times = []
    cur = t0_dt
    while cur < end_dt:
        coarse_times.append(cur)
        cur += timedelta(seconds=60)
    t_coarse = ts.from_datetimes(coarse_times)

    for name, sat in sats.items():
        diff = sat - station
        alt_c = diff.at(t_coarse).altaz()[0]
        deg_c = alt_c.degrees

        i = 0
        while i < len(deg_c):
            if deg_c[i] > 0:
                # Found a rise. Refine with a 10s grid for the next 20 minutes.
                fine_dts = []
                cur = coarse_times[i] - timedelta(seconds=60)
                stop = coarse_times[i] + timedelta(minutes=20)
                while cur < stop:
                    fine_dts.append(cur)
                    cur += timedelta(seconds=10)
                t_fine = ts.from_datetimes(fine_dts)
                alt_f = diff.at(t_fine).altaz()[0]
                deg_f = alt_f.degrees

                rise_i = next((k for k, d in enumerate(deg_f) if d > 0), 0)
                peak_i = int(max(range(len(deg_f)), key=lambda k: deg_f[k]))
                set_i = next((k for k in range(peak_i, len(deg_f)) if deg_f[k] <= 0), len(deg_f) - 1)

                passes.append({
                    "satellite": name,
                    "start": fine_dts[rise_i],
                    "end": fine_dts[set_i],
                    "max_elev": deg_f[peak_i],
                    "direction": "N" if sat.at(t_fine[peak_i]).subpoint().latitude.degrees
                                 > station.latitude.degrees else "S",
                })
                # Continue coarse scan past this pass's end
                i = next((k for k in range(i, len(coarse_times))
                          if coarse_times[k] >= fine_dts[set_i]), len(coarse_times) - 1) + 1
            else:
                i += 1

    passes.sort(key=lambda p: p["start"])
    return passes


def record_pass(name, freq, start_utc, end_utc):
    dur = int((end_utc - datetime.now(timezone.utc)).total_seconds()) + 30
    if dur < 60:
        return
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    base = os.path.join(AUDIO_DIR, f"{name.replace(' ', '-')}_{stamp}")
    wav = base + ".wav"
    sym = base + ".s"
    png = os.path.join(NOAA_DIR, f"{name.replace(' ', '-')}_{stamp}.bmp")

    log(f"capture start: {name} {freq} for {dur}s")
    # Stop BOTH SDR consumers - the spectrum monitor also grabs the dongle
    # every ~3 min for scans and will collide with us otherwise
    subprocess.run(["sudo", "systemctl", "stop", "sdr-monitor"])
    subprocess.run(["sudo", "systemctl", "stop", "ais-catcher"])
    time.sleep(2)
    recorded = False
    try:
        # METEOR LRPT: 80 kbaud OQPSK needs wideband capture (288 ks/s).
        # Retry: the device may take a moment to be released after stops.
        for attempt in range(3):
            try:
                subprocess.run(
                    ["/usr/local/bin/rtl_fm", "-f", str(freq), "-M", "fm",
                     "-s", "288000", "-g", "40", "-p", "34", "-F", "9", "-E", "dc", wav],
                    timeout=dur)
                if os.path.exists(wav) and os.path.getsize(wav) > 100000:
                    recorded = True
                    break
                log(f"rtl_fm attempt {attempt+1} produced no data, retrying")
            except subprocess.TimeoutExpired:
                recorded = os.path.exists(wav)
                break
            time.sleep(3)
    finally:
        subprocess.run(["sudo", "systemctl", "start", "ais-catcher"])
        subprocess.run(["sudo", "systemctl", "start", "sdr-monitor"])
    if not recorded or not os.path.exists(wav):
        log("capture failed: could not open SDR")
        return
    log(f"capture done: {wav} ({os.path.getsize(wav) // 1024} KB)")

    # Decode: meteor_demod (FM wav -> soft symbols) then meteor_decode (-> image)
    try:
        r = subprocess.run(["/usr/local/bin/meteor_demod", "-B", "-m", "oqpsk", "-s", "288000",
                            "-r", "80000", "-o", sym, wav],
                           capture_output=True, timeout=600)
        if r.returncode == 0 and os.path.exists(sym):
            r2 = subprocess.run(["/usr/local/bin/meteor_decode", "-o", png, sym],
                                capture_output=True, timeout=600)
            ok = r2.returncode == 0 and os.path.exists(png)
            log(f"decode {'OK: ' + png if ok else 'failed (no image)'}")
        else:
            log(f"demod failed: {r.stderr.decode(errors='replace')[:120]}")
    except Exception as e:
        log(f"decode error: {e}")


def main():
    os.makedirs(NOAA_DIR, exist_ok=True)
    os.makedirs(AUDIO_DIR, exist_ok=True)
    log("scheduler started")
    write_state(False, "Scheduler running", [])

    while True:
        try:
            refresh_tle()
            sats = get_satellites()
            if not sats:
                log("no weather satellites in TLE file")
                time.sleep(3600)
                continue
            ts = load.timescale()
            station = wgs84.latlon(LAT, LON)
            passes = next_passes(sats, station, ts)

            # Publish the schedule to the dashboard
            sched = [{
                "satellite": p["satellite"],
                "start": p["start"].astimezone().strftime("%H:%M"),
                "max_elevation": p["max_elev"],
                "direction": p["direction"],
            } for p in passes[:6]]
            write_state(False, f"{len(passes)} passes in next 12h", sched)

            # Wait for / execute the next good pass
            for p in passes:
                if p["max_elev"] < MIN_ELEV:
                    continue
                wait = (p["start"] - datetime.now(timezone.utc)).total_seconds() - 30
                if wait > 0:
                    if wait > 600:
                        break  # re-check schedule later
                    log(f"waiting {wait:.0f}s for {p['satellite']} pass")
                    write_state(False, f"Next: {p['satellite']} at {p['start'].astimezone().strftime('%H:%M')} ({p['max_elev']:.0f}°)", sched)
                    time.sleep(wait)
                write_state(True, f"Capturing {p['satellite']} pass NOW", sched)
                record_pass(p["satellite"], SAT_FREQ[p["satellite"]], p["start"], p["end"])
                write_state(False, "Idle — waiting for next pass", sched)
                break
            time.sleep(600)
        except Exception as e:
            log(f"error: {e}")
            write_state(False, f"Scheduler error: {e}", [])
            time.sleep(600)


if __name__ == "__main__":
    main()
