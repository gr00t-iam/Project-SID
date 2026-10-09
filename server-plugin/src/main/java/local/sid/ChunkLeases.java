package local.sid;

import org.bukkit.*;
import org.bukkit.plugin.java.JavaPlugin;
import java.util.*;
import java.util.concurrent.*;

/** All methods and completions run on the server thread. No synchronous chunk generation. */
final class ChunkLeases implements AutoCloseable {
    record Key(World world, int x, int z) {}
    private final JavaPlugin plugin;
    private final Map<String, Set<Key>> owners = new HashMap<>();
    private final Map<Key, Chunk> loaded = new HashMap<>();
    private final Map<Key, CompletableFuture<Chunk>> pending = new LinkedHashMap<>();
    private final Set<Key> loading = new HashSet<>();
    private boolean closed;
    ChunkLeases(JavaPlugin plugin) { this.plugin=plugin; }
    CompletableFuture<Void> window(String owner, Location center, int radius) {
        Set<Key> wanted=new HashSet<>();
        for(int x=-radius;x<=radius;x++)for(int z=-radius;z<=radius;z++)
            wanted.add(new Key(center.getWorld(),(center.getBlockX()>>4)+x,(center.getBlockZ()>>4)+z));
        owners.put(owner,wanted); prune();
        List<CompletableFuture<Chunk>> waits=new ArrayList<>();
        for(Key key:wanted) {
            if(loaded.containsKey(key))continue;
            waits.add(pending.computeIfAbsent(key,k->new CompletableFuture<>()));
        }
        return CompletableFuture.allOf(waits.toArray(CompletableFuture[]::new));
    }
    private boolean wanted(Key key) { return owners.values().stream().anyMatch(s->s.contains(key)); }
    void release(String owner) { owners.remove(owner); prune(); }
    private void prune() {
        for(Key key:new ArrayList<>(loaded.keySet()))if(!wanted(key)) {
            loaded.remove(key).removePluginChunkTicket(plugin);
        }
        for(Key key:new ArrayList<>(pending.keySet()))if(!wanted(key)&&!loading.contains(key)) {
            CompletableFuture<Chunk> future=pending.remove(key);
            if(future!=null)future.completeExceptionally(new CancellationException("Chunk lease released"));
        }
    }
    void tick() {
        int started=0;
        for(Key key:new ArrayList<>(pending.keySet())) {
            if(closed||loading.size()>=4||started>=2)break;
            if(loading.contains(key))continue;
            loading.add(key);started++;
            key.world().getChunkAtAsync(key.x(),key.z(),true).whenComplete((chunk,error)->{
                // Paper completes on the main thread; schedule explicitly to preserve this contract.
                if(closed)return;
                Bukkit.getScheduler().runTask(plugin,()->{
                    loading.remove(key);CompletableFuture<Chunk> future=pending.remove(key);
                    if(error!=null){if(future!=null)future.completeExceptionally(error);return;}
                    if(wanted(key)){chunk.addPluginChunkTicket(plugin);loaded.put(key,chunk);}
                    if(future!=null)future.complete(chunk);
                });
            });
        }
    }
    @Override public void close() {
        closed=true;owners.clear();
        for(Chunk chunk:loaded.values())chunk.removePluginChunkTicket(plugin);
        loaded.clear();List<CompletableFuture<Chunk>> futures=new ArrayList<>(pending.values());pending.clear();
        futures.forEach(f->f.completeExceptionally(new CancellationException("Plugin stopped")));
    }
}
