#!/usr/bin/env bash
# Launch the UFC Bet Tracker.
# Usage: ./launch.sh [--host 127.0.0.1] [--port 8212] [--no-open]
set -euo pipefail
cd "$(dirname "$0")"

HOST=127.0.0.1
PORT=8212
OPEN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-open) OPEN=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Load .env if present (UFC_V3_DB, THE_ODDS_API_KEY)
[ -f .env ] && set -a && . ./.env && set +a

PY=python3
if [ ! -x venv/bin/python ]; then
  echo "First run: creating venv and installing dependencies..."
  $PY -m venv venv
  ./venv/bin/pip install -q -r requirements.txt
fi
PY=./venv/bin/python

echo "Checking for updates..."
$PY self_update.py || true

echo "UFC Bet Tracker → http://$HOST:$PORT"
[ "$OPEN" = 1 ] && { (xdg-open "http://$HOST:$PORT" >/dev/null 2>&1 || true) & }
exec $PY -m uvicorn app:app --host "$HOST" --port "$PORT"
