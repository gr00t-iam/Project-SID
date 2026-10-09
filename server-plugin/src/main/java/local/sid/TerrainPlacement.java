package local.sid;

/** Only surveyed builder foundations may replace unowned water. */
final class TerrainPlacement {
    private TerrainPlacement() {}
    static boolean reclaim(String actor, boolean requested, String existing, String target, boolean playerEdited) {
        return requested && "builder".equals(actor) && !playerEdited && "WATER".equals(existing)
            && ("DIRT".equals(target) || "COBBLESTONE".equals(target));
    }
}
