package local.sid.minimap;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientChunkEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.hud.VanillaHudElements;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.KeyMapping;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;

import java.nio.file.Path;

/**
 * SID Minimap: a World of Warcraft-style round minimap in the bottom-right corner and a GPS line above the hotbar.
 *
 * Wiring (all through Fabric API, no mixins):
 *  - HUD: HudElementRegistry.attachElementAfter(VanillaHudElements.HOTBAR, ...) draws both every frame.
 *  - Terrain: ClientChunkEvents.CHUNK_LOAD queues chunks; END_CLIENT_TICK samples a few per tick (TerrainCache).
 *  - Keys (Options > Controls > SID Minimap): M show/hide, = zoom in, - zoom out, N cycle filter (all / resources /
 *    ores), G show/hide GPS.
 *  - Settings: config/sid-minimap.json (size, opacity, offsets, zoom range and speed, layers, dashboard address).
 *  - The server's own GPS action bar ("XYZ: ...") is hidden while this mod shows its GPS line.
 */
public final class SidMinimapClient implements ClientModInitializer {
    private static final Path CONFIG = FabricLoader.getInstance().getConfigDir().resolve("sid-minimap.json");
    private static final String[] MODES = {"ALL", "RESOURCES", "ORES"};

    @Override public void onInitializeClient() {
        MinimapConfig cfg = MinimapConfig.load(CONFIG);
        ZoomController zoom = new ZoomController(cfg.minRadius, cfg.maxRadius, cfg.zoomStep, cfg.zoomSpeed, cfg.startRadius);
        TerrainCache terrain = new TerrainCache();
        SidFeed feed = new SidFeed();
        MinimapHud hud = new MinimapHud(cfg, zoom, terrain, feed);

        KeyMapping.Category category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("sidminimap", "minimap"));
        KeyMapping toggle = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.sidminimap.toggle", InputConstants.Type.KEYSYM, InputConstants.KEY_M, category));
        KeyMapping zoomIn = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.sidminimap.zoom_in", InputConstants.Type.KEYSYM, InputConstants.KEY_EQUALS, category));
        KeyMapping zoomOut = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.sidminimap.zoom_out", InputConstants.Type.KEYSYM, InputConstants.KEY_MINUS, category));
        KeyMapping filter = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.sidminimap.filter", InputConstants.Type.KEYSYM, InputConstants.KEY_N, category));
        KeyMapping gpsKey = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.sidminimap.gps", InputConstants.Type.KEYSYM, InputConstants.KEY_G, category));

        ClientChunkEvents.CHUNK_LOAD.register((level, chunk) -> terrain.enqueue(chunk.getPos().x(), chunk.getPos().z()));
        ClientTickEvents.END_CLIENT_TICK.register(mc -> {
            boolean dirty = false;
            while (toggle.consumeClick()) { cfg.visible = !cfg.visible; dirty = true; }
            while (zoomIn.consumeClick()) zoom.zoomIn();
            while (zoomOut.consumeClick()) zoom.zoomOut();
            while (gpsKey.consumeClick()) { cfg.showGps = !cfg.showGps; dirty = true; }
            while (filter.consumeClick()) {
                int i = java.util.Arrays.asList(MODES).indexOf(cfg.mode);
                cfg.mode = MODES[(i + 1) % MODES.length]; dirty = true;
                if (mc.player != null) {
                    mc.player.sendOverlayMessage(Component.literal("Minimap: " + switch (cfg.mode) {
                        case "RESOURCES" -> "resources (flowers, food, trees, animals)";
                        case "ORES" -> "ore finder (gold, diamond, copper - arrows show how deep)";
                        default -> "everything";
                    }));
                    if ("ORES".equals(cfg.mode)) terrain.rescanAround(mc.player.blockPosition(), 6);
                }
            }
            if (dirty) cfg.save(CONFIG);
            if (mc.level == null || mc.player == null) { terrain.clear(); return; }
            terrain.tick(mc.level, mc.player.blockPosition(), "ORES".equals(cfg.mode), cfg.oreScanBelow, "ORES".equals(cfg.mode) ? 2 : 4);
            if (cfg.showCitizens) feed.tick(cfg.dashboardUrl, cfg.citizenPollMs);
        });
        // The mod draws its own GPS line; the server's (action bar "XYZ: ...") would sit on top of it.
        ClientReceiveMessageEvents.ALLOW_GAME.register((message, overlay) -> !(overlay && cfg.showGps && cfg.hideServerGps && Gps.isServerGps(message.getString())));
        HudElementRegistry.attachElementAfter(VanillaHudElements.HOTBAR, Identifier.fromNamespaceAndPath("sidminimap", "minimap"), hud::extract);
    }
}
