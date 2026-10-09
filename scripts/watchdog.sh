#!/usr/bin/env bash
# Runs every minute (sid-watchdog.timer). Restarts sid-local if the runtime stops answering (a blocked
# event loop) or has had no world snapshot for 3 minutes while the game server is reachable.
set -u
env_file=/opt/sid-local/config/runtime.env
port=$(grep -E '^DASHBOARD_PORT=' "$env_file" | cut -d= -f2-); port=${port:-8088}
key=$(grep -E '^DASHBOARD_TOKEN=' "$env_file" | cut -d= -f2-)
bridge=$(grep -E '^BRIDGE_URL=' "$env_file" | cut -d= -f2- | sed -E 's#^wss?://##; s#/.*$##')
host=${bridge%:*}; bport=${bridge##*:}
restart(){ logger -t sid-watchdog "restarting sid-local: $1"; systemctl restart sid-local.service; exit 0; }
systemctl is-active --quiet sid-local.service || exit 0   # stopped on purpose, or systemd is already restarting it
started=$(date -d "$(systemctl show -p ActiveEnterTimestamp --value sid-local.service)" +%s 2>/dev/null || echo 0)
(( $(date +%s) - started < 180 )) && exit 0               # give a fresh start time to connect
state=$(curl -fsS -m 10 "http://127.0.0.1:${port}/api/state${key:+?key=$key}") || restart "runtime not responding"
age=$(printf '%s' "$state" | sed -nE 's/.*"snapshotAge":([0-9]+).*/\1/p')
if [[ -z "$age" || "$age" -gt 180 ]]; then
  # Only restart if the game side is up; otherwise the runtime is right to be waiting for it.
  if timeout 5 bash -c "</dev/tcp/$host/$bport" 2>/dev/null; then restart "no world data for ${age:-unknown}s while ${host}:${bport} is reachable"; fi
fi
