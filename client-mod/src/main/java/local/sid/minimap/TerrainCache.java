package local.sid.minimap;

import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.material.MapColor;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;

/**
 * Terrain for the minimap, one 16x16 tile of colours per chunk, sampled like a vanilla map (surface colour, shaded
 * by height, water by depth) plus the points of interest found while sampling: flowers, food (crops, berry bushes,
 * pumpkins, melons), trees by wood type, and in ore mode gold, diamond and copper ore.
 *
 * Sampling runs on the client thread a few chunks per tick (a budget, so terrain updates never stutter a frame);
 * finished tiles are immutable and live in a concurrent map, so the map image is composed on a worker thread.
 */
final class TerrainCache {
    enum Kind { FLOWER, FOOD, TREE, GOLD, DIAMOND, COPPER }
    record Poi(int x, int y, int z, Kind kind, String label) {}
    static final class Tile {
        final int[] rgb = new int[256];
        final List<Poi> pois = new ArrayList<>();
        boolean ores;     // ore-scanned
    }

    private final Map<Long, Tile> tiles = new ConcurrentHashMap<>();
    private final ArrayDeque<Long> queue = new ArrayDeque<>();
    private final Set<Long> queued = new HashSet<>();
    private int ticks;

    static long key(int cx, int cz) { return ((long) cx << 32) ^ (cz & 0xffffffffL); }

    void enqueue(int cx, int cz) { long k = key(cx, cz); if (queued.add(k)) queue.add(k); }
    void clear() { tiles.clear(); queue.clear(); queued.clear(); }

    /** The map colour of a world column (0 when its chunk is not sampled yet). Safe from any thread. */
    int colourAt(int x, int z) {
        Tile t = tiles.get(key(x >> 4, z >> 4));
        return t == null ? 0 : t.rgb[((z & 15) << 4) | (x & 15)];
    }

    /** Points of interest within `radius` blocks of (x, z). */
    List<Poi> poisNear(double x, double z, double radius) {
        List<Poi> out = new ArrayList<>();
        int r = (int) Math.ceil(radius / 16) + 1, cx = (int) Math.floor(x) >> 4, cz = (int) Math.floor(z) >> 4;
        for (int i = -r; i <= r; i++) for (int j = -r; j <= r; j++) {
            Tile t = tiles.get(key(cx + i, cz + j));
            if (t != null) for (Poi p : t.pois) if (Math.hypot(p.x() - x, p.z() - z) <= radius) out.add(p);
        }
        return out;
    }

