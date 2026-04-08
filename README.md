# Spoticord

Spotify Connect -> Discord voice bridge with per-user OAuth, host switching, and multi-guild support.

This project runs three services:
- librespot bridge: creates the Spotify Connect sink device and emits realtime playback events
- oauth server: handles Spotify OAuth callback and stores user tokens
- discord bot: controls playback, streams audio to Discord, and manages sessions/commands

## Architecture

- Discord user runs !start
- Bot resolves controller account (requester or shared mode)
- Bot asks bridge to switch active controller account when needed
- Bridge restarts librespot with the selected account token
- Bot transfers playback to device name (for example Nikitify)
- PCM from librespot is encoded with ffmpeg and played in Discord voice

Main files:
- [docker-compose.yml](docker-compose.yml)
- [discord-bot/index.js](discord-bot/index.js)
- [librespot-bridge/api.py](librespot-bridge/api.py)
- [librespot-bridge/entrypoint.sh](librespot-bridge/entrypoint.sh)
- [oauth-server/app.py](oauth-server/app.py)

## Features

- Spotify OAuth per Discord user
- Per-host account switching on !start (requester mode)
- Realtime playback state sync (track/pause/resume)
- Voice auto-join and idle auto-leave
- Now playing embed with controls
- Saved Jam link per guild
- Debug command suite for live diagnostics

## Requirements

- Docker + Docker Compose
- Spotify Premium for playback control
- Discord bot token
- Spotify Developer app (Client ID/Secret + redirect URI)
- Public HTTPS callback URL (Cloudflare tunnel recommended)

For full step-by-step onboarding, see [SETUP.md](SETUP.md).

## Quick Start

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill .env values.

3. Build and start:

```bash
docker compose up -d --build
```

4. Check services:

```bash
docker compose ps
docker compose logs -f discord-bot librespot oauth-server
```

## Environment Variables

Core:
- DISCORD_TOKEN
- DISCORD_PREFIX
- SPOTIFY_CLIENT_ID
- SPOTIFY_CLIENT_SECRET
- SPOTIFY_REDIRECT_URI
- SPOTIFY_DEVICE_NAME
- SPOTIFY_BITRATE
- SPOTIFY_VOLUME

Controller behavior:
- SPOTIFY_CONTROLLER_MODE
  - requester: each !start uses the user who typed !start
  - shared: all !start calls use SPOTIFY_SHARED_DISCORD_ID
- SPOTIFY_SHARED_DISCORD_ID

Presence:
- DISCORD_ACTIVITY_TEXT
- DISCORD_ACTIVITY_TYPE (PLAYING, LISTENING, WATCHING, STREAMING, COMPETING)

Logging:
- LOG_LEVEL

See defaults in [.env.example](.env.example).

## Command Reference

Playback:
- !start
- !stop
- !np
- !session

Voice:
- !join
- !leave
- !setchannel [#channel]

Audio:
- !volume [0-200]
- !restart

Account:
- !link (alias: !login)
- !unlink
- !jam [link]
  - !jam <link>: save/update guild jam link
  - !jam: return saved guild jam link

Debug:
- !status
- !debug
- !controller
- !tokeninfo
- !devices
- !voice
- !flush
- !restream
- !ping
- !help

## Host Switching Behavior

When a different person runs !start in requester mode:
1. Bot resolves requester as controller
2. Bot calls bridge /set-controller with requester Discord ID
3. Bridge restarts librespot with that account token
4. Bot waits for health/device visibility and transfers playback

Expected side effect:
- First !start after host change can take a few seconds because of account/device rebinding.

## Jam Link Workflow

- New host starts a session:
  - Bot prompts about queue sharing
  - If a jam link is already saved, bot shows the saved link and how to replace it
- !jam <link> saves the link for that guild
- !jam returns the saved link

Jam links are persisted in /data.

## Operational Notes

- Device visibility is account-scoped in Spotify Connect.
- In requester mode, each host should link Spotify first via !link.
- If a user sees Device Not Found right after host switch, retry once after a short delay.

## Troubleshooting

### 1) Device Not Found

Check:
- !devices output for active controller
- SPOTIFY_DEVICE_NAME matches the actual sink name
- librespot health and controller in /health

Commands:

```bash
docker compose logs --tail=200 discord-bot librespot
```

### 2) Forbidden on !start

Usually account/scope restrictions or non-premium account.
- Re-link: !unlink then !start
- Verify app allowlist if Spotify app is in development mode

### 3) First !start fails after !leave

System may still be rebinding account/device.
- Run !start again after 2-5 seconds
- Check !controller and !devices

### 4) No sound in Discord

Check:
- !debug and !voice
- ffmpeg process running
- bot connected to expected voice channel

### 5) OAuth callback issues

Check:
- SPOTIFY_REDIRECT_URI exactly matches Spotify Dashboard redirect URI
- oauth-server reachable through your public URL

## Persistence

Stored in Docker volume bot_config (/data):
- /data/tokens (Spotify OAuth tokens)
- /data/guild_config.json
- /data/jam_links.json
- /data/active_controller_id
- /data/librespot-cache

## Security

- Never commit real secrets from .env.
- Rotate tokens/secrets immediately if exposed:
  - DISCORD_TOKEN
  - SPOTIFY_CLIENT_SECRET

## Useful Commands

```bash
# Rebuild bot only
docker compose up -d --build discord-bot

# Rebuild bridge + bot
docker compose up -d --build librespot discord-bot

# Follow logs
docker compose logs -f discord-bot librespot oauth-server

# Container shell (bot)
docker exec -it spoticord-discord sh

# Container shell (librespot)
docker exec -it spoticord-librespot sh
```

## Project Status

Current setup supports practical multi-guild usage with per-host controller switching in requester mode. If you need true simultaneous independent playback across many servers/users with zero handoff delay, move to one-isolated-librespot-per-active-session architecture.
