# SID Minimap (Fabric, Minecraft 26.2)

A World of Warcraft-style round minimap in the bottom-right corner and a GPS line above the hotbar, with Project SID
citizens, enemies, resources and an ore finder.

## Install
1. Fabric Loader 0.19.5 for 26.2 (official installer: `java -jar fabric-installer-1.1.2.jar client -mcversion 26.2 -loader 0.19.5`).
2. Put `fabric-api-0.161.0+26.2.jar` and `build/libs/sid-minimap-1.1.0.jar` in `.minecraft/mods`.
3. Restart the launcher and play the **fabric-loader-26.2** profile.

## Keys (Options > Controls > Key Binds > SID Minimap)
| Key | Does |
|---|---|
| `M` | show / hide the minimap |
| `=` / `-` | zoom in / out (smooth, 32 to 512 blocks to the rim) |
| `N` | filter: **all** (terrain, citizens, enemies, players) > **resources** (flowers, food, trees by wood, animals) > **ores** (gold, diamond, copper; arrows give how far down to dig) |
| `G` | show / hide the GPS line |

Markers: green = citizens (magenta pulse while they think), red = enemies, white = players, pink = animals,
amber = crops and berries, pink-violet = flowers, tree dots in their wood's colour, gold / cyan / orange = ores.

## Settings: `.minecraft/config/sid-minimap.json`
`mapSize`, `marginRight`/`marginBottom`, `opacity`, `texture` (image resolution), `minRadius`/`maxRadius`/`startRadius`,
`zoomStep`, `zoomSpeed`, `rotate` (false = north up), `showGps`, `gpsOffsetY`, `hideServerGps`, `dashboardUrl`,
`citizenPollMs`, the layer switches (`showCitizens`, `showEnemies`, ...), `oreGold`/`oreDiamond`/`oreCopper`,
`oreScanBelow`, `mode`. Edit while the game is closed (keys save the toggles themselves).

## How it hooks into the game
- `SidMinimapClient` (client entrypoint): keys via `KeyMappingHelper`, terrain via `ClientChunkEvents.CHUNK_LOAD` and
  `ClientTickEvents.END_CLIENT_TICK`, the HUD via `HudElementRegistry.attachElementAfter(VanillaHudElements.HOTBAR, ...)`,
  and `ClientReceiveMessageEvents.ALLOW_GAME` hides the server's own GPS action bar while the mod draws its line.
- `TerrainCache`: samples a few chunks per tick (surface colour like a vanilla map, height shading, water depth, plus
  points of interest; ore sections are skipped by palette unless they can hold ore).
- `MinimapHud`: composes the round, rotating image on a worker thread (`MapMath.compose`), uploads it to one
  `DynamicTexture`, and draws markers, compass letters, the arrow and the GPS line.
- `ZoomController`, `Gps`, `MapMath`, `MinimapConfig`: plain Java, covered by `src/test` (`gradlew test`).

## Build
`JAVA_HOME=<jdk 25> ./gradlew build` -> `build/libs/sid-minimap-1.1.0.jar`.
