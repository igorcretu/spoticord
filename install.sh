#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Spoticord install script – run as a normal user, not root
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

GREEN="\033[0;32m"; YELLOW="\033[1;33m"; RED="\033[0;31m"; NC="\033[0m"
log()  { echo -e "${GREEN}[spoticord]${NC} $*"; }
warn() { echo -e "${YELLOW}[warning]${NC}  $*"; }
fail() { echo -e "${RED}[error]${NC}    $*"; exit 1; }

[[ "$EUID" == "0" ]] && fail "Run as your normal user, not root."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "System: $(lsb_release -ds 2>/dev/null || uname -a)"
log "Arch:   $(uname -m)"

# ── Packages ──────────────────────────────────────────────────────────────────
log "Installing system packages…"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
    curl git ca-certificates gnupg lsb-release alsa-utils

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    log "Installing Docker…"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    warn "Added $USER to docker group. Log out and back in before using docker."
else
    log "Docker: $(docker --version)"
fi

# ── Docker Compose plugin ─────────────────────────────────────────────────────
if ! docker compose version &>/dev/null 2>&1; then
    log "Installing Docker Compose plugin…"
    DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
    mkdir -p "$DOCKER_CONFIG/cli-plugins"
    curl -fsSL \
        "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
        -o "$DOCKER_CONFIG/cli-plugins/docker-compose"
    chmod +x "$DOCKER_CONFIG/cli-plugins/docker-compose"
else
    log "Docker Compose: $(docker compose version --short)"
fi

# ── Cloudflare Tunnel (cloudflared) ───────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
    log "Installing cloudflared…"
    ARCH=$(uname -m)
    case "$ARCH" in
        aarch64|arm64) CF_ARCH="arm64" ;;
        armv7l)        CF_ARCH="arm"   ;;
        x86_64)        CF_ARCH="amd64" ;;
        *)             fail "Unknown arch: $ARCH" ;;
    esac
    curl -fsSL \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
        -o /tmp/cloudflared
    sudo install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared
    log "cloudflared installed: $(cloudflared --version)"
else
    log "cloudflared: $(cloudflared --version)"
fi

# ── ALSA dummy ────────────────────────────────────────────────────────────────
log "Configuring ALSA dummy device…"
grep -q "snd-dummy" /etc/modules 2>/dev/null || echo "snd-dummy" | sudo tee -a /etc/modules
sudo modprobe snd-dummy 2>/dev/null || warn "snd-dummy unavailable – pipe backend will be used"

# ── .env ──────────────────────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    log ".env created from template"
    echo ""
    warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    warn " Fill in your credentials:  nano $SCRIPT_DIR/.env"
    warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
fi

# ── Systemd: spoticord (docker compose) ───────────────────────────────────────
sudo tee /etc/systemd/system/spoticord.service > /dev/null <<EOF
[Unit]
Description=Spoticord – Spotify Connect Discord Bridge
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300
User=${USER}
Group=docker

[Install]
WantedBy=multi-user.target
EOF

# ── Systemd: cloudflared tunnel ───────────────────────────────────────────────
sudo tee /etc/systemd/system/spoticord-tunnel.service > /dev/null <<EOF
[Unit]
Description=Spoticord Cloudflare Tunnel
After=network-online.target spoticord.service
Wants=network-online.target

[Service]
Type=simple
User=${USER}
ExecStart=/usr/local/bin/cloudflared tunnel --config ${SCRIPT_DIR}/cloudflared/config.yml run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable spoticord.service spoticord-tunnel.service

mkdir -p "$SCRIPT_DIR/cloudflared"

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log " Installation complete!"
log ""
log " Next steps:"
log "   1.  Edit .env              → nano $SCRIPT_DIR/.env"
log "   2.  Set up Cloudflare      → follow CLOUDFLARE_SETUP.md"
log "   3.  Start everything       → docker compose up -d --build"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
