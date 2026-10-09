> Earlier operational guide retained for reference. Current versions and setup: [README](README.md), [deployment](docs/DEPLOYMENT.md), and [October 9 changes](docs/2026-10-09-UPDATE.md).

# Deploy Now Checklist

Secrets live only in `config/runtime.env` and `config/plugin-config.yml` (both gitignored, generated as a pair).
`BRIDGE_TOKEN` must equal the plugin `token`; `RCON_PASSWORD` must equal `rcon.password` in server.properties.

## 0. On this PC (10.0.0.162)
* Paste the LM Studio API token into `LM_API_TOKEN` in `config/runtime.env`.
* Confirm `REASON_MODEL`/`DIALOG_MODEL` match an ID from `GET /v1/models` (run `scripts/models.mjs` once the token is set).
* Copy to LXC 120: `server-plugin/build/libs/SIDLocal-2.32.0.jar` (the current plugin; installed as `plugins/SIDLocal.jar`), `config/plugin-config.yml`, `scripts/setup-lxc120.sh` → `/tmp/sid/`.
* Copy the whole `sid-local` folder (without `node_modules`) to LXC 119 → `/opt/sid-local`.

## 1. Pterodactyl panel
* Admin → Nodes → Allocations: ensure `10.0.0.58:3001` and `10.0.0.58:25576` exist and are assigned to server `957838a4…`.
* **Stop** the Minecraft server (the server rewrites server.properties on shutdown, so edit it only while stopped).

## 2. LXC 120 – RCON, empty-pause, plugin
```bash
bash /tmp/sid/setup-lxc120.sh
```
Sets `enable-rcon=true`, `rcon.port=25576`, `rcon.password` (hidden prompt; paste `RCON_PASSWORD`), `broadcast-rcon-to-ops=false`,
`pause-when-empty-seconds=0`, backs up server.properties, and installs `plugins/SIDLocal.jar` + `plugins/SIDLocal/config.yml`.
Start the server from the panel, then:
```bash
docker port 957838a4-67e6-4c59-a2fc-94c92e984c2a
docker logs --tail 80 957838a4-67e6-4c59-a2fc-94c92e984c2a | grep -E 'SIDLocal|RCON'
```
Expect `RCON running on 0.0.0.0:25576` and no SIDLocal exceptions.

Force-load the NPC roaming area (persists in the world save). Since 1.21.9 spawn chunks are not kept
loaded, so with no players online Citizens accepts the session but never spawns the NPC. The plugin
config pins spawn at 272.5 69 96.5 with `roam-radius: 48`; this covers that circle plus one chunk:
```
forceload add 208 32 351 175      # 81 chunks, [13,2]..[21,10]; run via RCON or the panel console
```
If you move the spawn or enlarge `roam-radius`, force-load the matching area (max 256 chunks per command).

Then install the port filter:
```bash
install -m 0755 scripts/restrict-bridge-ports.sh /usr/local/sbin/restrict-bridge-ports
install -m 0644 systemd/sid-port-filter.service /etc/systemd/system/sid-port-filter.service
systemctl daemon-reload && systemctl enable --now sid-port-filter.service
```

## 3. LXC 119 – agent runtime
```bash
cd /opt/sid-local
bash scripts/install.sh      # first time only; keeps the existing runtime.env
bash scripts/start.sh        # tests → check → 90 s empty-server soak → start service
```
`start.sh` fails before starting the service if RCON, the WebSocket session, NPC spawn, snapshot continuity,
or world ticking with no players fails. Re-run just the soak with `npm run verify` (service stopped).

## 4. Watch
```bash
journalctl -u sid-local -f
```

## If the bots go offline

A watchdog (`sid-watchdog.timer`, every minute) restarts the agent runtime automatically when it stops
responding or has had no world data for 3 minutes while the game server is reachable. Most outages
fix themselves within about 2 minutes. If they don't, check each layer in order:

