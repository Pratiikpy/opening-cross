#!/bin/sh
# Creates the one Azure VM for the backend: Ubuntu 24.04, Standard_B2s (2 vCPU, 4 GiB), static public IP, SSH by key only,
# ports 22, 80 and 443 open. Prints the user@host to pass to ship.sh and the sslip.io hostname for SITE_HOST.
#   sh deploy/provision-azure.sh [region] [size]
# Needs `az login` on a subscription that can create resources. The default region is centralindia; the Azure for
# Students policy only allows centralindia, malaysiawest, eastasia, austriaeast and uaenorth.
set -eu
REGION=${1:-centralindia}
SIZE=${2:-Standard_B2s}
RG=${RG:-opening-bell-rg}
VM=${VM:-opening-bell-vm}
KEY=${SSH_PUBLIC_KEY:-$HOME/.ssh/opening_bell_azure.pub}
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N "" -f "${KEY%.pub}" -C opening-bell-azure -q
az group create -n "$RG" -l "$REGION" -o none
az vm create -g "$RG" -n "$VM" -l "$REGION" --size "$SIZE" \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --admin-username obell --authentication-type ssh --ssh-key-values "$KEY" \
  --public-ip-sku Standard --public-ip-address-allocation static \
  --os-disk-size-gb 64 --storage-sku StandardSSD_LRS \
  --nsg-rule SSH -o none
az vm open-port -g "$RG" -n "$VM" --port 80 --priority 900 -o none
az vm open-port -g "$RG" -n "$VM" --port 443 --priority 901 -o none
IP=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
echo "server  obell@$IP"
echo "SITE_HOST=$(echo "$IP" | tr . -).sslip.io"
