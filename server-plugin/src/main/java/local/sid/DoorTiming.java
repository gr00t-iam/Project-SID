package local.sid;

/** Pure timing policy; call only for doors opened by the NPC controller. */
final class DoorTiming {
    private DoorTiming() {}
    static double escapeScore(double distance, boolean roofed, boolean hasGoal) {
        return hasGoal ? distance : (roofed ? 0 : 100);
    }
    static boolean shouldClose(long now, long lastDemand, boolean occupied, boolean animalNearby) {
        if (animalNearby) return !occupied || now - lastDemand >= 4000;
        return !occupied && now - lastDemand >= 1200;
    }
}
