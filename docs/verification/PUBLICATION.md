# Publication verification — October 9, 2026

This verification was run from the assembled public repository before the initial GitHub publication.

- `npm ci --ignore-scripts`: dependencies installed from the lockfile. npm reported two moderate dependency advisories; dependency upgrades were not part of publication.
- `npm test`: **283 tests passed, zero failures**.
- `server-plugin/gradlew.bat build --offline`: successful on JDK 25. DoorTiming: **11 checks passed**. TerrainPlacement: **8 checks passed**. Existing Bukkit/Citizens deprecation warnings remain.
- `client-mod/gradlew.bat build --offline`: successful on JDK 25; **6 tests, zero failures**.
- Node runtime source compared against the live deployment: **77 files matched after normalizing line endings**.
- Gitleaks directory scan: **zero findings**. Known private credential values were also checked against the assembled text files.
- Authenticated runtime environment files, the live plugin configuration, world saves, raw player/account/conversation data, databases and generated caches are excluded.

The JARs in the GitHub release were built from the published source. Historical live gameplay observations are separately described in [the update notes](../2026-10-09-UPDATE.md) and the other verification summaries; build/test success does not prove every in-game behavior.
