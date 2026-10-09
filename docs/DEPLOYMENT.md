# Build and deployment

The current server artifact is **SIDLocal-2.32.0.jar**; the optional client artifact is **sid-minimap-1.1.0.jar**. The older operational guides contain environment-specific history and should be read alongside this page.

## Build

1. Install Node.js 22+ and JDK 25. Set `JAVA_HOME` to your JDK 25 directory.
2. Run `npm ci` and `npm test` from the repository root.
3. Run `./gradlew build` in `server-plugin` (Windows: `gradlew.bat build`). Output: `server-plugin/build/libs/SIDLocal-2.32.0.jar`.
4. For the optional Fabric minimap, run the Gradle build in `client-mod`. Output: `client-mod/build/libs/sid-minimap-1.1.0.jar`.

The server build uses a pinned Sentinel compile-time JAR under `server-plugin/libs`, with its upstream MIT notice in `third-party-licenses`. Other Java dependencies resolve through the repositories declared in the Gradle files. A fresh build needs network access; offline builds require previously cached dependencies.

## Paper server

Use a compatible Minecraft 26.2 Paper server with JDK 25. Install Citizens, and install the matching optional integrations used by your settlement: Sentinel, BlueMap, and Chunky. Shut the server down through its server manager, wait for the actual process to exit, then install SIDLocal as `plugins/SIDLocal.jar`. Restart and confirm the plugin version and Paper's `Done` message.

Create `plugins/SIDLocal/config.yml` from the shipped defaults or a reviewed settlement preset. Set a fresh random bridge token and the intended world, agent allowlist, spawn, build permissions, and block materials. Do not overwrite an existing world configuration or inventories with the template.

The existing settlement preset includes bank/vault bounds, jail cells, citizen names and roles, building materials, warehouse/shop chest registrations, and movement policies. These positions belong to the original settlement.

## Node runtime

Copy `config/runtime.env.example` to `config/runtime.env`. Configure at least `BRIDGE_URL`, `BRIDGE_TOKEN`, the language model endpoint/model settings, `STATE_DIR`, `DASHBOARD_TOKEN`, and `DASHBOARD_PLAYER`. Set `PLAYER_NAMES` as `uuid=name` mappings if needed. Bridge tokens must match the plugin configuration.

For a new installation, `scripts/configure.sh` generates paired bridge credentials interactively. It uses the plugin's generic defaults, so review the agent list and configuration afterward. Existing installations should retain their credentials and update settings deliberately.

Run `npm start`. On Linux, the supplied `systemd/sid-local.service` and installation scripts describe the service layout. Confirm the bridge connects and the dashboard loads at `http://<node-host>:8088/?key=<dashboard-token>`.

The dashboard funding endpoint requires the access key even when ordinary dashboard access is trusted on the LAN, except for local loopback administration. Set `DASHBOARD_TRUSTED_NETS=none` when all dashboard access should require the key. Keep bridge and RCON ports restricted to the intended hosts; they are administrative interfaces.

## Existing deployment

The original Node service runs in LXC 119 and Minecraft runs in LXC 120 under Pterodactyl. Source and helper scripts retain historical installation paths and example LAN addresses. Adapt those values for your environment. Never replace the live world, `memory.json`, database, plugin inventory files, or server credentials with repository examples.

Back up both the Minecraft world/plugin data and the Node state directory before upgrades. The backup and restore scripts under `scripts/` are available for review. Preserve SQLite data as well as JSON state.