1. **Game server (LXC 120)** - is Minecraft running? Pterodactyl panel, or:
   `ssh ct120 'docker ps --filter name=957838a4 --format "{{.Status}}"'`
2. **Plugin** - `ssh ct120 'docker logs --tail 50 957838a4-67e6-4c59-a2fc-94c92e984c2a | grep SIDLocal'`
   should show `SIDLocal listening on /0.0.0.0:3001`. In game, `/sid list` shows the bots it knows.
3. **Agent runtime (LXC 119)** - `ssh ct119 'systemctl status sid-local --no-pager'`, then
   `ssh ct119 'journalctl -u sid-local -n 50 --no-pager -o cat'`. Look for `bridge_offline`,
   `bridge closed by server: <code> <reason>` or `runtime_error`.
   Health at a glance: http://10.0.0.117:8088/api/state (`bridgeReady` true, `snapshotAge` a few seconds).
4. **Restart the runtime** (safe any time; bots keep their positions if it reconnects within 60 s):
   `ssh ct119 'systemctl restart sid-local'`
5. **Model (Bionic/LM Studio on 10.0.0.162)** - if bots are online but never talk or plan, the PC may be
   asleep or LM Studio's server stopped. Reflexes (walking, building, digging, farming, guarding) keep
   running without it; thinking resumes once the model answers again.

Watchdog history: `ssh ct119 'journalctl -t sid-watchdog --no-pager | tail'`.


## Updating a running server (the routine since plugin 2.x)
Runtime (LXC 119):
1. Back up first: `node /opt/sid-local/scripts/backup-state.mjs` (memory.json + SQLite snapshot + logs + config).
2. Copy the changed files to `/opt/sid-local` (same paths), `chmod 644` them, run `npm test` there (prints `# pass N` / `# fail 0`).
3. `systemctl restart sid-local`, then check `journalctl -u sid-local -n 50` for `bridge_ready` and no `ERR_`/`SyntaxError`.
   Never deploy `main.mjs` without every module it imports (a missing module stops the runtime at once).

Plugin (LXC 120):
1. Build: `cd server-plugin && ./gradlew build` -> `build/libs/SIDLocal-<version>.jar` (bump the version in build.gradle and plugin.yml).
2. Check who is online in its own step: `python3 /root/sid-rcon.py list`. If anyone is, warn them 60 s ahead: `python3 /root/sid-rcon.py "say Server restarting in 60 seconds"`.
3. Keep the old jar: `cp plugins/SIDLocal.jar /root/SIDLocal-<old>.jar.bak`; replace **plugins/SIDLocal.jar** with the new build (owner pterodactyl); never add a second jar.
4. Restart through Wings (`POST /api/servers/<uuid>/power {"action":"restart"}`), wait for `SIDLocal v<version>` and `SIDLocal listening` in logs/latest.log,
   then restart the runtime. A new agent or allowed-agents change needs this restart (the list is read at startup).
Rollback: put the .bak jar back as plugins/SIDLocal.jar and restart; restore the runtime files from `/root/sid-pre-*.tgz`.

## Backups and restore (LXC 119)
* `sid-memory-backup.timer` runs `scripts/backup-state.mjs` at 04:35, 10:35, 16:35 and 22:35: one `/root/sid-backups/sid-state-<time>.tgz`
  with memory.json, **settlement_intelligence.db** (VACUUM INTO snapshot of the live WAL database, integrity-checked), conversation logs and config
  (never runtime.env). The newest 28 are kept (7 days). A plain `cp` of the .db file is not a backup: recent writes live in the -wal file.
* Restore: `sh /opt/sid-local/scripts/restore-state.sh /root/sid-backups/sid-state-<time>.tgz` (stops sid-local, keeps the current files as
  *.before-restore-<time>, restores both stores, starts sid-local).
* The world itself is backed up on LXC 120 by `sid-backup.timer` (04:30).
