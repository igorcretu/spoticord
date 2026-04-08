# Spoticord – Complete Setup Guide

This walks you through every step from a fresh Raspberry Pi to a fully working
Spoticord bot with a public Cloudflare Tunnel for the Spotify OAuth callback.

---

## What you need before starting

| Item | Where to get it |
|------|----------------|
| Raspberry Pi 4 or 5 running Pi OS Bookworm (64-bit) | — |
| Spotify Premium account (host/device account) | spotify.com |
| Cloudflare account (free) | cloudflare.com |
| A domain name added to Cloudflare | Any registrar → point NS to Cloudflare |
| Discord account + server where you're admin | discord.com |

---

## Part 1 – Discord bot

### 1.1 Create the application

1. Go to **https://discord.com/developers/applications**
2. Click **New Application** → name it `Spoticord`
3. Go to the **Bot** tab
4. Click **Add Bot** → confirm
5. Under **Token** click **Reset Token** → copy and save it (this is `DISCORD_TOKEN`)
6. Scroll down to **Privileged Gateway Intents** and enable:
   - **Server Members Intent**
   - **Message Content Intent**
7. Click **Save Changes**

### 1.2 Invite the bot to your server

1. Go to **OAuth2 → URL Generator**
2. Under **Scopes** tick: `bot`, `applications.commands`
3. Under **Bot Permissions** tick:
   - Connect
   - Speak
   - Send Messages
   - Embed Links
   - Attach Files
   - Use Slash Commands
   - Read Message History
4. Copy the generated URL → open it in a browser → select your server → **Authorize**

### 1.3 Get your server and voice channel IDs

