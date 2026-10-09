#!/bin/sh
# Restores the agent state from a backup made by scripts/backup-state.mjs.
#   sh scripts/restore-state.sh /root/sid-backups/sid-state-YYYYMMDD-HHMMSS.tgz
# Stops sid-local, keeps the current files as *.before-restore, puts memory.json, the SQLite database (its old -wal and
# -shm files are removed: the backup is a complete database) and the conversation logs back, then starts sid-local.
set -eu
archive=${1:?usage: restore-state.sh <sid-state-*.tgz>}
state=${STATE_DIR:-/var/lib/sid-local}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar xzf "$archive" -C "$tmp"
test -s "$tmp/sid-state/memory.json" && test -s "$tmp/sid-state/settlement_intelligence.db" || { echo "not a sid-state backup: $archive" >&2; exit 1; }
systemctl stop sid-local
stamp=$(date +%Y%m%d-%H%M%S)
for f in memory.json settlement_intelligence.db settlement_intelligence.db-wal settlement_intelligence.db-shm; do
  [ -e "$state/$f" ] && mv "$state/$f" "$state/$f.before-restore-$stamp"
done
install -o sid-local -g sid-local -m 600 "$tmp/sid-state/memory.json" "$state/memory.json"
install -o sid-local -g sid-local -m 600 "$tmp/sid-state/settlement_intelligence.db" "$state/settlement_intelligence.db"
if [ -d "$tmp/sid-state/data" ]; then cp -a "$tmp/sid-state/data/." "$state/data/" && chown -R sid-local:sid-local "$state/data"; fi
systemctl start sid-local
echo "restored $archive (previous files kept as *.before-restore-$stamp)"
