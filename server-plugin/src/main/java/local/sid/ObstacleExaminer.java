package local.sid;

import net.citizensnpcs.api.astar.pathfinder.BlockExaminer;
import net.citizensnpcs.api.astar.pathfinder.BlockSource;
import net.citizensnpcs.api.astar.pathfinder.PathPoint;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.util.Vector;
import java.util.*;

/**
 * Citizens' A* treats small or thin blocks (lanterns, fences, walls, chains, bells, campfires) as open space, so it
 * plans a route straight through them and the NPC jumps against them forever. This examiner makes them obstacles:
 * a path point is refused when the feet or head block is one of them, or when it would stand on top of one.
 * Wooden doors are the opposite: a closed door blocks the planner, but SIDLocal opens doors as citizens reach them
 * (villager-style), so a path may go through one. (Citizens' own DoorExaminer does this too, but on 26.2 its
 * door-opening step throws a NullPointerException every tick when a path crosses an unloaded block.)
 */
final class ObstacleExaminer implements BlockExaminer {
    private static final Set<Material> SMALL = new HashSet<>();
    static {
        // Names differ between Minecraft versions (e.g. CHAIN became IRON_CHAIN); take whichever exist.
        for (String name : List.of("LANTERN","SOUL_LANTERN","COPPER_LANTERN","CHAIN","IRON_CHAIN","BELL","CAMPFIRE","SOUL_CAMPFIRE",
                "BREWING_STAND","FLOWER_POT","DECORATED_POT","END_ROD","LIGHTNING_ROD","CANDLE")) {
            Material m = Material.matchMaterial(name);
            if (m != null) SMALL.add(m);
        }
    }
    static boolean obstacle(Material m) {
        return m != null && (SMALL.contains(m) || Tag.FENCES.isTagged(m) || Tag.WALLS.isTagged(m));
    }
    static boolean wet(Material m) {
        return m == Material.WATER || m == Material.LAVA || m == Material.BUBBLE_COLUMN || m == Material.SEAGRASS
            || m == Material.TALL_SEAGRASS || m == Material.KELP || m == Material.KELP_PLANT;
    }
    static boolean door(Material m) { return m != null && Tag.WOODEN_DOORS.isTagged(m); }
    /** Doors with animals near them (pens, stables): citizens never route through these, so the animals stay in. */
    static final Set<Long> PEN_DOORS = java.util.concurrent.ConcurrentHashMap.newKeySet();
    static long pack(int x, int y, int z) { return ((long) (x & 0x3FFFFFF) << 38) | ((long) (z & 0x3FFFFFF) << 12) | (y & 0xFFF); }
    // Beside water costs extra (2.23.1): paths keep a block back from the edge where they can - citizens walking the
    // bank slipped in at the corners.
    @Override public float getCost(BlockSource source, PathPoint point) {
        Vector v = point.getVector();
        int x = v.getBlockX(), y = v.getBlockY(), z = v.getBlockZ();
        if (!source.isYWithinBounds(y - 1)) return 0f;
        if (wet(source.getMaterialAt(x + 1, y - 1, z)) || wet(source.getMaterialAt(x - 1, y - 1, z)) || wet(source.getMaterialAt(x, y - 1, z + 1)) || wet(source.getMaterialAt(x, y - 1, z - 1))) return 2f;
        return 0f;
    }
    @Override public PassableState isPassable(BlockSource source, PathPoint point) {
        Vector v = point.getVector();
        int x = v.getBlockX(), y = v.getBlockY(), z = v.getBlockZ();
        if (source.isYWithinBounds(y) && obstacle(source.getMaterialAt(x, y, z))) return PassableState.IMPASSABLE;
        if (source.isYWithinBounds(y + 1) && obstacle(source.getMaterialAt(x, y + 1, z))) return PassableState.IMPASSABLE;
        if (source.isYWithinBounds(y - 1) && obstacle(source.getMaterialAt(x, y - 1, z))) return PassableState.IMPASSABLE;
        // Water is not a road (2.22.1): standing in it or "on" it. Citizens cut across the ponds by the town hall and the
        // lake north of the village and had to be pulled out dozens of times an hour; now they keep to the banks, the
        // bridge and the causeway.
        if (source.isYWithinBounds(y - 1) && (wet(source.getMaterialAt(x, y, z)) || wet(source.getMaterialAt(x, y - 1, z)))) return PassableState.IMPASSABLE;
        // A pressure plate (or carpet) on a fence is a table top, not a floor: citizens climbed from the town hall chairs
        // onto the meeting table and stood stranded on it.
        if (source.isYWithinBounds(y - 2)) {
            Material under = source.getMaterialAt(x, y - 1, z);
            if (under != null && (Tag.PRESSURE_PLATES.isTagged(under) || Tag.WOOL_CARPETS.isTagged(under)) && obstacle(source.getMaterialAt(x, y - 2, z)))
                return PassableState.IMPASSABLE;
        }
        if (source.isYWithinBounds(y + 1) && (door(source.getMaterialAt(x, y, z)) || door(source.getMaterialAt(x, y + 1, z))))
            return PEN_DOORS.contains(pack(x, y, z)) || PEN_DOORS.contains(pack(x, y + 1, z)) ? PassableState.IMPASSABLE : PassableState.PASSABLE;
        return PassableState.IGNORE;
    }
}
