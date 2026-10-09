#!/usr/bin/env bash
set -euo pipefail
# Run as root inside LXC 120 with the Minecraft server STOPPED through the Pterodactyl panel.
# Copy these next to this script first (e.g. into /tmp/sid):
#   SIDLocal-<version>.jar  (from server-plugin/build/libs or GitHub Releases, now SIDLocal-2.32.0.jar; installed as plugins/SIDLocal.jar)
#   plugin-config.yml       (from config/, generated together with runtime.env)
# Edits only the listed server.properties keys; every other setting is preserved.
# The RCON password is read hidden from the prompt; paste RCON_PASSWORD from runtime.env.
server_uuid=957838a4-67e6-4c59-a2fc-94c92e984c2a
server_dir=/var/lib/pterodactyl/volumes/$server_uuid
props=$server_dir/server.properties
here=$(cd "$(dirname "$0")" && pwd)
jar=${JAR:-$(ls -1 "$here"/SIDLocal-[0-9]*.jar 2>/dev/null | sort -V | tail -n 1)}
plugin_config=${PLUGIN_CONFIG:-$here/plugin-config.yml}

if [[ $EUID -ne 0 ]]; then echo 'Run as root in LXC 120'; exit 1; fi
[[ -f $props ]] || { echo "Missing $props"; exit 1; }
[[ -f $jar ]] || { echo "Missing $jar"; exit 1; }
[[ -f $plugin_config ]] || { echo "Missing $plugin_config"; exit 1; }
if grep -q REPLACE_WITH "$plugin_config"; then echo 'plugin-config.yml still has a placeholder token'; exit 1; fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$server_uuid" 2>/dev/null)" == true ]]; then
  echo 'Stop this Minecraft server through the Pterodactyl panel first (server.properties is rewritten on shutdown).'
  exit 1
fi

printf 'RCON password (hidden): '
IFS= read -rs rcon_password
printf '\n'
if [[ ! $rcon_password =~ ^[A-Za-z0-9]{32,}$ ]]; then echo 'Expected at least 32 alphanumeric characters'; exit 1; fi

owner=$(stat -c %u:%g "$props")
backup=$props.bak-$(date +%Y%m%d%H%M%S)
cp -p "$props" "$backup"

set_prop() {
  local key=$1 value=$2
  if grep -q "^${key//./\\.}=" "$props"; then
    # awk avoids sed escaping problems with arbitrary values.
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$props" > "$props.tmp"
    cat "$props.tmp" > "$props" && rm -f "$props.tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$props"
  fi
}
set_prop enable-rcon true
set_prop rcon.port 25576
set_prop rcon.password "$rcon_password"
set_prop broadcast-rcon-to-ops false
# Citizens NPCs are not players. With the default (60) the server stops ticking once the last
# real player leaves, which halts SIDLocal acks/snapshots and makes the agent drop and reconnect.
set_prop pause-when-empty-seconds 0
unset rcon_password
chown "$owner" "$props"

install -d -o "${owner%:*}" -g "${owner#*:}" -m 0750 "$server_dir/plugins/SIDLocal"
install -o "${owner%:*}" -g "${owner#*:}" -m 0644 "$jar" "$server_dir/plugins/SIDLocal.jar"
install -o "${owner%:*}" -g "${owner#*:}" -m 0640 "$plugin_config" "$server_dir/plugins/SIDLocal/config.yml"

echo "Backup: $backup"
grep -E '^(enable-rcon|rcon\.port|broadcast-rcon-to-ops|pause-when-empty-seconds)=' "$props"
echo 'rcon.password=<set>'
echo 'Next: confirm allocations 10.0.0.58:3001 and 10.0.0.58:25576 are assigned to this server, then start it from the panel.'
echo "Then check: docker port $server_uuid && docker logs --tail 80 $server_uuid | grep -E 'SIDLocal|RCON'"