1. In Discord: **Settings → Advanced → Enable Developer Mode**
2. Right-click your server icon → **Copy Server ID** → save as `DISCORD_GUILD_ID`
   *(you don't need this in .env any more for the multi-guild version, but useful for reference)*
3. Right-click your voice channel → **Copy Channel ID**
4. In Discord, run `!setchannel #your-voice-channel` after the bot is running

---

## Part 2 – Spotify app (for OAuth)

You need a Spotify Developer app to generate the per-user OAuth login links.
This is separate from the host Spotify account used to register the Pi as a speaker.

### 2.1 Create the app

1. Go to **https://developer.spotify.com/dashboard**
2. Click **Create App**
3. Fill in:
   - **App name:** Spoticord
   - **App description:** Personal Discord music bot
   - **Redirect URI:** `https://spoticord.yourdomain.com/callback`
     *(use your actual domain – you'll create this in Part 3)*
   - **APIs used:** Web API
4. Click **Save**
5. Go to **Settings** on your app → copy:
   - **Client ID** → save as `SPOTIFY_CLIENT_ID`
   - **Client Secret** (click Show) → save as `SPOTIFY_CLIENT_SECRET`

### 2.2 Add the redirect URI

1. In your Spotify app settings → **Redirect URIs**
2. Add: `https://spoticord.yourdomain.com/callback`
   *(must match EXACTLY what you put in .env – same domain, same path, https)*
3. Click **Save**

---

## Part 3 – Cloudflare Tunnel

The Cloudflare Tunnel creates a secure outbound connection from your Pi to
Cloudflare's network. Spotify needs a real public HTTPS URL to redirect to
after a user logs in – the tunnel provides this without opening any ports
on your router.

### 3.1 Add your domain to Cloudflare

If your domain is already on Cloudflare, skip to 3.2.

1. Go to **https://dash.cloudflare.com**
2. Click **Add a Site** → enter your domain → choose the **Free** plan
3. Cloudflare will scan your DNS → click **Continue**
4. Copy the two Cloudflare nameservers shown
5. Go to your domain registrar → replace nameservers with the Cloudflare ones
6. Wait up to 24 hours for DNS propagation (usually under 1 hour)

### 3.2 Install cloudflared on the Pi

The install script already does this. Verify it worked:

```bash
cloudflared --version
```

### 3.3 Authenticate cloudflared

Run this on the Pi (it opens a browser window – do it via a desktop session
or copy the URL to another device):

```bash
cloudflared tunnel login
```

This saves a certificate to `~/.cloudflared/cert.pem`. It only needs to be done once.

### 3.4 Create the tunnel

```bash
cloudflared tunnel create spoticord
```

This outputs something like:

```
Created tunnel spoticord with id a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

Copy that UUID – it's your `TUNNEL_ID`.

A credentials file is saved at:
```
~/.cloudflared/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json
```

### 3.5 Configure the tunnel

Edit `cloudflared/config.yml` in the Spoticord directory:

```bash
nano ~/spoticord/cloudflared/config.yml
```

Replace the placeholders:

```yaml
tunnel: a1b2c3d4-e5f6-7890-abcd-ef1234567890
credentials-file: /home/igor/.cloudflared/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json

ingress:
  - hostname: spoticord.yourdomain.com
    service: http://localhost:8888

  - service: http_status:404
```

Replace:
- `a1b2c3d4-...` with your actual tunnel ID (both places)
- `igor` with your Pi username (`whoami` to check)
- `spoticord.yourdomain.com` with your actual subdomain

### 3.6 Create the DNS record in Cloudflare

```bash
cloudflared tunnel route dns spoticord spoticord.yourdomain.com
```

This creates a CNAME in your Cloudflare DNS automatically:
```
spoticord.yourdomain.com → a1b2c3d4-....cfargotunnel.com
```

Verify it in the Cloudflare dashboard under **DNS → Records**.

### 3.7 Test the tunnel manually

```bash
cloudflared tunnel --config ~/spoticord/cloudflared/config.yml run
```

You should see:
```
INF Connection established connIndex=0 ...
INF Connection established connIndex=1 ...
```

Open `https://spoticord.yourdomain.com/health` in your browser.
You should get: `{"status": "ok"}`

Press Ctrl+C to stop – it will be managed by systemd from now on.

---

## Part 4 – Configure Spoticord

```bash
cd ~/spoticord
cp .env.example .env
nano .env
```

Fill in every value:

```dotenv
# Spotify host account (registers the Pi as a speaker)
SPOTIFY_USERNAME=your_host_spotify@email.com
SPOTIFY_PASSWORD=your_host_password

SPOTIFY_DEVICE_NAME=SpoticordPi
SPOTIFY_BITRATE=320
SPOTIFY_VOLUME=80

# Spotify OAuth app (from developer.spotify.com/dashboard)
SPOTIFY_CLIENT_ID=abc123...
SPOTIFY_CLIENT_SECRET=def456...
SPOTIFY_REDIRECT_URI=https://spoticord.yourdomain.com/callback

# Discord bot token
DISCORD_TOKEN=your_discord_bot_token
DISCORD_PREFIX=!

LOG_LEVEL=INFO
```

---

## Part 5 – Start everything

### 5.1 Build and start all containers

```bash
cd ~/spoticord
docker compose up -d --build
```

First build takes 5-15 minutes (compiling Rust librespot). Subsequent starts
are instant.

Watch the logs:
```bash
docker compose logs -f
```

All three containers should show healthy output:
- `spoticord-librespot` – "Starting librespot: SpoticordPi"
- `spoticord-oauth`     – "Listening at: http://0.0.0.0:8888"
- `spoticord-discord`   – "Logged in as Spoticord#1234"

### 5.2 Start the Cloudflare tunnel

```bash
sudo systemctl start spoticord-tunnel
sudo systemctl status spoticord-tunnel
```

Check it's connected:
```bash
journalctl -u spoticord-tunnel -f
```

### 5.3 Enable auto-start on boot

```bash
sudo systemctl enable spoticord spoticord-tunnel
```

Both will now start automatically when the Pi boots.

---

## Part 6 – First use

### 6.1 Configure the voice channel

In your Discord server, run:
```
!setchannel #your-voice-channel-name
```

The bot will connect to that channel within a few seconds.

### 6.2 Start a session (you – the first time)

```
!start
```

First time:
1. Bot sends you a DM with a Spotify login link
2. Click the link → log in with your personal Spotify account
3. Spotify redirects to `https://spoticord.yourdomain.com/callback`
4. You see a green "You're connected!" page
5. Go back to Discord and run `!start` again

Second time onwards:
- `!start` immediately transfers the Pi to your account and posts the Jam QR

### 6.3 Invite friends to the Jam

- Bot posts an embed with a **QR code** and a **"Open in Spotify"** link
- Friends scan the QR on their phones → they're in the Jam
- They can freely add songs from their own Spotify libraries
- Everything plays through the Discord voice channel

### 6.4 End the session

```
!stop
```

The Pi goes back to idle. The next person can run `!start` to take ownership.

---

## Command reference

| Command | Who | What |
|---------|-----|-------|
| `!start` | Anyone | Link Spotify + take ownership + post Jam QR |
| `!stop` | Host or Moderator | End session, release speaker |
| `!session` | Anyone | Show current host + Jam QR |
| `!jam <url>` | Host | Manually post a Jam link + QR |
| `!unlink` | Anyone | Remove your stored Spotify token |
| `!volume [0-200]` | Anyone | Get / set volume |
| `!status` | Anyone | Service health panel |
| `!join` | Anyone | Force reconnect to voice |
| `!leave` | Anyone | Disconnect from voice |
| `!setchannel #ch` | Manage Server | Set voice channel for this server |
| `!restart` | Manage Server | Restart librespot |
| `!ping` | Anyone | Latency check |

---

## Troubleshooting

### Bot doesn't appear in Spotify device list

1. Check librespot is running: `docker compose logs librespot`
2. Open any Spotify app first (this wakes up Connect discovery)
3. Wait 15 seconds and check again
4. Verify `SPOTIFY_USERNAME` and `SPOTIFY_PASSWORD` in `.env` are correct
5. Make sure your host Spotify account is **Premium**

### OAuth callback fails / "Invalid redirect URI"

- The URI in `.env` must match **exactly** what's in the Spotify Developer dashboard
- Must be `https://` (not `http://`) – Cloudflare handles SSL termination
- Must include `/callback` at the end

### Tunnel not connecting

```bash
# Check tunnel status
cloudflared tunnel info spoticord

# Check credentials file exists
ls ~/.cloudflared/

# Check config.yml paths are correct
cat ~/spoticord/cloudflared/config.yml

# Test manually
cloudflared tunnel --config ~/spoticord/cloudflared/config.yml run
```

### No audio in Discord

1. Check `!status` – is the pipe showing ✅ Ready?
2. Make sure you've run `!setchannel` in your server
3. Someone needs to be playing music via Spotify → select SpoticordPi as device
4. Try `!restart` to reset librespot

### "Transfer playback failed" on !start

- Your Spotify account must be **Premium** to use Connect transfer
- Open Spotify on any device first so the Pi device is awake
- Try pressing play on the Pi device manually in Spotify, then run `!start` again

### Jam link not generated

This uses an undocumented Spotify API endpoint that may occasionally fail.
Use the fallback:
1. Play music on the Pi in Spotify
2. Tap **Now Playing → ··· → Start a Jam**
3. Share the invite link
4. In Discord: `!jam https://open.spotify.com/jam/...`

The bot will render it as a QR code.

---

## Updating

```bash
cd ~/spoticord
git pull
docker compose up -d --build
```

---

## Directory layout

```
spoticord/
├── docker-compose.yml
├── .env.example
├── .env                        ← your secrets (gitignored)
├── install.sh
├── cloudflared/
│   └── config.yml              ← tunnel config
├── librespot-bridge/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   ├── api.py
│   └── requirements.txt
├── oauth-server/
│   ├── Dockerfile
│   ├── app.py                  ← handles /callback
│   └── requirements.txt
└── discord-bot/
    ├── Dockerfile
    ├── requirements.txt
    └── bot/
        ├── __main__.py
        ├── session.py           ← ownership + Jam logic
        ├── config.py            ← per-guild channel config
        └── cogs/
            ├── audio.py         ← pipe → FFmpeg → Discord voice
            ├── session_cmd.py   ← !start !stop !session !jam !unlink
            ├── controls.py      ← !volume !status !setchannel etc.
            └── help.py
```
