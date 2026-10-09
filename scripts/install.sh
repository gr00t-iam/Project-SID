#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $EUID -ne 0 ]]; then echo 'Run as root in LXC 119'; exit 1; fi
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
if [[ "$(pwd)" != /opt/sid-local ]]; then echo 'Extract this package to /opt/sid-local first'; exit 1; fi
id sid-local >/dev/null 2>&1 || useradd --system --home /var/lib/sid-local --shell /usr/sbin/nologin sid-local
npm ci --omit=dev --ignore-scripts
install -d -o sid-local -g sid-local -m 0750 /var/lib/sid-local
if [[ ! -f config/runtime.env ]]; then
  install -m 0640 -o root -g sid-local config/runtime.env.example config/runtime.env
fi
chown root:sid-local config/runtime.env
chmod 0640 config/runtime.env
install -m 0644 systemd/sid-local.service /etc/systemd/system/sid-local.service
systemctl daemon-reload
echo 'Installed. Configure runtime.env and plugin token, then run npm run check before systemctl enable --now sid-local.'
