# Project SID

Project SID runs an autonomous Minecraft settlement: Citizens NPCs work, trade, build, talk, and maintain a shared town. A Node.js agent runtime connects local language models to a Paper server through the SIDLocal plugin. The settlement dashboard provides conversations, daily milestones, building progress, warehouse inventory, court records, and banking.

This repository contains the current source assembled on **October 9, 2026**, including the deployed **SIDLocal 2.32.0** server plugin and **SID Minimap 1.1.0** Fabric client mod.

## Start here

- [Build and deploy](docs/DEPLOYMENT.md)
- [Architecture and source map](docs/ARCHITECTURE.md)
- [October 9 features and verification](docs/2026-10-09-UPDATE.md)
- [Server dependencies and licenses](docs/DEPENDENCIES.md)
- [Earlier full operational guide](FULL-GUIDE.md)
- [Earlier audit](audit/2026-10-02/AUDIT.md)

## Build and test

Requirements: Node.js 22 or newer and JDK 25. Gradle wrappers are included.

```sh
npm ci
npm test
cd server-plugin
./gradlew build
cd ../client-mod
./gradlew build
```

On Windows, use `gradlew.bat`. The server build includes standalone doorway and terrain policy checks. The client build includes minimap tests.

First-party JARs are available in [GitHub Releases](https://github.com/gr00t-iam/Project-SID/releases). Paper, Citizens, BlueMap, Chunky, and Fabric dependencies have their own upstream downloads; see the dependency guide.

## Configure

Copy `config/runtime.env.example` to `config/runtime.env` and set your hosts, bridge token, language model credentials, model IDs, and dashboard access key. Copy the server plugin defaults to the installed plugin configuration and use the same bridge token on both sides. `config/plugin-config.example.yml` is a sanitized preset of the existing settlement; its world coordinates require review for another world.

Actual credentials, player accounts, conversations, Minecraft world saves, and live runtime databases are excluded. Build outputs and downloaded caches are generated locally. Historical prototypes and one-time maintenance scripts are retained under `archive/`; they are not the active application.
