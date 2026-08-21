#!/bin/bash
# Marine-band spectrum monitor.
# Every 3 minutes: pause AIS ~8s, scan 155.5-163.0 MHz, append to
# spectrum_history.json (bounded), also update signal_db.txt for the
# dashboard. Skips scanning while a satellite capture is running.

DASH=/home/ev/maritime-dashboard
HIST=$DASH/spectrum_history.json
STATE=$DASH/noaa_state.json
SIGNAL_FILE=$DASH/signal_db.txt
LOG=$DASH/monitor.log

FSTART=155500000
FSTOP=163000000
STEP=37500
MAXROWS=60   # 60 scans x 3 min = 3 hours of waterfall

log() { echo "$(date -Is) $*" >> "$LOG"; }
tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"

scan_once() {
    OUT=$(timeout --kill-after=5 25 /usr/local/bin/rtl_power -f ${FSTART}:${FSTOP}:${STEP} -i 2s -1 -e 20 -g 40 -p 34 2>/dev/null)
    [ -z "$OUT" ] && return 1
    python3 - "$OUT" "$HIST" "$MAXROWS" "$SIGNAL_FILE" << 'EOF'
import json, sys, time
rows = [r.split(',') for r in sys.argv[1].strip().splitlines()]
hist_path, maxrows, sigfile = sys.argv[2], int(sys.argv[3]), sys.argv[4]
bins = []
powers = []
for r in rows:
    start, stop, step = float(r[2]), float(r[3]), float(r[4])
    p = [float(x) for x in r[6:]]
    for i, v in enumerate(p):
        bins.append(start + i * step)
        powers.append(v)
if not powers:
    sys.exit(1)
# noise floor = median; strength = dB above floor
floor = sorted(powers)[len(powers) // 2]
rel = [round(v - floor, 1) for v in powers]
try:
    hist = json.load(open(hist_path))
except Exception:
    hist = {"f_start": bins[0], "f_step": bins[1] - bins[0], "scans": []}
hist["f_start"] = bins[0]
hist["f_step"] = bins[1] - bins[0]
hist["scans"].append({"t": time.time(), "floor": round(floor, 1), "p": rel})
hist["scans"] = hist["scans"][-maxrows:]
json.dump(hist, open(hist_path, 'w'))
# AIS band signal level for the System tab bar (max rel power near 161.9-162.1)
ais_lvl = max(rel[i] for i, f in enumerate(bins) if 161.85e6 <= f <= 162.15e6)
open(sigfile, 'w').write(str(ais_lvl))
EOF
    return 0
}

log "monitor started"
while true; do
    # Never scan during satellite capture (rtl_fm owns the SDR then)
    if grep -q '"capture_in_progress": true' "$STATE" 2>/dev/null; then
        sleep 60
        continue
    fi
    if systemctl is-active --quiet ais-catcher; then
        sudo systemctl stop ais-catcher
        sleep 1
        scan_once
        sudo systemctl start ais-catcher
    else
        scan_once   # SDR free anyway
    fi
    sleep 170
done
