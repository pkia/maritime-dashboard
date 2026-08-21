#!/usr/bin/env python3
"""Maritime Dashboard - AIS + NOAA weather satellite kiosk backend."""
import os
import re
import glob
import subprocess
import time
from flask import Flask, jsonify, render_template, send_from_directory

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True

# Paths resolve relative to this file so the app runs from any checkout.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NOAA_DIR = os.path.join(BASE_DIR, "static", "images", "noaa")
STATE_FILE = os.path.join(BASE_DIR, "noaa_state.json")
_last_refresh_touch = 0.0


def sh(cmd, timeout=10):
    """Run a shell command, return stdout or empty string on failure."""
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    # SDR detection
    sdr = "0bda:2838" in sh("lsusb")

    # AIS-catcher service
    ais_active = sh("systemctl is-active ais-catcher") == "active"
    ais_pid = sh("systemctl show -p MainPID --value ais-catcher")

    # Message count from the service log (last "total: N msgs" line)
    log = sh("journalctl -u ais-catcher -n 5 --no-pager", timeout=15)
    m = re.findall(r"total:\s+(\d+)\s+msgs", log)
    msgs = m[-1] + " total" if m else "0"

    # System metrics
    uptime_s = "up " + sh("uptime -p", timeout=5).replace("up ", "")
    try:
        t = int(open("/sys/class/thermal/thermal_zone0/temp").read()) / 1000.0
        temp = f"{t:.1f}°C"
    except Exception:
        temp = "--"
    mem = sh("free -h | awk '/Mem:/ {print $3\" / \"$2}'")
    disk = sh("df -h / | awk 'NR==2 {print $4}'")

    # Touch device
    touch = any("ILITEK" in l for l in sh("cat /proc/bus/input/devices").splitlines())

    # Signal power at AIS band (cached file written by the monitor script)
    db = -100.0
    try:
        db = float(open(os.path.join(BASE_DIR, "signal_db.txt")).read().strip())
    except Exception:
        pass

    return jsonify({
        "sdr_detected": sdr,
        "ais_running": ais_active,
        "ais_pid": ais_pid if ais_pid else "--",
        "ais_messages": msgs,
        "uptime": uptime_s,
        "cpu_temp": temp,
        "mem_used": mem.split("/")[0].strip() if mem else "--",
        "mem_total": mem.split("/")[1].strip() if "/" in mem else "--",
        "disk_free": disk if disk else "--",
        "touch_detected": touch,
        "signal_db": db,
        "time": time.strftime("%H:%M:%S"),
    })


@app.route("/api/noaa")
def api_noaa():
    # Read state written by the capture scheduler
    state = {"next_passes": [], "images": [], "capture_in_progress": False,
             "status_message": "NOAA capture scheduler not active"}
    try:
        import json
        state.update(json.load(open(STATE_FILE)))
    except Exception:
        pass

    # Always rescan the image directory
    images = []
    for f in sorted(glob.glob(os.path.join(NOAA_DIR, "*.bmp")) +
                    glob.glob(os.path.join(NOAA_DIR, "*.png")), reverse=True)[:8]:
        name = os.path.basename(f)
        images.append({
            "url": "/static/images/noaa/" + name,
            "caption": name.rsplit(".", 1)[0].replace("_", " "),
        })
    state["images"] = images
    return jsonify(state)


@app.route("/api/spectrum")
def api_spectrum():
    try:
        import json
        return jsonify(json.load(open(os.path.join(BASE_DIR, "spectrum_history.json"))))
    except Exception:
        return jsonify({"f_start": 155500000, "f_step": 37500, "scans": []})


@app.route("/api/onlineships")
def api_onlineships():
    try:
        import json
        return jsonify(json.load(open(os.path.join(BASE_DIR, "online_ships.json"))))
    except Exception:
        return jsonify({"ok": False, "count": 0, "ships": []})


@app.route("/api/onlineships/refresh", methods=["POST"])
def api_onlineships_refresh():
    # Touch the trigger file so the quota-aware daemon fetches soon
    # (rate-limited here to once per 10 min no matter how many browsers ask)
    global _last_refresh_touch
    now = time.time()
    if now - _last_refresh_touch > 600:
        _last_refresh_touch = now
        open(os.path.join(BASE_DIR, "refresh_online.trigger"), "w").close()
    return jsonify({"ok": True})


if __name__ == "__main__":
    os.makedirs(NOAA_DIR, exist_ok=True)
    app.run(host="0.0.0.0", port=8000, threaded=True)
