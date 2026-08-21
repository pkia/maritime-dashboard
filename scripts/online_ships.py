#!/usr/bin/env python3
"""Online AIS ship feeder (VesselAPI REST).

Quota-aware design (the free key's monthly quota is small):
- Refreshes upstream at most every 20 minutes, OR on demand when the
  dashboard's Online tab is actually being viewed (trigger file).
- Hard-backs-off for 6 hours on quota errors so we never burn requests
  into a dead key.
- Ships older than MAX_AGE are dropped from the display.
"""
import json
import math
import os
import time
import urllib.request
import urllib.error

DASH = "/home/ev/maritime-dashboard"
KEY_FILE = os.path.join(DASH, "vesselapi_key.txt")
STATE_FILE = os.path.join(DASH, "online_ships.json")
TRIGGER_FILE = os.path.join(DASH, "refresh_online.trigger")

LAT0, LON0 = 52.159428, -7.14919
LAT_B, LAT_T = 51.5, 52.7
LON_L, LON_R = -8.6, -5.9  # span 1.2 + 2.7 = 3.9 < 4 (API strict limit)

POLL = 1200        # background refresh: every 20 min
QUOTA_BACKOFF = 6 * 3600  # after quota errors: wait 6 h
MAX_AGE = 900      # drop ships with positions older than 15 min

URL = (f"https://api.vesselapi.com/v1/location/vessels/bounding-box"
       f"?filter.latBottom={LAT_B}&filter.latTop={LAT_T}"
       f"&filter.lonLeft={LON_L}&filter.lonRight={LON_R}")


def dist_km(la, lo):
    return 6371 * math.acos(min(1.0,
        math.sin(math.radians(la)) * math.sin(math.radians(LAT0)) +
        math.cos(math.radians(la)) * math.cos(math.radians(LAT0)) *
        math.cos(math.radians(lo - LON0))))


def fetch():
    key = open(KEY_FILE).read().strip()
    req = urllib.request.Request(URL, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("vessels", [])


def write_state(ships, note, next_at):
    state = {
        "ok": True,
        "source": "api.vesselapi.com",
        "count": len(ships),
        "ships": sorted(ships.values(), key=lambda s: s.get("dist_km", 9999)),
        "note": note,
        "next_refresh": time.strftime("%H:%M", time.localtime(next_at)),
        "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


ships = {}
next_fetch = 0.0
sleep_until = 0.0

while True:
    now = time.time()

    # Drop stale vessels
    fresh = {}
    for mmsi, v in ships.items():
        ts = v.get("_epoch", now)
        if now - ts < MAX_AGE:
            fresh[mmsi] = v
    ships = fresh

    want_fetch = now >= next_fetch
    # On-demand: dashboard touches the trigger file when Online tab is viewed
    try:
        if os.path.getmtime(TRIGGER_FILE) > next_fetch - POLL:
            want_fetch = True
    except OSError:
        pass

    note = "waiting"
    if want_fetch and now >= sleep_until:
        try:
            vessels = fetch()
            tnow = time.time()
            for v in vessels:
                mmsi = v.get("mmsi")
                if not mmsi or v.get("latitude") is None:
                    continue
                ships[mmsi] = {
                    "mmsi": mmsi,
                    "name": v.get("vessel_name", ""),
                    "lat": v.get("latitude"),
                    "lon": v.get("longitude"),
                    "sog": v.get("sog"),
                    "cog": v.get("cog"),
                    "dist_km": round(dist_km(v["latitude"], v["longitude"]), 1),
                    "_epoch": tnow,
                }
            note = f"ok, {len(ships)} ships"
            next_fetch = now + POLL
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read(200).decode(errors="replace")
            except Exception:
                pass
            if e.code in (403, 429) or "quota" in body.lower():
                note = f"quota exhausted ({e.code}) - backing off 6h"
                sleep_until = now + QUOTA_BACKOFF
                next_fetch = now + QUOTA_BACKOFF
            else:
                note = f"error {e.code}: {body[:80]}"
                next_fetch = now + 300
        except Exception as e:
            note = f"error: {str(e)[:100]}"
            next_fetch = now + 300
    elif want_fetch:
        note = "backing off after quota error"

    write_state(ships, note, max(next_fetch, sleep_until))
    time.sleep(30)
