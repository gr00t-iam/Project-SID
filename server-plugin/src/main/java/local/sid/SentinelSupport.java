package local.sid;

import net.citizensnpcs.api.npc.NPC;
import org.mcmonkey.sentinel.SentinelTrait;

/**
 * Sentinel combat AI for the town's guards (guardian, sheriff): they target hostile mobs on their own, chase, switch
 * weapons and block. Kept in its own class so SIDLocal loads without Sentinel installed (only called when it is).
 */
final class SentinelSupport {
    private SentinelSupport(){}
    static void equip(NPC npc,double health){
        SentinelTrait s=npc.getOrAddTrait(SentinelTrait.class);
        if(!s.allTargets.targets.contains("MONSTERS"))s.addTarget("monsters");
        s.addIgnore("players");s.addIgnore("npcs");   // never a citizen or a player, whatever happens
        s.range=16;s.chaseRange=24;s.health=health;s.closeChase=true;s.rangedChase=false;
        s.fightback=false;           // a player bumping a guard by accident is not attacked back
        s.respawnTime=0;             // SIDLocal respawns fallen citizens itself (20 s at their spawn spot)
        s.enemyDrops=false;s.safeShot=true;s.autoswitch=true;s.invincible=false;s.speed=1.3;
    }
    /** Chasing or fighting a target right now (the runtime does not steer them meanwhile). */
    static boolean fighting(NPC npc){
        SentinelTrait s=npc.getTraitNullable(SentinelTrait.class);
        return s!=null&&s.chasing!=null&&s.chasing.isValid()&&!s.chasing.isDead();
    }
}
