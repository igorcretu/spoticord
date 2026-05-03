# Spoticord Setup Guide

This guide installs and configures Spoticord from scratch on a Raspberry Pi with Cloudflare Tunnel for Spotify OAuth callback.

## Prerequisites

- Raspberry Pi 4 or 5 with Raspberry Pi OS Bookworm 64-bit
- Docker and Docker Compose installed
- Spotify Premium account
- Discord server admin access
- Cloudflare account with domain

## Part 1: Create Discord App and Bot

1. Open <https://discord.com/developers/applications>.
2. Create new application named Spoticord.
3. Open Bot tab and add bot.
4. Generate bot token and save as DISCORD_TOKEN.
5. Enable intents:
   - Server Members Intent
   - Message Content Intent
6. Save changes.

Invite bot:

1. OAuth2 -> URL Generator.
2. Select scopes:
   - bot
   - applications.commands
3. Select permissions:
   - Connect
   - Speak
   - Send Messages
   - Embed Links
   - Read Message History
   - Use Slash Commands
4. Open generated URL and authorize bot to server.

## Part 2: Create Spotify Developer App

1. Open <https://developer.spotify.com/dashboard>.
2. Create app.
3. Set Redirect URI to your public callback:

- <https://spoticord.yourdomain.com/callback>

1. Save and copy:

- SPOTIFY_CLIENT_ID
- SPOTIFY_CLIENT_SECRET

1. Confirm the same redirect URI exists in app settings.

## Part 3: Configure Cloudflare Tunnel

Install and login:

```bash
cloudflared --version
cloudflared tunnel login
```

Create tunnel:

```bash
cloudflared tunnel create spoticord
```

Edit cloudflared config in project:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /home/YOUR_USER/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: spoticord.yourdomain.com
    service: http://localhost:8888
  - service: http_status:404
```

Create DNS route:

```bash
cloudflared tunnel route dns spoticord spoticord.yourdomain.com
```

Test tunnel:

```bash
cloudflared tunnel --config ~/spoticord/cloudflared/config.yml run
```

Then open:

- <https://spoticord.yourdomain.com/health>

## Part 4: Configure Environment

```bash
cd ~/spoticord
cp .env.example .env
nano .env
```

Required core values:

- DISCORD_TOKEN
- SPOTIFY_CLIENT_ID
- SPOTIFY_CLIENT_SECRET
- SPOTIFY_REDIRECT_URI
- SPOTIFY_DEVICE_NAME

Recommended behavior and reliability values:

- AUTO_JOIN_WITHOUT_SESSION=false
- HOST_LEAVE_GRACE_MS=15000
- MAX_RESTARTS_PER_MIN=10
- BOT_HEALTH_PORT=7070
- RESTART_STATE_FILE=/data/restart_state.json

Optional command policy values:

- MOD_ROLE_IDS=comma,separated,roleids
- ADMIN_ROLE_IDS=comma,separated,roleids

Set LOG_LEVEL=INFO for production.

## Part 5: Start Services

```bash
cd ~/spoticord
docker compose up -d --build
```

Check status:

```bash
docker compose ps
```

Follow logs:

```bash
docker compose logs -f discord-bot librespot oauth-server weather
```

## Part 6: First Run in Discord

1. Join voice channel.
2. Run `!setchannel #your-voice-channel`, then run `!start`.

3. Complete Spotify OAuth from DM link.
4. Run !start again after linking.

## Daily Commands

- !start / !stop
- !np / !session
- !queue / !dequeue [index]
- !volume [0-200]
- !status / !debug / !diagnostics
- !transferhost @user
- !join / !leave

Slash equivalents exist for core operations.

## Health and Metrics Checks

Bot endpoints inside container:

```bash
docker compose exec -T discord-bot node -e "fetch('http://localhost:7070/health').then(r=>r.text()).then(console.log)"
docker compose exec -T discord-bot node -e "fetch('http://localhost:7070/metrics').then(r=>r.text()).then(console.log)"
```

## Behavior Notes

- Bot leaves when channel becomes empty of human users.
- Bot leaves when host leaves and grace timer expires.
- Host channel switch is followed during grace window.
- Bridge stop keeps Spotify sink off until restart/start command.

## Troubleshooting

Device not found:

1. Check librespot logs.
2. Confirm SPOTIFY_DEVICE_NAME.
3. Use !devices.

No audio:

1. Check !status and !debug.
2. Verify bot in target voice channel.
3. Run !restream or !restart.

OAuth redirect mismatch:

1. Ensure SPOTIFY_REDIRECT_URI exactly equals Spotify app redirect.
2. Confirm tunnel DNS and callback path.

Command denied:

1. Set MOD_ROLE_IDS and ADMIN_ROLE_IDS in .env.
2. Ensure your Discord roles match those IDs.

## Updating

```bash
cd ~/spoticord
git pull
docker compose up -d --build
```

## Security Checklist

- Rotate secrets if ever exposed:
  - DISCORD_TOKEN
  - SPOTIFY_CLIENT_SECRET
  - WEATHER_WEBHOOK_URL
- Keep .env out of version control.
- Prefer LOG_LEVEL=INFO unless debugging.
