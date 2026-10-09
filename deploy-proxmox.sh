#!/usr/bin/env bash
set -euo pipefail

# Read-only check of LXC 119 through the Proxmox API.
# Supply credentials from the environment; never hardcode them in this file:
#   PROXMOX_TOKEN_ID='root@pam!Bionic' PROXMOX_TOKEN_SECRET=... bash deploy-proxmox.sh
PROXMOX_HOST="${PROXMOX_HOST:-10.0.0.116:8006}"
PROXMOX_NODE="${PROXMOX_NODE:-localhost}"
: "${PROXMOX_TOKEN_ID:?Set PROXMOX_TOKEN_ID}"
: "${PROXMOX_TOKEN_SECRET:?Set PROXMOX_TOKEN_SECRET}"
AUTH="PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}"

CT_ID=119

echo "Checking LXC ${CT_ID}..."
curl -k -s -H "Authorization: ${AUTH}" "https://${PROXMOX_HOST}/api2/json/nodes/${PROXMOX_NODE}/lxc/${CT_ID}/config"

# The Proxmox API cannot copy files into or run commands in a container.
# Copy sid-local to LXC 119 with scp/sftp, or from the Proxmox host shell with `pct push`.
echo "Done"
