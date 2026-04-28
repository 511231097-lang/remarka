#!/usr/bin/env bash
# setup-vps.sh — idempotent bootstrap for a fresh Ubuntu 24.04 VPS.
#
# Usage:
#   sudo ./setup-vps.sh web
#   sudo ./setup-vps.sh worker
#
# Sets up Node 22, system user, directory layout, firewall, systemd units.
# Re-runnable: each step checks current state before changing anything.

set -euo pipefail

ROLE="${1:-}"
if [[ "$ROLE" != "web" && "$ROLE" != "worker" ]]; then
  echo "ERROR: role argument required ('web' or 'worker')." >&2
  echo "Usage: sudo $0 web|worker" >&2
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: must be run as root (use sudo)." >&2
  exit 1
fi

APP_USER="remarka"
APP_HOME="/srv/remarka"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
log "1/8 Updating apt and installing base packages"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  lsb-release \
  postgresql-client-16 \
  rsync \
  ufw \
  unzip

# ---------------------------------------------------------------------------
log "2/8 Installing Node.js 22.x LTS (NodeSource)"
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "Node $(node -v) already installed."
fi

# ---------------------------------------------------------------------------
log "3/8 Installing role-specific packages"
# ---------------------------------------------------------------------------
if [[ "$ROLE" == "web" ]]; then
  apt-get install -y --no-install-recommends \
    nginx \
    certbot \
    python3-certbot-nginx
fi

# ---------------------------------------------------------------------------
log "4/8 Creating system user '$APP_USER'"
# ---------------------------------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
  echo "User '$APP_USER' created (home: $APP_HOME)."
else
  echo "User '$APP_USER' already exists."
fi

# ---------------------------------------------------------------------------
log "5/8 Setting up directory layout under $APP_HOME"
# ---------------------------------------------------------------------------
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_HOME"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_HOME/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_HOME/logs"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_HOME/shared"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_HOME/shared/env"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_HOME/shared/secrets"

ENV_FILE="$APP_HOME/shared/env/${ROLE}.env"
if [[ ! -e "$ENV_FILE" ]]; then
  install -o "$APP_USER" -g "$APP_USER" -m 600 /dev/null "$ENV_FILE"
  cat >"$ENV_FILE" <<'EOF'
# Fill in real values. See repo: scripts/deploy/.env.production.example
# This file is loaded by systemd via EnvironmentFile=
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created empty env file at $ENV_FILE (chmod 600)."
else
  echo "Env file $ENV_FILE already exists; leaving as-is."
fi

# ---------------------------------------------------------------------------
log "6/8 Configuring UFW firewall"
# ---------------------------------------------------------------------------
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'

if [[ "$ROLE" == "web" ]]; then
  ufw allow 80/tcp  comment 'HTTP (certbot + redirect)'
  ufw allow 443/tcp comment 'HTTPS'
fi

ufw --force enable
ufw status verbose || true

# ---------------------------------------------------------------------------
log "7/8 Installing systemd unit"
# ---------------------------------------------------------------------------
UNIT_SRC="$SCRIPT_DIR/${ROLE}.service"
UNIT_DST="/etc/systemd/system/remarka-${ROLE}.service"

if [[ ! -f "$UNIT_SRC" ]]; then
  echo "ERROR: $UNIT_SRC not found. Run from repo root (scripts/deploy/)." >&2
  exit 1
fi

install -m 644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable "remarka-${ROLE}.service" || true
echo "systemd unit installed at $UNIT_DST (enabled, not started yet)."

# ---------------------------------------------------------------------------
log "8/8 Done"
# ---------------------------------------------------------------------------
cat <<EOF

Bootstrap complete for role: $ROLE.

Next steps:
  1. Edit env file:        sudo -u $APP_USER \$EDITOR $ENV_FILE
  2. Drop secrets if any:  /srv/remarka/shared/secrets/   (chmod 600, owner $APP_USER)
  3. First deploy via CI:  push to deploy branch, or run rsync manually.
  4. Start service:        sudo systemctl start remarka-${ROLE}
  5. Watch logs:           sudo journalctl -u remarka-${ROLE} -f
EOF

if [[ "$ROLE" == "web" ]]; then
  cat <<EOF

  Web role only:
  6. Configure nginx: copy scripts/deploy/nginx.conf.template, replace __DOMAIN__, link into sites-enabled, run certbot.
EOF
fi
