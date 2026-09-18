#!/usr/bin/env bash
# DriveLocal — one-shot provisioning for an Oracle Cloud "Always Free" VM.
#
# Run as a normal user on Ubuntu 24.04 (or Oracle Linux 8/9) with sudo access,
# on the free Ampere A1 ("VM.Standard.A1.Flex") shape:
#
#   bash deploy/oracle/setup.sh
#
# What it does:
#   1. Installs Docker Engine + compose plugin (no sudo group dance if already set).
#   2. Opens the OS-level firewall (iptables) for ports 80/443 — Oracle's Ubuntu
#      image blocks them by default even after the VCN security list is opened.
#   3. Clones the repo to /opt/drivelocal (idempotent; updates if present).
#   4. Creates backend/.env from your local .env — the secrets MUST exist already,
#      either as the real backend/.env placed next to this script, or as
#      DRIVELOCAL_ENV_FILE pointing at your local backend/.env.
#   5. Starts `docker compose` with the Caddy HTTPS proxy + backup service.
#
# After it finishes: https://<your-domain> is live.

set -euo pipefail

DOMAIN="${APP_DOMAIN:-}"
REPO_URL="https://github.com/BuhleMahlangu/LocalDrive.git"
REPO_DIR="/opt/drivelocal"

if [[ -z "$DOMAIN" ]]; then
  echo ":: APP_DOMAIN is required (e.g. APP_DOMAIN=drivelocal.duckdns.org bash deploy/oracle/setup.sh)"
  exit 1
fi

echo "==> (1/5) Docker Engine"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo systemctl enable --now docker
sudo docker compose version >/dev/null 2>&1 || sudo apt-get install -y docker-compose-plugin

echo "==> (2/5) Open OS firewall for HTTP/HTTPS"
# Oracle's Ubuntu image ships iptables rules that drop 80/443 even after the VCN
# security list is opened. Insert the ACCEPT rules at the top (before any DROP).
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null ||
    sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
done
# Persist across reboots (install netfilter-persistent if missing).
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true

echo "==> (3/5) Repo at $REPO_DIR"
sudo mkdir -p "$REPO_DIR"
if [[ -d "$REPO_DIR/.git" ]]; then
  sudo git -C "$REPO_DIR" pull --ff-only
else
  sudo git clone "$REPO_URL" "$REPO_DIR"
fi

echo "==> (4/5) backend/.env"
# Precedence: DRIVELOCAL_ENV_FILE > backend/.env next to script > nothing.
ENV_SRC="${DRIVELOCAL_ENV_FILE:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$ENV_SRC" && -f "$SCRIPT_DIR/backend/.env" ]]; then
  ENV_SRC="$SCRIPT_DIR/backend/.env"
fi
if [[ -z "$ENV_SRC" ]]; then
  echo ":: No .env found. Place your real backend/.env next to this script or set"
  echo "   DRIVELOCAL_ENV_FILE=/absolute/path/to/backend/.env"
  exit 1
fi
sudo cp "$ENV_SRC" "$REPO_DIR/backend/.env"
sudo chmod 600 "$REPO_DIR/backend/.env"

echo "==> (5/5) Compose up (app + caddy + backup)"
cd "$REPO_DIR"
sudo APP_DOMAIN="https://$DOMAIN" docker compose --profile proxy up --build -d

echo
echo "Done. Open ports 80/443 in the OCI security list, point $DOMAIN at this"
echo "VM's public IP, and visit:  https://$DOMAIN/health"
echo "Watch logs: sudo docker compose -f $REPO_DIR/docker-compose.yml logs -f app"