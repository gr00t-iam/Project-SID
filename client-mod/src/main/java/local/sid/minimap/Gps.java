package local.sid.minimap;

import java.util.Locale;

/**
 * The GPS line: "XYZ: 124.5 / 64.0 / -892.3   Facing: North (Yaw: -179.2)". Minecraft yaw: 0 = south, 90 = west,
 * 180/-180 = north, -90 = east. Pure Java, unit-tested.
 */
public final class Gps {
    private Gps() {}
    private static final String[] EIGHT = {"South", "South-West", "West", "North-West", "North", "North-East", "East", "South-East"};

    /** Yaw folded into [-180, 180). */
    public static double normalizeYaw(double yaw) {
        double y = ((yaw + 180) % 360 + 360) % 360 - 180;
        return y;
    }
    /** Eight-way compass name for a yaw. */
    public static String facing(double yaw) {
        double deg = ((yaw % 360) + 360) % 360;            // 0 = south, clockwise seen from above
        return EIGHT[(int) Math.round(deg / 45.0) % 8];
    }
    public static String coords(double x, double y, double z) {
        return String.format(Locale.ROOT, "XYZ: %.1f / %.1f / %.1f", x, y, z);
    }
    public static String line(double x, double y, double z, double yaw) {
        return coords(x, y, z) + "   Facing: " + facing(yaw) + String.format(Locale.ROOT, " (Yaw: %.1f)", normalizeYaw(yaw));
    }
    /** True for the server's own GPS action bar (the mod draws its own line and hides that one). */
    public static boolean isServerGps(String text) { return text != null && text.startsWith("XYZ:"); }
}
