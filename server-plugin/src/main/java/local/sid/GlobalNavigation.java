package local.sid;

import net.citizensnpcs.api.npc.NPC;
import org.bukkit.*;
import java.util.*;
import java.util.function.BiConsumer;

/** Rolling local Citizens A* legs; the final goal has no spawn or distance radius. */
final class GlobalNavigation implements AutoCloseable {
    private final String id;
    private final NPC npc;
    private final ChunkLeases chunks;
    private final BiConsumer<String,Object> events;
    private Location goal, waypoint, last;
    private String status="idle";
    private double bestAcross=Double.MAX_VALUE;private long bestAt=0;
    private long generation, lastProgress, retryAt;
    private int detour;
    private boolean loading;
    GlobalNavigation(String id,NPC npc,ChunkLeases chunks,BiConsumer<String,Object> events) {
        this.id=id;this.npc=npc;this.chunks=chunks;this.events=events;
    }
    void go(Location target) {
        stop();goal=target.clone();status="loading";lastProgress=System.currentTimeMillis();detour=0;bestAcross=Double.MAX_VALUE;bestAt=lastProgress;publish();
    }
    void stop() { generation++;goal=null;waypoint=null;loading=false;status="idle";npc.getNavigator().cancelNavigation();chunks.release("nav:"+id); }
    boolean active() { return goal!=null; }
    Map<String,Object> state() {
        Map<String,Object> value=new LinkedHashMap<>();value.put("status",status);
        if(goal!=null){value.put("x",goal.getX());value.put("y",goal.getY());value.put("z",goal.getZ());}
        return value;
    }
    private void publish() {events.accept("navigation",Map.of("agent",id,"navigation",state()));}
    private Location failedGoal;
    private void fail(String why) { failedGoal=goal==null?null:goal.clone();stop();status=why;publish(); }
    /** The goal of a trip that just failed as blocked or stuck (once), for a ferry across water; otherwise null. */
    Location takeFailedGoal() { Location g=("blocked".equals(status)||"stuck".equals(status))?failedGoal:null;failedGoal=null;return g; }
    void tick() {
        if(goal==null||!npc.isSpawned()||loading||System.currentTimeMillis()<retryAt)return;
        Location here=npc.getEntity().getLocation();long now=System.currentTimeMillis();
        if(here.getWorld()!=goal.getWorld()){fail("world_changed");return;}
        // Arrived: within 1.5 blocks across and 2 up or down (the goal is often a floor one block off).
        double across=Math.pow(here.getX()-goal.getX(),2)+Math.pow(here.getZ()-goal.getZ(),2);
        if(across<2.25&&Math.abs(here.getY()-goal.getY())<2.5){stop();status="arrived";publish();return;}
        // No closer to the goal in 45 s (circling a wall, stuck beside it): give up instead of trying forever.
        if(across<bestAcross-1){bestAcross=across;bestAt=now;}
        else if(now-bestAt>45000){fail("stuck");return;}
        if(last==null||Math.pow(here.getX()-last.getX(),2)+Math.pow(here.getZ()-last.getZ(),2)>0.25){last=here.clone();lastProgress=now;}   // horizontal: jumping in place is no progress
        if(waypoint!=null&&npc.getNavigator().isNavigating()&&now-lastProgress<10000)return;
        if(waypoint!=null) {
            if(here.distanceSquared(waypoint)<4){detour=0;}else detour++;
            npc.getNavigator().cancelNavigation();waypoint=null;
        }
        if(detour>=9){fail("blocked");return;}
        double dx=goal.getX()-here.getX(),dz=goal.getZ()-here.getZ(),distance=Math.hypot(dx,dz);
        double[] turns={0,0.6,-0.6,1.2,-1.2,1.8,-1.8,2.5,-2.5};
        double angle=Math.atan2(dz,dx)+turns[detour],step=Math.min(12,distance);
        Location candidate=new Location(here.getWorld(),here.getX()+Math.cos(angle)*step,here.getY(),here.getZ()+Math.sin(angle)*step);
        long epoch=generation;loading=true;status="loading";
        chunks.window("nav:"+id,candidate,1).whenComplete((unused,error)->{
            if(epoch!=generation)return;loading=false;
            if(error!=null){fail("chunk_error");return;}
            // Preserve the exact final elevation, otherwise select walkable terrain near this leg.
            if(distance<=12&&detour==0)candidate.setY(goal.getY());
            Location safe=findStand(candidate,distance<=12&&detour==0?0:12);
            if(safe==null){detour++;retryAt=System.currentTimeMillis()+250;return;}
            waypoint=safe;last=here;lastProgress=System.currentTimeMillis();status="moving";
            npc.getNavigator().setTarget(safe);publish();
        });
    }
    private Location findStand(Location p,int vertical) {
        for(int d=0;d<=vertical;d++)for(int sign:new int[]{1,-1}) {
            Location q=p.clone();q.setY(Math.floor(p.getY())+d*sign);
            if(q.getY()<=q.getWorld().getMinHeight()||q.getY()+1>=q.getWorld().getMaxHeight()||!q.getWorld().getWorldBorder().isInside(q))continue;
            Material floor=q.clone().subtract(0,1,0).getBlock().getType();
            if(floor.isSolid()&&!Set.of(Material.MAGMA_BLOCK,Material.CACTUS,Material.CAMPFIRE,Material.SOUL_CAMPFIRE).contains(floor)
                &&q.getBlock().isPassable()&&!q.getBlock().isLiquid()&&q.clone().add(0,1,0).getBlock().isPassable())return q;
        }
        return null;
    }
    @Override public void close(){stop();}
}
