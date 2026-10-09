package local.sid.minimap;

/**
 * Zoom state for the minimap: a target radius (in blocks from the player to the map's rim) that moves in geometric
 * steps between a micro view and a macro view, and a displayed radius that glides toward the target so zooming
 * feels smooth. Pure Java: no game classes, unit-tested.
 */
public final class ZoomController {
    private final double min, max, step, speed;
    private double target, current;

    /**
     * @param min   closest view, blocks to the rim (e.g. 32)
     * @param max   widest view (e.g. 512)
     * @param step  multiplier per zoom key press (e.g. 1.25)
     * @param speed how fast the view glides to the target, per second (higher = snappier)
     * @param start starting radius
     */
    public ZoomController(double min, double max, double step, double speed, double start) {
        if (min <= 0 || max < min || step <= 1) throw new IllegalArgumentException("zoom: 0 < min <= max, step > 1");
        this.min = min; this.max = max; this.step = step; this.speed = speed;
        this.target = this.current = clamp(start);
    }
    private double clamp(double r) { return Math.max(min, Math.min(max, r)); }

    /** Closer: a smaller radius. */
    public void zoomIn() { target = clamp(target / step); }
    /** Wider: a larger radius. */
    public void zoomOut() { target = clamp(target * step); }
    public void set(double radius) { target = clamp(radius); }

    /** Advances the glide by dt seconds; returns true while the displayed radius is still moving. */
    public boolean update(double dt) {
        if (current == target) return false;
        current = target + (current - target) * Math.exp(-speed * Math.max(0, dt));
        if (Math.abs(current - target) < 0.01) current = target;
        return true;
    }
    public double target() { return target; }
    public double radius() { return current; }
    /** Blocks per map pixel for a map `pixels` wide. */
    public double blocksPerPixel(int pixels) { return 2 * current / pixels; }
}
