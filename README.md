# Spoticord

Spotify Connect to Discord voice bridge with per-user OAuth, host handoff support, and multi-guild operation.

## Services

This stack runs four containers:

- librespot bridge: Spotify Connect sink plus realtime playback events
- oauth server: Spotify OAuth callback and token storage
- discord bot: session orchestration, playback control, voice streaming, commands
- weather: optional weather webhook poster

## Architecture

1. User runs start command.
2. Bot resolves controller account (requester mode or shared mode).
3. Bot optionally switches active controller via bridge API.
4. Librespot exposes Spotify device and outputs PCM to shared pipe.
5. Discord bot encodes PCM with ffmpeg and streams into voice.
6. Session state is tracked per guild with host ownership and diagnostics.

## Key Features

- Per-user Spotify OAuth tokens
- Requester or shared controller mode
- Presence-based auto leave logic
- Host leave grace handling and host transfer command
- Queue history commands
- Restart watchdog per guild
- Structured JSON logging with redaction
- Bot health endpoint and Prometheus-style metrics endpoint
- Prefix and slash commands
- Atomic JSON persistence with schema wrapper

## Requirements

- Docker and Docker Compose
- Spotify Premium account
- Discord bot application and token
- Spotify Developer app (Client ID, Client Secret, Redirect URI)
- Public HTTPS callback URL (Cloudflare Tunnel recommended)

## Quick Start

1. Copy environment template.

```bash
cp .env.example .env
```

1. Fill required values in .env.

1. Build and start.

```bash
docker compose up -d --build
```

1. Verify.

```bash
docker compose ps
docker compose logs -f discord-bot librespot oauth-server
```

## Environment Variables

Core:

- DISCORD_TOKEN
- DISCORD_PREFIX
- APP_NAME
- SPOTIFY_CLIENT_ID
- SPOTIFY_CLIENT_SECRET
- SPOTIFY_REDIRECT_URI
- SPOTIFY_DEVICE_NAME
- SPOTIFY_BITRATE
- SPOTIFY_VOLUME

Controller:

- SPOTIFY_CONTROLLER_MODE (requester or shared)
- SPOTIFY_SHARED_DISCORD_ID

Presence and behavior:

- DISCORD_ACTIVITY_TEXT
- DISCORD_ACTIVITY_TYPE
- AUTO_JOIN_WITHOUT_SESSION
- HOST_LEAVE_GRACE_MS

Reliability:

- MAX_RESTARTS_PER_MIN
- BOT_HEALTH_PORT
- RESTART_STATE_FILE

Command policy:

- MOD_ROLE_IDS (CSV role IDs)
- ADMIN_ROLE_IDS (CSV role IDs)

Logging:

- LOG_LEVEL

See defaults in [.env.example](.env.example).

## Commands

Playback:

- !start
- !stop
- !np
- !session

Queue:

- !queue
- !dequeue [index]

Voice:

- !join
- !leave
- !setchannel [#channel]

Audio:

- !volume [0-200]
- !restart

Account:

- !link
- !login
- !unlink
- !jam [url]

Debug:

- !status
- !debug
- !diagnostics
- !controller
- !tokeninfo
- !devices
- !voice
- !flush
- !restream

Host management:

- !transferhost @user

Utility:

- !ping
- !help

Slash commands:

- /start
- /stop
- /status
- /session
- /queue
- /dequeue
- /diagnostics
- /ping
- /transferhost
- /setchannel
- /restart

## Health and Metrics

discord-bot exposes:

- /health
- /metrics

Examples:

```bash
docker compose exec -T discord-bot node -e "fetch('http://localhost:7070/health').then(r=>r.text()).then(console.log)"
docker compose exec -T discord-bot node -e "fetch('http://localhost:7070/metrics').then(r=>r.text()).then(console.log)"
```

## Persistence

Stored in bot_config Docker volume under /data:

- /data/tokens
- /data/guild_config.json
- /data/jam_links.json
- /data/restart_state.json
- /data/active_controller_id
- /data/librespot-cache

## Security Notes

- Never commit .env.
- Rotate secrets immediately if exposed.
- Use LOG_LEVEL=INFO in production unless actively debugging.
- Set MOD_ROLE_IDS and ADMIN_ROLE_IDS to restrict sensitive commands.

## Troubleshooting

Device not visible:

- Check bridge health and auth logs.
- Confirm SPOTIFY_DEVICE_NAME.
- Use !devices for active controller visibility.

No audio in Discord:

- Check !status and !debug.
- Confirm bot is in expected voice channel.
- Use !restream or !restart if needed.

OAuth issues:

- Ensure SPOTIFY_REDIRECT_URI exactly matches Spotify dashboard.
- Confirm oauth-server reachable at public callback URL.

## Useful Operations

```bash
# Full rebuild
docker compose up -d --build

# Rebuild selected services
docker compose up -d --build librespot discord-bot

# Follow key logs
docker compose logs -f discord-bot librespot oauth-server

# Check health states
docker compose ps
```
