#!/usr/bin/env bash
set -euo pipefail

PIPE=/tmp/audio/spotify.pcm
TOKEN_DIR=/data/tokens
CACHE_DIR=/data/librespot-cache

mkdir -p "$CACHE_DIR"

[[ -e "$PIPE" && ! -p "$PIPE" ]] && rm -f "$PIPE"
[[ ! -p "$PIPE" ]] && mkfifo "$PIPE"
chmod 666 "$PIPE"

# Keep FIFO read end open so relay never gets SIGPIPE
exec 3<>"$PIPE"

# onevent script
cat > /tmp/onevent.sh << 'ONEVENT'
#!/bin/bash
TS=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
echo "[${TS}] [onevent] PLAYER_EVENT=$PLAYER_EVENT TRACK_ID=$TRACK_ID" >&2
case "$PLAYER_EVENT" in
  track_changed|start_of_track|playing|paused|stopped)
    curl -s -X POST http://localhost:5050/track-changed \
      -H "Content-Type: application/json" \
      -d "{\"track_id\":\"$TRACK_ID\",\"event\":\"$PLAYER_EVENT\"}" \
      > /dev/null 2>&1 || true
    ;;
esac
ONEVENT
chmod +x /tmp/onevent.sh

echo "[librespot] Starting control API…"
gunicorn --bind 0.0.0.0:5050 --workers 1 --log-level warning api:app &
API_PID=$!

cleanup() {
    echo "[librespot] Shutting down…"
    kill "$API_PID"   2>/dev/null || true
    kill "$RELAY_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

CREDS_FILE="$CACHE_DIR/credentials.json"
ACCESS_TOKEN=""

if [[ ! -f "$CREDS_FILE" ]]; then
    echo "[librespot] No cached credentials yet — waiting for OAuth token…"
    while true; do
        if [[ -d "$TOKEN_DIR" ]]; then
            for f in "$TOKEN_DIR"/*.json; do
                [[ -f "$f" ]] || continue
                TOKEN=$(python3 - "$f" <<'PYEOF'
import json, sys, time, urllib.request, urllib.parse, base64, os
path = sys.argv[1]
try:
    data = json.loads(open(path).read())
except Exception:
    sys.exit(1)
if time.time() > data.get("expires_at", 0) - 60:
    cid = os.environ.get("SPOTIFY_CLIENT_ID", "")
    cs  = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    if cid and cs:
        try:
            creds = base64.b64encode(f"{cid}:{cs}".encode()).decode()
            req = urllib.request.Request(
                "https://accounts.spotify.com/api/token",
                data=urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": data["refresh_token"]}).encode(),
                headers={"Authorization": f"Basic {creds}", "Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
            data["access_token"] = resp["access_token"]
            data["expires_at"] = time.time() + resp.get("expires_in", 3600)
            if "refresh_token" in resp:
                data["refresh_token"] = resp["refresh_token"]
            open(path, "w").write(json.dumps(data))
        except Exception:
            pass
tok = data.get("access_token", "")
print(tok if tok else "", end="")
PYEOF
                )
                if [[ -n "$TOKEN" ]]; then
                    ACCESS_TOKEN="$TOKEN"
                    break 2
                fi
            done
        fi
        sleep 10
    done
    echo "[librespot] Got token — starting for the first time"
else
    echo "[librespot] Cached credentials found — starting without token"
fi

ARGS=(
    --name               "${SPOTIFY_DEVICE_NAME:-SpoticordPi}"
    --bitrate            "${SPOTIFY_BITRATE:-320}"
    --initial-volume     "${SPOTIFY_VOLUME:-80}"
    --backend            pipe
    --enable-volume-normalisation
    --normalisation-pregain -10
    --format             S16
    -G
    --disable-discovery
    --system-cache       "$CACHE_DIR"
    --onevent            /tmp/onevent.sh
)

[[ -n "$ACCESS_TOKEN" ]] && ARGS+=(--access-token "$ACCESS_TOKEN")

echo "[librespot] Starting ${SPOTIFY_DEVICE_NAME:-SpoticordPi}…"

# Rate-limited relay: reads stdin AND writes FIFO at real-time pace.
# Sleep BEFORE each read so librespot's stdout buffer never builds up.
PIPE_PATH="$PIPE" librespot "${ARGS[@]}" | python3 -u /app/relay.py &
RELAY_PID=$!

wait "$RELAY_PID"
echo "[librespot] Relay exited"