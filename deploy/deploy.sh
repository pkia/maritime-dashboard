#!/usr/bin/env bash
# Pull-based continuous deployment for the maritime dashboard.
#
# Triggered every few minutes by maritime-dashboard-deploy.timer (or run by
# hand). Pulls origin/main, runs quick checks, restarts the service, then
# health-checks the app. If the app does not come back healthy, the previous
# commit is redeployed automatically.
#
# Only origin/main is ever deployed - code from forks or PR branches never
# touches this machine.
set -u

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
SERVICE=maritime-dashboard
PORT=8000
PYTHON="$REPO_DIR/bin/python"   # project venv
LOG="$REPO_DIR/deploy.log"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

cd "$REPO_DIR" || exit 1

if ! git remote get-url origin >/dev/null 2>&1; then
    log "skip: no origin remote configured yet"
    exit 0
fi

if ! git fetch origin main --quiet 2>>"$LOG"; then
    log "skip: fetch failed (offline?)"
    exit 0
fi

PREV=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$PREV" = "$REMOTE" ]; then
    exit 0  # nothing new, stay quiet
fi

log "deploying ${REMOTE:0:12} (was ${PREV:0:12})"
git reset --hard "$REMOTE" >>"$LOG" 2>&1

health_ok() {
    curl -sf -m 5 -o /dev/null "http://127.0.0.1:$PORT/"
}

restart_service() {
    sudo systemctl restart "$SERVICE"
    for _ in $(seq 1 12); do
        sleep 2.5
        health_ok && return 0
    done
    return 1
}

# Gate: incoming code must byte-compile and import cleanly before we restart.
if ! "$PYTHON" -m compileall -q app.py scripts || \
   ! "$PYTHON" -c "import app" >>"$LOG" 2>&1; then
    log "CHECKS FAILED on $REMOTE - rolling back to ${PREV:0:12}"
    git reset --hard "$PREV" >>"$LOG" 2>&1
    exit 1
fi

if ! restart_service; then
    log "HEALTH CHECK FAILED after deploy - rolling back to ${PREV:0:12}"
    git reset --hard "$PREV" >>"$LOG" 2>&1
    sudo systemctl restart "$SERVICE"
    if restart_service; then
        log "rollback to ${PREV:0:12} successful"
    else
        log "ROLLBACK ALSO UNHEALTHY - service state:"
        systemctl status "$SERVICE" --no-pager -l | tail -20 | tee -a "$LOG"
    fi
    exit 1
fi

log "deployed ${REMOTE:0:12} and healthy"
