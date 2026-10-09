#!/usr/bin/env bash
set -euo pipefail
# Run as root in LXC 119 after install.sh and after the Minecraft server is back up.
# Order: unit tests -> connectivity/LM check -> empty-server soak -> start the service.
cd "$(dirname "$0")/.."
if [[ $EUID -ne 0 ]]; then echo 'Run as root in LXC 119'; exit 1; fi
if grep -Eq '^(BRIDGE_TOKEN=REPLACE|RCON_PASSWORD=$)' config/runtime.env; then
  echo 'config/runtime.env still has a placeholder BRIDGE_TOKEN or empty RCON_PASSWORD'; exit 1
fi
# check/verify create their own scout session; the service must not own it concurrently.
systemctl stop sid-local.service 2>/dev/null || true
npm test
runuser -u sid-local -- node --env-file=config/runtime.env scripts/check.mjs
runuser -u sid-local -- node --env-file=config/runtime.env scripts/verify-spawn.mjs scout
# The verify session's NPC is reclaimed by the service within the plugin's 60 s grace period.
systemctl enable --now sid-local.service
for _ in $(seq 1 30); do
  if journalctl -u sid-local.service --since '-2 minutes' --no-pager -o cat | grep -q '"type":"bridge_ready"'; then
    echo 'sid-local is running and the bridge is ready.'
    journalctl -u sid-local.service --since '-2 minutes' --no-pager -o cat | tail -n 5
    exit 0
  fi
  sleep 2
done
echo 'Service started but bridge_ready was not logged within 60 s:'
journalctl -u sid-local.service --since '-2 minutes' --no-pager -o cat | tail -n 30
exit 1
