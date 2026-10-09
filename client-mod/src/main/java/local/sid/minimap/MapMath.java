package local.sid.minimap;

/**
 * Projection between the world and the round map. The map turns with the player: the way they face is always up.
 * Minecraft yaw 0 faces south (+z); facing vector f = (-sin yaw, cos yaw); the player's right hand r = (-cos yaw,
 * -sin yaw). A screen offset (sx right, sy down) from the map centre is the world offset sx*r - sy*f, and back.
 * Pure Java, unit-tested.
 */
public final class MapMath {
    private MapMath() {}

    /** World offset {dx, dz} for a screen offset from the map centre, at `scale` blocks per pixel. */
    public static double[] screenToWorld(double sx, double sy, double yawDeg, double scale) {
        double a = Math.toRadians(yawDeg), fx = -Math.sin(a), fz = Math.cos(a), rx = -Math.cos(a), rz = -Math.sin(a);
        return new double[]{(sx * rx - sy * fx) * scale, (sx * rz - sy * fz) * scale};
    }
    /** Screen offset {sx, sy} from the map centre for a world offset, at `scale` blocks per pixel. */
    public static double[] worldToScreen(double dx, double dz, double yawDeg, double scale) {
        double a = Math.toRadians(yawDeg), fx = -Math.sin(a), fz = Math.cos(a), rx = -Math.cos(a), rz = -Math.sin(a);
        return new double[]{(dx * rx + dz * rz) / scale, -(dx * fx + dz * fz) / scale};
    }
    /** Where a compass letter sits on the rim: the screen direction of a world direction {dx, dz}, at radius. */
    public static double[] rimPoint(double dx, double dz, double yawDeg, double radius) {
        double[] s = worldToScreen(dx, dz, yawDeg, 1);
        double len = Math.hypot(s[0], s[1]);
        return new double[]{s[0] / len * radius, s[1] / len * radius};
    }

    /**
     * Composes the round map image: size x size ARGB pixels centred on (cx, cz), turned with yaw, `scale` blocks per
     * pixel. `colour` gives a world column's colour (0 = not loaded yet). `dim` (0-1) darkens the terrain (ore mode).
     * Pixels outside the circle are transparent; a two-pixel rim is drawn in `rim`.
     */
    public static int[] compose(int size, double cx, double cz, double yawDeg, double scale, ColumnColour colour, double dim, int rim) {
        int[] out = new int[size * size];
        double half = size / 2.0, r2 = half * half, inner = (half - 2) * (half - 2);
        double a = Math.toRadians(yawDeg), fx = -Math.sin(a), fz = Math.cos(a), rx = -Math.cos(a), rz = -Math.sin(a);
        for (int j = 0; j < size; j++) for (int i = 0; i < size; i++) {
            double sx = i + 0.5 - half, sy = j + 0.5 - half, d2 = sx * sx + sy * sy;
            if (d2 > r2) continue;                                   // outside the round frame: transparent
            if (d2 > inner) { out[j * size + i] = rim; continue; }
            double wx = cx + (sx * rx - sy * fx) * scale, wz = cz + (sx * rz - sy * fz) * scale;
            int c = colour.at((int) Math.floor(wx), (int) Math.floor(wz));
            if (c == 0) c = 0xFF1A1D22;                              // not loaded: dark
            if (dim > 0) c = darken(c, dim);
            out[j * size + i] = c;
        }
        return out;
    }
    public static int darken(int argb, double f) {
        int r = (int) (((argb >> 16) & 255) * (1 - f)), g = (int) (((argb >> 8) & 255) * (1 - f)), b = (int) ((argb & 255) * (1 - f));
        return (argb & 0xFF000000) | (r << 16) | (g << 8) | b;
    }
    /** A world column's map colour. */
    @FunctionalInterface public interface ColumnColour { int at(int x, int z); }
}
