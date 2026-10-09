package local.sid.minimap;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** The minimap's maths without a running game: GPS text, zoom, projection, and a mock render of a synthetic world. */
class MinimapTest {
    @Test void gpsLineFormatsCoordinatesAndFacing() {
        assertEquals("XYZ: 124.5 / 64.0 / -892.3   Facing: North (Yaw: -179.2)", Gps.line(124.5, 64, -892.3, 180.8));
        assertEquals("South", Gps.facing(0));
        assertEquals("West", Gps.facing(90));
        assertEquals("East", Gps.facing(-90));
        assertEquals("North", Gps.facing(-179.2));
        assertEquals("North-East", Gps.facing(-135));
        assertEquals(-179.2, Gps.normalizeYaw(180.8), 1e-9);
        assertTrue(Gps.isServerGps("XYZ: 1.0 / 2.0 / 3.0"));
        assertFalse(Gps.isServerGps("Welcome!"));
    }

    @Test void zoomStepsClampAndGlide() {
        ZoomController z = new ZoomController(32, 512, 2, 10, 64);
        z.zoomIn(); z.zoomIn(); z.zoomIn();
        assertEquals(32, z.target(), 1e-9, "never closer than the micro view");
        for (int i = 0; i < 10; i++) z.zoomOut();
        assertEquals(512, z.target(), 1e-9, "never wider than the macro view");
        assertEquals(64, z.radius(), 1e-9, "the displayed radius has not moved yet");
        z.update(0.05);
        assertTrue(z.radius() > 64 && z.radius() < 512, "half way there after a frame or two");
        for (int i = 0; i < 100; i++) z.update(0.05);
        assertEquals(512, z.radius(), 1e-9);
        assertEquals(8, z.blocksPerPixel(128), 1e-9, "512-block radius on a 128-pixel map: 8 blocks a pixel");
    }

    @Test void projectionKeepsTheWayYouFaceUp() {
        double north = 180;
        // Facing north, something 10 blocks north is straight up; something east is to the right.
        double[] up = MapMath.worldToScreen(0, -10, north, 1);
        assertEquals(0, up[0], 1e-9); assertEquals(-10, up[1], 1e-9);
        double[] right = MapMath.worldToScreen(10, 0, north, 1);
        assertEquals(10, right[0], 1e-9); assertEquals(0, right[1], 1e-9);
        // Facing east (yaw -90), east is up and south is to the right.
        double[] eastUp = MapMath.worldToScreen(10, 0, -90, 1);
        assertEquals(0, eastUp[0], 1e-9); assertEquals(-10, eastUp[1], 1e-9);
        double[] southRight = MapMath.worldToScreen(0, 10, -90, 1);
        assertEquals(10, southRight[0], 1e-9);
        // And back again, at any angle and scale.
        for (double yaw = -180; yaw < 180; yaw += 37) {
            double[] s = MapMath.worldToScreen(13, -7, yaw, 2.5), w = MapMath.screenToWorld(s[0], s[1], yaw, 2.5);
            assertEquals(13, w[0], 1e-9); assertEquals(-7, w[1], 1e-9);
        }
        // The N letter follows north round the rim as the player turns.
        double[] n = MapMath.rimPoint(0, -1, 0, 50);   // facing south: north is at the bottom
        assertEquals(50, n[1], 1e-9);
    }

    @Test void mockRenderOfASyntheticWorld() {
        // A world with water to the north (z < 0) and grass to the south, and only the area within 100 blocks loaded.
        int water = 0xFF3F76E4, grass = 0xFF7FB238;
        MapMath.ColumnColour world = (x, z) -> Math.hypot(x, z) > 100 ? 0 : z < 0 ? water : grass;
        int size = 64;
        int[] px = MapMath.compose(size, 0, 0, 180, 1, world, 0, 0xFF2B2418);   // at the origin, facing north, 32-block radius
        assertEquals(0, px[0], "corners are outside the round frame: transparent");
        assertEquals(0xFF2B2418, px[(size / 2) * size + 0], "the rim");
        assertEquals(water, px[10 * size + size / 2], "ahead (north) is water");
        assertEquals(grass, px[54 * size + size / 2], "behind (south) is grass");
        // Turn to face south: the water is now behind.
        int[] turned = MapMath.compose(size, 0, 0, 0, 1, world, 0, 0xFF2B2418);
        assertEquals(grass, turned[10 * size + size / 2]);
        assertEquals(water, turned[54 * size + size / 2]);
        // Zoomed out to 4 blocks a pixel the unloaded world beyond 100 blocks shows dark.
        int[] wide = MapMath.compose(size, 0, 0, 180, 4, world, 0, 0xFF2B2418);
        assertEquals(0xFF1A1D22, wide[4 * size + size / 2]);
        // Ore mode dims the terrain.
        int[] dim = MapMath.compose(size, 0, 0, 180, 1, world, 0.5, 0xFF2B2418);
        assertEquals(MapMath.darken(water, 0.5), dim[10 * size + size / 2]);
    }

    @Test void configIsKeptSane() {
        MinimapConfig c = new MinimapConfig();
        c.configVersion = 2; c.mapSize = 5; c.opacity = 4; c.minRadius = 600; c.maxRadius = 100; c.zoomStep = 1; c.mode = "x";
        c.sane();
        assertEquals(40, c.mapSize); assertEquals(1f, c.opacity); assertTrue(c.maxRadius >= c.minRadius);
        assertTrue(c.zoomStep > 1); assertEquals("ALL", c.mode);
    }

    @Test void anOldConfigGetsTheSmallerMap() {
        MinimapConfig old = new com.google.gson.Gson().fromJson("{\"mapSize\":120,\"visible\":true}", MinimapConfig.class).sane();
        assertEquals(60, old.mapSize, "1.0.0 config: halved once");
        assertEquals(60, old.sane().mapSize, "and only once");
    }
}
