# Dependencies and plugin inventory

Versions below identify the October 9 deployment/build, rather than a promise that every later upstream version is compatible.

| Component | Version used | Upstream / role |
|---|---|---|
| Node.js | 22+ | Node agent runtime |
| JDK | 25 | Server and client Java builds |
| Paper / Minecraft | 26.2 build 129 | Minecraft server |
| Citizens | 2.0.44-SNAPSHOT build 4255 | NPC engine; [official downloads](https://wiki.citizensnpcs.co/Downloads) |
| SIDLocal | 2.32.0 | This repository's Paper plugin |
| Sentinel | 2.9.4-SNAPSHOT build 534 | NPC combat integration; [upstream](https://github.com/mcmonkeyprojects/Sentinel), [builds](https://ci.citizensnpcs.co/job/Sentinel/) |
| BlueMap | 5.28 server plugin / 2.7.7 API | [Upstream](https://github.com/BlueMap-Minecraft/BlueMap) world map integration |
| Chunky | 1.5.3 | [Upstream](https://github.com/pop4959/Chunky) chunk generation |
| SID Minimap | 1.1.0 | This repository's Fabric client mod |
| Fabric Loader | 0.19.5 | Client mod loader |
| Fabric API | 0.161.0+26.2 | Client mod API |

The Java build files and `package-lock.json` declare the exact library dependencies used for compilation and the Node runtime. The SIDLocal JAR shades Java-WebSocket and Gson. Gradle wrapper files are retained.

The pinned Sentinel JAR is included only because the server build uses it directly as a compile-time dependency. Its MIT license and copyright notice are retained in `third-party-licenses/Sentinel-MIT.txt`; source and downloads remain available upstream. Install the corresponding plugin separately on the Minecraft server when using Sentinel integration. Other third-party server and Fabric plugins are obtained from their upstream projects.

No license has been selected here for first-party Project SID code. Upstream dependencies retain their own licenses.
