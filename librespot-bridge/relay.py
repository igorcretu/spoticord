"""
Real-time audio relay: librespot stdout → FIFO pipe.

The key insight: librespot decodes audio faster than real-time and dumps
it all into its stdout buffer. We must read from stdin AND write to FIFO
at real-time pace (176400 bytes/sec), otherwise the pipe fills with
seconds of pre-decoded audio causing delays on track change.

Strategy:
- Read stdin in small chunks at real-time pace (sleep between reads)
- Write immediately to FIFO
- If FIFO is full (pipe buffer = 256KB ≈ 1.5s), block — this is fine,
  it means FFmpeg is reading at the right rate
- On broken pipe (FFmpeg killed): skip the write, keep reading stdin
  at real-time pace to prevent librespot from blocking
"""
import sys, os, time, threading

BYTES_PER_SEC = 176400   # 44100Hz * 2ch * 2bytes
CHUNK_MS      = 20        # read/write every 20ms (one Opus frame)
CHUNK_SIZE    = int(BYTES_PER_SEC * CHUNK_MS / 1000)  # 3528 bytes

PIPE_PATH = os.environ.get("PIPE_PATH", "/tmp/audio/spotify.pcm")

fd   = os.open(PIPE_PATH, os.O_RDWR)
pipe = os.fdopen(fd, "wb", buffering=0)

# Stats
_stats_bytes = 0
_stats_lock  = threading.Lock()

def reporter():
    global _stats_bytes
    zero_streak = 0
    while True:
        time.sleep(1.0)
        with _stats_lock:
            b = _stats_bytes
            _stats_bytes = 0
        if b == 0:
            zero_streak += 1
            # Suppress idle spam; emit one heartbeat every minute while silent.
            if zero_streak % 60 != 0:
                continue
        else:
            zero_streak = 0

        ratio = b / BYTES_PER_SEC
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(f"[{ts}] [relay] {b} bytes ({ratio:.3f}x realtime)", flush=True)

threading.Thread(target=reporter, daemon=True).start()

ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
print(f"[{ts}] [relay] starting chunk={CHUNK_SIZE}B ({CHUNK_MS}ms) pipe={PIPE_PATH}", flush=True)

stdin = sys.stdin.buffer

interval_s = CHUNK_MS / 1000.0
next_deadline = time.perf_counter() + interval_s

while True:
    # --- RATE-LIMITED READ from librespot stdout ---
    # Sleep BEFORE reading so we don't pull data faster than real-time.
    # If read() was blocked during pause/network stalls, resync pacing so we
    # do not "catch up" and drain buffered audio at >1x speed.
    sleep_time = next_deadline - time.perf_counter()
    if sleep_time > 0:
        time.sleep(sleep_time)

    data = stdin.read(CHUNK_SIZE)
    if not data:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(f"[{ts}] [relay] stdin EOF", flush=True)
        break

    # --- Write to FIFO ---
    try:
        pipe.write(data)
        with _stats_lock:
            _stats_bytes += len(data)
    except BrokenPipeError:
        # FFmpeg was killed — keep reading stdin to prevent librespot blocking,
        # but don't count these bytes (they're being discarded)
        pass

    now = time.perf_counter()
    next_deadline += interval_s
    if now - next_deadline > interval_s * 2:
        next_deadline = now + interval_s

pipe.close()
