package local.sid.minimap;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Settings, saved as config/sid-minimap.json (created with these defaults on first start; edit and restart, or use
 * the keys in-game). Plain fields so Gson reads and writes them as they are.
 */
public final class MinimapConfig {
    public boolean visible = true;          // M toggles
    public int configVersion = 0;           // 0 = written by 1.0.0 (no such field there); 2 = current
    public int mapSize = 60;                // diameter in GUI pixels
    public int marginRight = 8, marginBottom = 8;
    public float opacity = 0.92f;           // 0-1, the whole map
    public int texture = 128;               // composed image resolution (pixels across)
    public double minRadius = 32, maxRadius = 512, startRadius = 64;
    public double zoomStep = 1.25;          // per key press
    public double zoomSpeed = 10;           // glide speed
    public boolean showGps = true;
    public int gpsOffsetY = 0;              // + moves the GPS line up
    public boolean hideServerGps = true;    // hide the server's action-bar GPS when this mod draws its own
    public boolean rotate = true;           // the map turns with you (false: north always up)
    public String dashboardUrl = "http://10.0.0.117:8088";   // Project SID dashboard for citizens ("" = off)
    public int citizenPollMs = 2000;
    public boolean showCitizens = true, showEnemies = true, showAnimals = true, showFlowers = true, showFood = true, showTrees = true;
    public boolean oreGold = true, oreDiamond = true, oreCopper = true;
    public int oreScanBelow = 80;           // ore mode scans this many blocks below you (and 16 above)
    public String mode = "ALL";             // ALL | RESOURCES | ORES (N cycles)

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public static MinimapConfig load(Path file) {
        try {
            if (Files.exists(file)) {
                MinimapConfig c = GSON.fromJson(Files.readString(file), MinimapConfig.class);
                if (c != null) return c.sane();
            }
        } catch (IOException | RuntimeException e) {
            System.err.println("[SID Minimap] config unreadable, using defaults: " + e.getMessage());
        }
        MinimapConfig c = new MinimapConfig();
        c.configVersion = 2;
        c.save(file);
        return c;
    }
    public void save(Path file) {
        try { Files.createDirectories(file.getParent()); Files.writeString(file, GSON.toJson(this)); }
        catch (IOException e) { System.err.println("[SID Minimap] could not save config: " + e.getMessage()); }
    }
    /** Keeps values in workable ranges whatever is in the file. */
    MinimapConfig sane() {
        if (configVersion < 2) { mapSize = Math.round(mapSize / 2f); configVersion = 2; }   // 1.0.0 was far too big
        mapSize = Math.max(40, Math.min(400, mapSize));
        texture = Math.max(64, Math.min(256, texture));
        opacity = Math.max(0.1f, Math.min(1f, opacity));
        minRadius = Math.max(8, minRadius); maxRadius = Math.max(minRadius, Math.min(2048, maxRadius));
        startRadius = Math.max(minRadius, Math.min(maxRadius, startRadius));
        zoomStep = Math.max(1.05, Math.min(3, zoomStep));
        if (!"ALL".equals(mode) && !"RESOURCES".equals(mode) && !"ORES".equals(mode)) mode = "ALL";
        return this;
    }
}
