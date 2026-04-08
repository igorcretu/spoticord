"""Spoticord librespot control API."""
from __future__ import annotations
import os, signal, subprocess, time, threading
from collections import deque
from pathlib import Path
import psutil
from flask import Flask, jsonify, request

app        = Flask(__name__)
PID_FILE   = Path("/tmp/librespot.pid")
PIPE_PATH  = Path("/tmp/audio/spotify.pcm")
ACTIVE_CONTROLLER_FILE = Path("/data/active_controller_id")
START_TIME = time.time()

_track_state = {"changed": False, "track_id": None, "event": None}
_track_lock  = threading.Lock()
_track_events = deque(maxlen=512)

def _proc() -> psutil.Process | None:
    try:
        p = psutil.Process(int(PID_FILE.read_text().strip()))
        return p if p.is_running() else None
    except Exception:
        for p in psutil.process_iter(["name"]):
            if p.info["name"] == "librespot":
                return p
    return None

def _base_cmd() -> list[str]:
    env = os.environ.copy()
    return [
        "librespot",
        "--name",           env.get("SPOTIFY_DEVICE_NAME", "SpoticordPi"),
        "--bitrate",        env.get("SPOTIFY_BITRATE", "320"),
        "--initial-volume", env.get("SPOTIFY_VOLUME", "80"),
        "--backend", "pipe",
        "--enable-volume-normalisation", "--normalisation-pregain", "-10",
        "--format", "S16", "-G",
        "--disable-discovery",
        "--system-cache", "/data/librespot-cache",
        "--onevent", "/tmp/onevent.sh",
    ]

def _kill_current():
    p = _proc()
    if p:
        try:
            p.send_signal(signal.SIGTERM)
            p.wait(timeout=5)
        except Exception:
            pass

def _spawn(cmd: list[str]) -> int:
    new_proc = subprocess.Popen(cmd)
    PID_FILE.write_text(str(new_proc.pid))
    return new_proc.pid

@app.get("/health")
def health():
    p = _proc()
    return jsonify({
        "status":    "ok" if p else "degraded",
        "uptime_s":  round(time.time() - START_TIME),
        "librespot": {
            "running": p is not None,
            "pid":     p.pid if p else None,
            "cpu_pct": round(p.cpu_percent(0.1), 1) if p else None,
            "mem_mb":  round(p.memory_info().rss / 1_048_576, 1) if p else None,
        },
        "pipe": {"exists": PIPE_PATH.exists()},
        "controller": {
            "discord_id": ACTIVE_CONTROLLER_FILE.read_text().strip() if ACTIVE_CONTROLLER_FILE.exists() else None,
        },
    })

@app.post("/set-controller")
def set_controller():
    data = request.get_json(force=True, silent=True) or {}
    discord_id = str(data.get("discord_id", "")).strip()
    if not discord_id.isdigit():
        return jsonify({"error": "discord_id must be numeric"}), 400

    current = ACTIVE_CONTROLLER_FILE.read_text().strip() if ACTIVE_CONTROLLER_FILE.exists() else ""
    if current == discord_id:
        return jsonify({"ok": True, "changed": False, "restarting": False, "controller": discord_id})

    ACTIVE_CONTROLLER_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_CONTROLLER_FILE.write_text(discord_id)

    # Restart container process so entrypoint relaunches librespot with new account token.
    subprocess.Popen(["sh", "-c", "sleep 0.2; kill -TERM 1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return jsonify({"ok": True, "changed": True, "restarting": True, "controller": discord_id})

@app.post("/restart")
def restart():
    _kill_current()
    pid = _spawn(_base_cmd())
    return jsonify({"restarted": True, "pid": pid})

@app.post("/volume")
def set_vol():
    lvl = (request.get_json(force=True, silent=True) or {}).get("level")
    if lvl is None or not (0 <= int(lvl) <= 100):
        return jsonify({"error": "level 0-100"}), 400
    try:
        subprocess.run(["amixer", "-q", "set", "Master", f"{int(lvl)}%"],
                       check=True, capture_output=True)
        return jsonify({"volume": int(lvl)})
    except Exception as e:
        return jsonify({"error": str(e)}), 207

@app.get("/volume")
def get_vol():
    try:
        r = subprocess.run(["amixer", "get", "Master"],
                           check=True, capture_output=True, text=True)
        for line in r.stdout.splitlines():
            if "[" in line and "%" in line:
                return jsonify({"volume": int(line.split("[")[1].split("%")[0])})
    except Exception:
        pass
    return jsonify({"volume": 80})

@app.post("/flush")
def flush_pipe():
    """Drain the FIFO pipe — does NOT restart librespot (would disconnect Spotify session)."""
    drained = 0
    try:
        fd = os.open(str(PIPE_PATH), os.O_RDONLY | os.O_NONBLOCK)
        buf = bytearray(65536)
        while True:
            try:
                n = os.readinto(fd, buf)
                if n == 0:
                    break
                drained += n
            except BlockingIOError:
                break
        os.close(fd)
    except Exception as e:
        return jsonify({"flushed": True, "drained": drained, "error": str(e)})
    return jsonify({"flushed": True, "drained": drained, "seconds": round(drained / 176400, 3)})

@app.post("/track-changed")
def track_changed():
    data = request.get_json(force=True, silent=True) or {}
    ev = {
        "track_id": data.get("track_id"),
        "event": data.get("event"),
        "ts": time.time(),
    }
    with _track_lock:
        _track_state["changed"]  = True
        _track_state["track_id"] = ev["track_id"]
        _track_state["event"]    = ev["event"]
        _track_events.append(ev)
    return jsonify({"ok": True})

@app.get("/track-changed")
def get_track_changed():
    with _track_lock:
        if _track_events:
            ev = _track_events.popleft()
            _track_state["changed"] = bool(_track_events)
            return jsonify({"changed": True, "track_id": ev["track_id"], "event": ev["event"], "ts": ev["ts"]})

        changed  = _track_state["changed"]
        track_id = _track_state["track_id"]
        event    = _track_state["event"]
        _track_state["changed"] = False
    return jsonify({"changed": changed, "track_id": track_id, "event": event})

@app.get("/track-events")
def get_track_events():
    with _track_lock:
        events = list(_track_events)
        _track_events.clear()
        _track_state["changed"] = False
    return jsonify({"events": events, "count": len(events)})