    /**
     * Called every client tick: samples up to `budget` queued chunks, re-queues the chunks right around the player
     * every few seconds (things change: crops grow, trees fall), and forgets tiles far away.
     */
    void tick(Level level, BlockPos player, boolean oreMode, int oreBelow, int budget) {
        if (level == null || player == null) return;
        int pcx = player.getX() >> 4, pcz = player.getZ() >> 4;
        if (++ticks % 100 == 0) {
            for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) enqueue(pcx + i, pcz + j);
            tiles.keySet().removeIf(k -> Math.max(Math.abs((int) (k >> 32) - pcx), Math.abs((int) (long) k - pcz)) > 48);
        }
        for (int n = 0; n < budget && !queue.isEmpty(); n++) {
            long k = queue.poll(); queued.remove(k);
            int cx = (int) (k >> 32), cz = (int) k;
            LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
            if (chunk == null) continue;
            tiles.put(k, sample(level, chunk, player.getY(), oreMode, oreBelow));
        }
    }
    /** After switching to ore mode, look at the nearby chunks again (this time underground). */
    void rescanAround(BlockPos player, int chunks) {
        int pcx = player.getX() >> 4, pcz = player.getZ() >> 4;
        for (int r = 0; r <= chunks; r++) for (int i = -r; i <= r; i++) for (int j = -r; j <= r; j++)
            if (Math.max(Math.abs(i), Math.abs(j)) == r) enqueue(pcx + i, pcz + j);
    }

    private static final Predicate<BlockState> ORE = s -> s.is(BlockTags.GOLD_ORES) || s.is(BlockTags.COPPER_ORES)
        || s.is(Blocks.DIAMOND_ORE) || s.is(Blocks.DEEPSLATE_DIAMOND_ORE);

    private static Tile sample(Level level, LevelChunk chunk, int playerY, boolean oreMode, int oreBelow) {
        Tile t = new Tile();
        int bx = chunk.getPos().getMinBlockX(), bz = chunk.getPos().getMinBlockZ(), minY = level.getMinY();
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        int[] prevRow = new int[16];
        int flowers = 0, food = 0, trees = 0;
        for (int z = 0; z < 16; z++) for (int x = 0; x < 16; x++) {
            // The surface: from the top of the heightmap down to the first block with a map colour.
            int y = chunk.getHeight(Heightmap.Types.WORLD_SURFACE, x, z) + 1;
            BlockState state;
            do { y--; pos.set(bx + x, y, bz + z); state = chunk.getBlockState(pos); }
            while (state.getMapColor(level, pos) == MapColor.NONE && y > minY);
            int depth = 0;
            if (!state.getFluidState().isEmpty()) {   // water: deeper is darker
                BlockState below = state;
                while (depth < 12 && y - depth - 1 > minY && !below.getFluidState().isEmpty()) {
                    depth++; below = chunk.getBlockState(pos.set(bx + x, y - depth, bz + z));
                }
                pos.set(bx + x, y, bz + z);
            }
            int north = z == 0 ? y : prevRow[x];
            MapColor.Brightness b = depth > 0 ? (depth > 7 ? MapColor.Brightness.LOW : depth > 3 ? MapColor.Brightness.NORMAL : MapColor.Brightness.HIGH)
                : y > north ? MapColor.Brightness.HIGH : y < north ? MapColor.Brightness.LOW : MapColor.Brightness.NORMAL;
            t.rgb[(z << 4) | x] = state.getMapColor(level, pos).calculateARGBColor(b) | 0xFF000000;
            prevRow[x] = y;
            // What grows here.
            Block block = state.getBlock();
            if (flowers < 8 && state.is(BlockTags.FLOWERS)) { t.pois.add(new Poi(bx + x, y, bz + z, Kind.FLOWER, name(block))); flowers++; }
            else if (food < 16 && (block instanceof CropBlock || block == Blocks.SWEET_BERRY_BUSH || block == Blocks.PUMPKIN || block == Blocks.MELON))
                { t.pois.add(new Poi(bx + x, y, bz + z, Kind.FOOD, name(block))); food++; }
            else if (trees < 12 && (x & 3) == 0 && (z & 3) == 0 && state.is(BlockTags.LEAVES)) {
                for (int d = 1; d <= 10; d++) {
                    BlockState s = chunk.getBlockState(pos.set(bx + x, y - d, bz + z));
                    if (s.is(BlockTags.LOGS)) { t.pois.add(new Poi(bx + x, y - d, bz + z, Kind.TREE, name(s.getBlock()).replace(" log", "").replace(" stem", ""))); trees++; break; }
                    if (!s.is(BlockTags.LEAVES) && !s.isAir()) break;
                }
            }
        }
        if (oreMode) {
            // Underground: only the sections between oreBelow under the player and 16 above, and only sections that
            // can hold ore at all (maybeHas checks the section's palette, skipping most of the world at once).
            LevelChunkSection[] sections = chunk.getSections();
            int lo = Math.max(minY, playerY - oreBelow), hi = playerY + 16, ores = 0;
            for (int si = 0; si < sections.length && ores < 48; si++) {
                int sy = minY + (si << 4);
                if (sy + 15 < lo || sy > hi) continue;
                LevelChunkSection s = sections[si];
                if (s == null || s.hasOnlyAir() || !s.maybeHas(ORE)) continue;
                for (int ly = 0; ly < 16 && ores < 48; ly++) for (int lz = 0; lz < 16; lz++) for (int lx = 0; lx < 16; lx++) {
                    BlockState st = s.getBlockState(lx, ly, lz);
                    if (!ORE.test(st)) continue;
                    Kind kind = st.is(BlockTags.GOLD_ORES) ? Kind.GOLD : st.is(BlockTags.COPPER_ORES) ? Kind.COPPER : Kind.DIAMOND;
                    t.pois.add(new Poi(bx + lx, sy + ly, bz + lz, kind, name(st.getBlock())));
                    if (++ores >= 48) break;
                }
            }
            t.ores = true;
        }
        return t;
    }
    private static String name(Block b) { return b.getName().getString().toLowerCase(Locale.ROOT); }
}
