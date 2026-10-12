#!/bin/sh
# Copies the backend to a fresh Ubuntu server over SSH and starts it. Idempotent: run it again to deploy a new version.
#   sh deploy/ship.sh <user>@<host> [ssh-key]
# Reads ./deploy/.env (copy .env.example) and ./deploy/.secrets/{promiser,keeper}.json from this machine. Nothing secret
# is baked into the image or committed; the keypairs land in /opt/opening-bell/deploy/.secrets with mode 600.
set -eu
TARGET=${1:?usage: ship.sh <user>@<host> [ssh-key]}
KEY=${2:-}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
[ -f "$HERE/.env" ] || { echo "missing $HERE/.env (copy .env.example and fill it in)" >&2; exit 2; }
for k in promiser keeper; do [ -f "$HERE/.secrets/$k.json" ] || { echo "missing $HERE/.secrets/$k.json" >&2; exit 2; }; done
SSH="ssh -o StrictHostKeyChecking=accept-new ${KEY:+-i $KEY}"
SCP="scp -o StrictHostKeyChecking=accept-new ${KEY:+-i $KEY}"
PACK=$(mktemp)
trap 'rm -f "$PACK"' EXIT
sh "$HERE/pack.sh" "$PACK"

$SCP "$PACK" "$TARGET:/tmp/opening-bell.tar.gz"
$SCP "$HERE/.env" "$TARGET:/tmp/opening-bell.env"
$SCP "$HERE/.secrets/promiser.json" "$TARGET:/tmp/opening-bell.promiser.json"
$SCP "$HERE/.secrets/keeper.json" "$TARGET:/tmp/opening-bell.keeper.json"
$SSH "$TARGET" 'sh -s' <<'REMOTE'
set -eu
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo systemctl enable --now docker
# A 2 GiB host runs Postgres, five Node processes and the image build: give it swap so the build and a busy keeper pass cannot OOM.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
sudo mkdir -p /opt/opening-bell
sudo chown "$(id -u):$(id -g)" /opt/opening-bell
cd /opt/opening-bell
# Replace the code, keep .env and .secrets from the previous run until the new ones are installed below.
find . -mindepth 1 -maxdepth 1 ! -name deploy -exec rm -rf {} +
tar -xzf /tmp/opening-bell.tar.gz -C /opt/opening-bell
mkdir -p deploy/.secrets
install -m 600 /tmp/opening-bell.env deploy/.env
install -m 600 /tmp/opening-bell.promiser.json deploy/.secrets/promiser.json
install -m 600 /tmp/opening-bell.keeper.json deploy/.secrets/keeper.json
rm -f /tmp/opening-bell.env /tmp/opening-bell.promiser.json /tmp/opening-bell.keeper.json /tmp/opening-bell.tar.gz
# The containers run as uid 1000 (the image's `node` user) and must be able to read the keypairs.
sudo chown 1000:1000 deploy/.secrets/promiser.json deploy/.secrets/keeper.json
sudo chmod 600 deploy/.secrets/*.json
cd deploy
sudo docker compose build
sudo docker compose up -d --remove-orphans
sudo docker compose ps
REMOTE
