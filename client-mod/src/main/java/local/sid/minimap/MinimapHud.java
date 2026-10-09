package local.sid.minimap;

import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Draws the minimap (bottom right) and the GPS line (above the hotbar).
 *
 * The round, rotating terrain image is composed on a worker thread from the terrain cache (MapMath.compose) at most
 * 20 times a second and only when the view changed; the client thread just uploads the finished pixels to one
 * texture and blits it. Markers, compass letters and the player arrow are a handful of fills on top.
 */
final class MinimapHud {
    static final Identifier TEXTURE = Identifier.fromNamespaceAndPath("sidminimap", "map");

    private final MinimapConfig cfg;
    private final ZoomController zoom;
    private final TerrainCache terrain;
    private final SidFeed feed;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "SID Minimap composer"); t.setDaemon(true); return t; });
    private final AtomicReference<int[]> composed = new AtomicReference<>();
    private final AtomicBoolean composing = new AtomicBoolean();
    private DynamicTexture texture;
    private double lastX = Double.NaN, lastZ, lastYaw, lastRadius;
    private long lastCompose, lastFrame = System.nanoTime();
    private String lastMode = "";

    MinimapHud(MinimapConfig cfg, ZoomController zoom, TerrainCache terrain, SidFeed feed) {
        this.cfg = cfg; this.zoom = zoom; this.terrain = terrain; this.feed = feed;
    }

    // ---------- the map image ----------
    private void ensureTexture(Minecraft mc) {
        if (texture != null && texture.getPixels() != null && texture.getPixels().getWidth() == cfg.texture) return;
        if (texture != null) texture.close();
        texture = new DynamicTexture(() -> "SID minimap", cfg.texture, cfg.texture, true);
        mc.getTextureManager().register(TEXTURE, texture);
    }
    private void requestCompose(double x, double z, double yaw) {
        long now = System.currentTimeMillis();
        boolean changed = Double.isNaN(lastX) || Math.abs(x - lastX) > 0.3 || Math.abs(z - lastZ) > 0.3 || Math.abs(yaw - lastYaw) > 1
            || Math.abs(zoom.radius() - lastRadius) > 0.05 || !cfg.mode.equals(lastMode) || now - lastCompose > 500;
        if (!changed || now - lastCompose < 50 || !composing.compareAndSet(false, true)) return;
        lastX = x; lastZ = z; lastYaw = yaw; lastRadius = zoom.radius(); lastCompose = now; lastMode = cfg.mode;
        int size = cfg.texture; double scale = zoom.blocksPerPixel(size), dim = "ORES".equals(cfg.mode) ? 0.55 : 0;
        double turn = cfg.rotate ? yaw : 180;   // not rotating: north up (yaw 180 faces north)
        int alpha = Math.round(cfg.opacity * 255);
        worker.execute(() -> {
            try {
                int[] px = MapMath.compose(size, x, z, turn, scale, terrain::colourAt, dim, 0xFF2B2418);
                for (int i = 0; i < px.length; i++) if (px[i] != 0) px[i] = (px[i] & 0x00FFFFFF) | (alpha << 24);
                composed.set(px);
            } finally { composing.set(false); }
        });
    }
    private void uploadIfReady() {
        int[] px = composed.getAndSet(null);
        if (px == null || texture == null) return;
        NativeImage img = texture.getPixels();
        int n = cfg.texture;
        for (int j = 0; j < n; j++) for (int i = 0; i < n; i++) img.setPixel(i, j, px[j * n + i]);
        texture.upload();
    }

    // ---------- drawing ----------
    void extract(GuiGraphicsExtractor g, DeltaTracker delta) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;   // (F1 hides HUD elements by itself)
        long nowNs = System.nanoTime();
        zoom.update((nowNs - lastFrame) / 1e9);
        lastFrame = nowNs;
        float pt = delta.getGameTimeDeltaPartialTick(true);
        Player p = mc.player;
        double px = p.xo + (p.getX() - p.xo) * pt, py = p.yo + (p.getY() - p.yo) * pt, pz = p.zo + (p.getZ() - p.zo) * pt;
        double yaw = p.getViewYRot(pt);
        if (cfg.showGps) gps(g, mc.font, px, py, pz, yaw);
        if (!cfg.visible) return;
        ensureTexture(mc);
        requestCompose(px, pz, yaw);
        uploadIfReady();
        int size = cfg.mapSize, x0 = g.guiWidth() - size - cfg.marginRight, y0 = g.guiHeight() - size - cfg.marginBottom;
        g.blit(TEXTURE, x0, y0, x0 + size, y0 + size, 0f, 1f, 0f, 1f);
        double turn = cfg.rotate ? yaw : 180, half = size / 2.0, cx = x0 + half, cy = y0 + half;
        double scale = zoom.blocksPerPixel(size);
        markers(g, mc, px, py, pz, turn, scale, cx, cy, half - 3);
        // The player: an arrow pointing up (the way they face) - or turned, when the map keeps north up.
        arrow(g, (int) cx, (int) cy, cfg.rotate ? 0 : yaw - 180);
        // Compass letters on the rim.
        String[] letters = {"N", "E", "S", "W"}; double[][] dirs = {{0, -1}, {1, 0}, {0, 1}, {-1, 0}};
        for (int i = 0; i < 4; i++) {
            double[] r = MapMath.rimPoint(dirs[i][0], dirs[i][1], turn, half - 4);
            int lx = (int) Math.round(cx + r[0]), ly = (int) Math.round(cy + r[1]);
            g.fill(lx - 3, ly - 3, lx + 4, ly + 4, 0xB0000000);
            g.pose().pushMatrix(); g.pose().translate(lx + 0.5f, ly - 2.5f); g.pose().scale(0.65f, 0.65f);
            g.centeredText(mc.font, letters[i], 0, 0, i == 0 ? 0xFFFF5555 : 0xFFFFFFFF);
            g.pose().popMatrix();
        }
        // Zoom and mode, small, under the map's top edge.
        String info = Math.round(zoom.radius()) + "m" + ("ALL".equals(cfg.mode) ? "" : " " + cfg.mode.toLowerCase(Locale.ROOT));
        g.pose().pushMatrix(); g.pose().translate((float) cx, (float) (y0 - 5)); g.pose().scale(0.5f, 0.5f);
        g.centeredText(mc.font, info, 0, 0, 0xFFE0E0E0);
        g.pose().popMatrix();
    }

    private void gps(GuiGraphicsExtractor g, Font font, double x, double y, double z, double yaw) {
        String text = Gps.line(x, y, z, yaw);
        int w = font.width(text), tx = (g.guiWidth() - w) / 2, ty = g.guiHeight() - 72 - cfg.gpsOffsetY;
        g.fill(tx - 4, ty - 3, tx + w + 3, ty + 10, 0x90000000);
        g.text(font, text, tx, ty, 0xFFFFFFFF, true);
    }

    private void dot(GuiGraphicsExtractor g, double cx, double cy, double[] s, int size, int colour) {
        int x = (int) Math.round(cx + s[0]), y = (int) Math.round(cy + s[1]), h = size / 2;
        g.fill(x - h - 1, y - h - 1, x + h + size % 2 + 1, y + h + size % 2 + 1, 0xC0000000);
        g.fill(x - h, y - h, x + h + size % 2, y + h + size % 2, colour);
    }
    private static boolean inside(double[] s, double r) { return s[0] * s[0] + s[1] * s[1] <= r * r; }

    private void markers(GuiGraphicsExtractor g, Minecraft mc, double px, double py, double pz, double turn, double scale, double cx, double cy, double r) {
        String mode = cfg.mode;
        double radius = zoom.radius();
        // Points of interest from the terrain: resources in RESOURCES mode, ores in ORES mode.
        List<TerrainCache.Poi> pois = terrain.poisNear(px, pz, radius);
        List<TerrainCache.Poi> ores = new ArrayList<>();
        for (TerrainCache.Poi poi : pois) {
            int colour;
            switch (poi.kind()) {
                case FLOWER -> { if (!"RESOURCES".equals(mode) || !cfg.showFlowers) continue; colour = 0xFFFF77E8; }
                case FOOD -> { if (!"RESOURCES".equals(mode) || !cfg.showFood) continue; colour = 0xFFFFC23D; }
                case TREE -> { if (!"RESOURCES".equals(mode) || !cfg.showTrees) continue; colour = treeColour(poi.label()); }
                case GOLD -> { if (!"ORES".equals(mode) || !cfg.oreGold) continue; colour = 0xFFFFD700; ores.add(poi); }
                case DIAMOND -> { if (!"ORES".equals(mode) || !cfg.oreDiamond) continue; colour = 0xFF4DF2FF; ores.add(poi); }
                case COPPER -> { if (!"ORES".equals(mode) || !cfg.oreCopper) continue; colour = 0xFFE07A3A; ores.add(poi); }
                default -> { continue; }
            }
            double[] s = MapMath.worldToScreen(poi.x() + 0.5 - px, poi.z() + 0.5 - pz, turn, scale);
            if (inside(s, r)) dot(g, cx, cy, s, poi.kind() == TerrainCache.Kind.TREE ? 3 : 2, colour);
        }
        // Ores: the nearest few get a depth label - how far down to dig from where you stand.
        ores.sort(Comparator.comparingDouble(o -> Math.hypot(o.x() - px, o.z() - pz)));
        Set<String> labelled = new HashSet<>();
        for (TerrainCache.Poi o : ores.subList(0, Math.min(ores.size(), 6))) {
            double[] s = MapMath.worldToScreen(o.x() + 0.5 - px, o.z() + 0.5 - pz, turn, scale);
            if (!inside(s, r - 6) || !labelled.add(o.kind() + ":" + (o.x() >> 2) + ":" + (o.z() >> 2))) continue;
            int dy = (int) Math.round(o.y() - py);
            small(g, mc.font, (dy <= 0 ? "↓" + (-dy) : "↑" + dy), cx + s[0] + 3, cy + s[1] - 3, 0xFFFFFFFF);
        }
        // Creatures the client can see: enemies always, animals (food) in RESOURCES mode, other players always.
        for (Entity e : mc.level.entitiesForRendering()) {
            if (e == mc.player) continue;
            double[] s = MapMath.worldToScreen(e.getX() - px, e.getZ() - pz, turn, scale);
            if (!inside(s, r)) continue;
            if (e instanceof Enemy && cfg.showEnemies) dot(g, cx, cy, s, 3, 0xFFFF3B3B);
            else if (e instanceof Animal && cfg.showAnimals && "RESOURCES".equals(mode)) dot(g, cx, cy, s, 2, 0xFFFFA0B4);
            else if (e instanceof Player && !isCitizen(e.getName().getString())) dot(g, cx, cy, s, 3, 0xFFFFFFFF);
        }
        // Project SID citizens (from the dashboard), with names; a pulsing magenta ring while they think.
        if (cfg.showCitizens) {
            long t = System.currentTimeMillis();
            List<SidFeed.Citizen> near = new ArrayList<>(feed.citizens());
            near.sort(Comparator.comparingDouble(c -> Math.hypot(c.x() - px, c.z() - pz)));
            Set<String> named = new HashSet<>();
            for (SidFeed.Citizen c : near.subList(0, Math.min(4, near.size()))) named.add(c.id());
            for (SidFeed.Citizen c : near) {
                double[] s = MapMath.worldToScreen(c.x() - px, c.z() - pz, turn, scale);
                if (!inside(s, r)) continue;
                if (c.thinking()) {
                    int pulse = (int) (2 + 1.5 * Math.sin(t / 150.0));
                    dot(g, cx, cy, s, 2 + pulse, 0x90FF5CDB);
                }
                dot(g, cx, cy, s, 3, 0xFF7CFF8A);
                if (radius <= 64 && named.contains(c.id())) small(g, mc.font, c.name(), cx + s[0] + 3, cy + s[1] - 3, 0xFFDFFFE3);
            }
        }
    }
    private boolean isCitizen(String name) { for (SidFeed.Citizen c : feed.citizens()) if (name.contains(c.name())) return true; return false; }
    private void small(GuiGraphicsExtractor g, Font font, String text, double x, double y, int colour) {
        g.pose().pushMatrix(); g.pose().translate((float) x, (float) y); g.pose().scale(0.5f, 0.5f);
        g.text(font, text, 0, 0, colour, true);
        g.pose().popMatrix();
    }
    private static int treeColour(String wood) {
        if (wood.contains("dark oak")) return 0xFF3E2A14;
        if (wood.contains("pale oak")) return 0xFFD8D4CC;
        if (wood.contains("oak")) return 0xFF8F6B3A;
        if (wood.contains("spruce")) return 0xFF2F5A2B;
        if (wood.contains("birch")) return 0xFFEDEBD8;
        if (wood.contains("jungle")) return 0xFF5BA33A;
        if (wood.contains("acacia")) return 0xFFD06A2A;
        if (wood.contains("cherry")) return 0xFFF2A7C8;
        if (wood.contains("mangrove")) return 0xFF7A2E2A;
        return 0xFF6FA347;
    }
    /** The player arrow: a little triangle at the centre, pointing up (or turned by `deg`). */
    private void arrow(GuiGraphicsExtractor g, int x, int y, double deg) {
        g.pose().pushMatrix(); g.pose().translate(x, y); g.pose().rotate((float) Math.toRadians(deg));
        for (int i = 0; i < 5; i++) g.fill(-i, -4 + i, i + 1, -3 + i, 0xFFFFFFFF);
        g.fill(-2, 1, 3, 3, 0xFFFFFFFF);
        g.pose().popMatrix();
    }
}
