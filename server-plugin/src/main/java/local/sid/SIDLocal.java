package local.sid;

import com.google.gson.*;
import net.citizensnpcs.api.CitizensAPI;
import net.citizensnpcs.api.npc.NPC;
import net.citizensnpcs.api.npc.NPCRegistry;
import net.citizensnpcs.trait.SkinTrait;
import net.citizensnpcs.trait.HologramTrait;
import org.bukkit.block.data.type.Bed;
import org.bukkit.block.BlockFace;
import net.citizensnpcs.api.trait.trait.Equipment;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.Recipe;
import org.bukkit.inventory.ShapedRecipe;
import org.bukkit.inventory.ShapelessRecipe;
import org.bukkit.inventory.FurnaceRecipe;
import org.bukkit.inventory.RecipeChoice;
import org.bukkit.block.TileState;
import org.bukkit.block.Chest;
import org.bukkit.inventory.meta.LeatherArmorMeta;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.block.data.Ageable;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryAction;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.meta.ItemMeta;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import io.papermc.paper.event.player.AsyncChatEvent;
import org.bukkit.*;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Openable;
import org.bukkit.block.data.Powerable;
import org.bukkit.block.data.type.Leaves;
import org.bukkit.entity.*;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.*;
import org.bukkit.event.world.StructureGrowEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.util.BoundingBox;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.handshake.*;
import org.java_websocket.server.WebSocketServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Paper main-thread world access; WebSocket threads only authenticate and enqueue bounded JSON. */
public final class SIDLocal extends JavaPlugin implements Listener {
    private static final Gson JSON = new Gson();
    private final Map<WebSocket, Client> clients = new ConcurrentHashMap<>();
    private final Map<String, Actor> actors = new LinkedHashMap<>();
    private final Queue<Runnable> queue = new ConcurrentLinkedQueue<>();
    private final AtomicInteger queued = new AtomicInteger();
    private NPCRegistry registry;
    private Server server;
    private Location origin;
    private Set<String> allowed;
    private long seq;
    // Tool wear (agent -> tool -> uses), potions (agent -> kind -> count), crop growth % (seasons, droughts), live price overrides.
    private final Map<String,Map<String,Integer>> wear=new HashMap<>();
    private final Map<String,Map<String,Integer>> potions=new HashMap<>();
    private volatile int growthPct=100;
    private final Map<String,Double> priceOverride=new java.util.concurrent.ConcurrentHashMap<>();
    private static final Set<String> HERBS=Set.of("POPPY","DANDELION","OXEYE_DAISY","AZURE_BLUET","CORNFLOWER","ALLIUM","LILY_OF_THE_VALLEY","RED_TULIP","ORANGE_TULIP",
        "WHITE_TULIP","PINK_TULIP","BLUE_ORCHID","RED_MUSHROOM","BROWN_MUSHROOM","NETHER_WART","FERN");
    private static final List<String> FRUIT=List.of("SWEET_BERRIES","GLOW_BERRIES","APPLE","MELON_SLICE");
    private static final Set<Material> GROWING=Set.of(Material.WHEAT,Material.CARROTS,Material.POTATOES,Material.BEETROOTS,Material.MELON_STEM,Material.PUMPKIN_STEM,
        Material.SUGAR_CANE,Material.SWEET_BERRY_BUSH,Material.MELON,Material.PUMPKIN);
    private static int durability(String tool){
        return switch(tool.split("_")[0]){case "WOODEN"->59;case "STONE"->131;case "GOLDEN"->32;case "IRON"->250;case "DIAMOND"->1561;case "NETHERITE"->2031;default->0;};
    }
    private int maxUses(String tool){
        if(TOOL_KINDS.stream().noneMatch(k->tool.endsWith("_"+k)))return 0;
        return (int)Math.round(durability(tool)*getConfig().getDouble("tool-durability-scale",1.0));
    }
    /** One use of the held tool if it is one of the given kinds; at its limit the tool breaks and is removed. */
    private void wearHeld(Actor actor,String... kinds){
        String tool=held.get(actor.id);if(tool==null)return;
        if(Arrays.stream(kinds).noneMatch(k->tool.endsWith("_"+k)))return;
        int max=maxUses(tool);if(max<=0)return;
        Map<String,Integer> w=wear.computeIfAbsent(actor.id,k->new TreeMap<>());
        int used=w.merge(tool,1,Integer::sum);inventoryDirty=true;
        if(used<max)return;
        w.remove(tool);take(actor.id,Material.valueOf(tool),1);
        Entity body=actor.npc.getEntity();
        if(body!=null)body.getWorld().playSound(body.getLocation(),"minecraft:entity.item.break",SoundCategory.NEUTRAL,1f,1f);
        // A spare of the same tool goes straight back into the hand.
        if(count(actor.id,Material.valueOf(tool))>0){held.put(actor.id,tool);applyHeld(actor);}
        event("trade",Map.of("kind","tool_broke","agent",actor.id,"item",tool,"count",1));
    }
    /** Takes n of any items in the list (in order); takes nothing and returns false if there are not enough in total. */
    private boolean takeAny(String agent,Collection<String> kinds,int n){
        Map<String,Integer> inv=inventories.getOrDefault(agent,Map.of());
        if(kinds.stream().mapToInt(k->inv.getOrDefault(k,0)).sum()<n)return false;
        for(String k:kinds){int have=inv.getOrDefault(k,0),use=Math.min(have,n);if(use>0){take(agent,Material.valueOf(k),use);n-=use;}if(n==0)break;}
        return true;
    }
    private int countAny(String agent,Collection<String> kinds){Map<String,Integer> inv=inventories.getOrDefault(agent,Map.of());return kinds.stream().mapToInt(k->inv.getOrDefault(k,0)).sum();}
    private World clockWorld;
    private double clockCarry;

    /**
     * Custom day length: the vanilla clock is stopped and the plugin advances time itself, slowly through
     * daylight (world time 23000-13000, dawn to dusk) and quickly through the night (13000-23000).
     * day-minutes / night-minutes of 0 leave the vanilla 20-minute cycle alone.
     */
    private void startClock(){
        double dayMin=getConfig().getDouble("day-minutes",0),nightMin=getConfig().getDouble("night-minutes",0);
        World world=origin.getWorld();
        if(dayMin<=0||nightMin<=0){world.setGameRule(org.bukkit.GameRules.ADVANCE_TIME,true);return;}
        clockWorld=world;world.setGameRule(org.bukkit.GameRules.ADVANCE_TIME,false);
        double dayRate=14000/(dayMin*1200),nightRate=10000/(nightMin*1200);
        getLogger().info(String.format("Custom clock: %.0f min day, %.0f min night",dayMin,nightMin));
        Bukkit.getScheduler().runTaskTimer(this,()->{
            long t=Math.floorMod(world.getTime(),24000L);
            // Sleeping still skips the night: everyone online in bed (deep sleep) -> morning.
            var online=world.getPlayers();
            if(t>=12542&&!online.isEmpty()&&online.stream().allMatch(p->p.isDeeplySleeping()||p.isSleepingIgnored())){
                world.setFullTime(world.getFullTime()+(24000-t));clockCarry=0;return;
            }
            clockCarry+=(t>=13000&&t<23000)?nightRate:dayRate;
            long step=(long)clockCarry;
            if(step>0){clockCarry-=step;world.setFullTime(world.getFullTime()+step);}
        },1,1);
    }
    private int ticks;
    private volatile boolean running;
    // Blocks placed by agents ("world|x|y|z" -> material). Agents may only break these, so player
    // builds and natural terrain are never removed. Main thread only; persisted in agent-blocks.json.
    private final Map<String,String> placed = new HashMap<>();
    // Blocks in the town destroyed by explosions, fire or mobs, waiting for the citizens to repair them:
    // key -> block data ("~MATERIAL" for natural ground, which is refilled with dirt). Persisted in damage.json.
    private final Map<String,String> damaged = new LinkedHashMap<>();
    private MapMarkers markers;   // BlueMap layers, when BlueMap is installed
    // GPS line above the hotbar (action bar) for every player, unless they turned it off with /sid gps.
    private final Set<UUID> gpsOff=new HashSet<>();
    private static final String[] COMPASS={"South","South-West","West","North-West","North","North-East","East","South-East"};
    private Path gpsFile(){return getDataFolder().toPath().resolve("gps-off.txt");}
    private void loadGps(){try{if(Files.exists(gpsFile()))for(String l:Files.readAllLines(gpsFile()))if(!l.isBlank())gpsOff.add(UUID.fromString(l.trim()));}catch(IOException|RuntimeException e){getLogger().warning("gps-off.txt: "+e.getMessage());}}
    private void saveGps(){try{Files.createDirectories(getDataFolder().toPath());Files.write(gpsFile(),gpsOff.stream().map(UUID::toString).toList());}catch(IOException e){getLogger().warning("gps-off.txt: "+e.getMessage());}}
    /** "XYZ: 124.5 / 64.0 / -892.3   Facing: North (Yaw: -179.2)" - the same line the SID Minimap mod draws. */
    static String gpsLine(Location l){
        double yaw=((l.getYaw()+180)%360+360)%360-180;
        String facing=COMPASS[(int)Math.round((((l.getYaw()%360)+360)%360)/45.0)%8];
        return String.format(Locale.ROOT,"XYZ: %.1f / %.1f / %.1f   Facing: %s (Yaw: %.1f)",l.getX(),l.getY(),l.getZ(),facing,yaw);
    }
    private void gpsTick(){
        if(!getConfig().getBoolean("gps-hud",true))return;
        for(Player p:Bukkit.getOnlinePlayers())if(!gpsOff.contains(p.getUniqueId()))p.sendActionBar(Component.text(gpsLine(p.getLocation()),NamedTextColor.WHITE));
    }
    private boolean damageDirty=false;
    private Set<Material> buildable = Set.of();
    private boolean placedDirty;
    // Agent inventories (agent -> material -> count) and held item; persisted in agent-inventories.json.
    private final Map<String,Map<String,Integer>> inventories = new HashMap<>();
    private final Map<String,String> held = new HashMap<>();
    private boolean inventoryDirty;
    // Armour worn per agent (slot -> item), starter stockpile still to be placed into new warehouse chests,
    // and one-time grants already handed out ("agent:ITEM").
    private final Map<String,Map<String,String>> armor = new HashMap<>();
    private final Map<String,Integer> stockpileLeft = new LinkedHashMap<>();
    private boolean stockpileStarted;
    private final Set<String> granted = new HashSet<>();
    // Pets owned by agents (agent -> entity UUIDs); they follow their owner around.
    private final Map<String,List<String>> pets = new HashMap<>();
    // Fishing: weighted catches like vanilla's fish / junk / treasure split. Rods last 64 casts.
    private static final List<Object[]> FISH=List.of(new Object[]{"COD",60},new Object[]{"SALMON",25},new Object[]{"PUFFERFISH",2},new Object[]{"TROPICAL_FISH",2});
    private static final List<Object[]> JUNK=List.of(new Object[]{"LILY_PAD",17},new Object[]{"BOWL",10},new Object[]{"STICK",5},new Object[]{"STRING",5},new Object[]{"LEATHER",10},
        new Object[]{"BONE",10},new Object[]{"INK_SAC",1},new Object[]{"ROTTEN_FLESH",10},new Object[]{"TRIPWIRE_HOOK",10},new Object[]{"LEATHER_BOOTS",10});
    private static final List<Object[]> TREASURE=List.of(new Object[]{"NAME_TAG",1},new Object[]{"SADDLE",1},new Object[]{"NAUTILUS_SHELL",1},new Object[]{"BOW",1},new Object[]{"FISHING_ROD",1},new Object[]{"BOOK",1});
    private final Random random=new Random();
    // Oak leaves an agent shook recently (so apples are not farmed from one block).
    private final Map<String,Long> shaken=new HashMap<>();
    private static final Map<String,Double> FUEL_UNITS=Map.of("COAL",8.0,"CHARCOAL",8.0,"BLAZE_ROD",12.0,"DRIED_KELP_BLOCK",20.0);
    private static final Set<String> SOUNDS = Set.of("block.bell.use","block.anvil.use","block.smithing_table.use","block.note_block.bell","block.note_block.flute",
        "block.note_block.harp","block.note_block.chime","entity.villager.celebrate","entity.player.levelup","event.raid.horn","music_disc.cat","music_disc.chirp",
        "music_disc.mall","music_disc.blocks","block.campfire.crackle","entity.cat.purreow","entity.wolf.ambient","block.chest.open","entity.villager.work_farmer",
        "entity.villager.work_toolsmith","block.grindstone.use","entity.experience_orb.pickup","ui.toast.challenge_complete","item.book.page_turn","entity.villager.trade",
        "block.brewing_stand.brew","entity.generic.drink","entity.splash_potion.break","entity.item.break","entity.villager.work_cleric","block.anvil.land","block.bell.resonate");
    private static final Map<String,Integer> FOOD_VALUE = Map.ofEntries(Map.entry("BREAD",5),Map.entry("APPLE",4),Map.entry("CARROT",3),
        Map.entry("POTATO",1),Map.entry("BAKED_POTATO",5),Map.entry("BEETROOT",1),Map.entry("COOKED_BEEF",8),Map.entry("COOKED_PORKCHOP",8),
        Map.entry("COOKED_CHICKEN",6),Map.entry("COOKED_MUTTON",6),Map.entry("COOKIE",2),Map.entry("MELON_SLICE",2),Map.entry("PUMPKIN_PIE",8),
        Map.entry("GOLDEN_CARROT",6),Map.entry("SWEET_BERRIES",2),Map.entry("MUSHROOM_STEW",6),Map.entry("BEETROOT_SOUP",6));
    private static final List<String> ARMOR_SLOTS = List.of("HELMET","CHESTPLATE","LEGGINGS","BOOTS");
    // Crops the agents look after: planted by agents, or on farm plots a player made for them (adoptfarm).
    // Other players' crops are never harvested.
    private final Set<String> crops = new HashSet<>();
    // Blocks placed by players (recorded from v2.1.0): agents never clear these.
    private final Set<String> playerPlaced = new HashSet<>();
    // Long-distance travel: rolling Citizens legs toward any destination, chunks loaded asynchronously on the way.
    private ChunkLeases leases;
    private final Map<String,GlobalNavigation> navs = new HashMap<>();
    /** roam-radius <= 0 (the default from 2.2.0) means agents may go and work anywhere in the world. */
    private double roamRadius(){return getConfig().getDouble("roam-radius",0);}
    private boolean outsideArea(Location l,double pad){double r=roamRadius();return r>0&&origin!=null&&l.getWorld()==origin.getWorld()&&l.distanceSquared(origin)>(r+pad)*(r+pad);}
    /** The always-loaded town area (force-loaded chunks); outside it agents keep their own chunks loaded. */
    private double loadedRadius(){return getConfig().getDouble("loaded-radius",Math.max(48,roamRadius()));}
    @SuppressWarnings("unchecked")
    private GlobalNavigation nav(Actor actor){return navs.computeIfAbsent(actor.id,k->new GlobalNavigation(actor.id,actor.npc,leases,(type,data)->event(type,(Map<String,Object>)data)));}
    private static final Set<Material> NATURAL_GROUND = Set.of(Material.GRASS_BLOCK,Material.DIRT,Material.COARSE_DIRT,Material.ROOTED_DIRT,Material.PODZOL,
        Material.MYCELIUM,Material.MOSS_BLOCK,Material.MUD,Material.STONE,Material.GRANITE,Material.DIORITE,Material.ANDESITE,Material.TUFF,Material.CALCITE,
        Material.GRAVEL,Material.SAND,Material.RED_SAND,Material.SANDSTONE,Material.CLAY,Material.SNOW,Material.SNOW_BLOCK,Material.SHORT_GRASS,Material.TALL_GRASS,
        Material.FERN,Material.LARGE_FERN,Material.DEAD_BUSH,Material.MOSS_CARPET,Material.VINE,Material.PUMPKIN,Material.MELON,Material.COBWEB);
    /** Natural terrain an agent may clear from a building site: soil, rock, sand, plants and trees, never anything built. */
    private boolean naturalGround(Block block){
        Material m=block.getType();
        if(placed.containsKey(key(block))||playerPlaced.contains(key(block))||block.getState() instanceof TileState)return false;
        return NATURAL_GROUND.contains(m)||Tag.LOGS.isTagged(m)||Tag.LEAVES.isTagged(m)||Tag.FLOWERS.isTagged(m)||Tag.SAPLINGS.isTagged(m);
    }
    private static final Map<Material,Material> SEED_CROPS = Map.of(Material.WHEAT_SEEDS,Material.WHEAT,Material.CARROT,Material.CARROTS,
        Material.POTATO,Material.POTATOES,Material.BEETROOT_SEEDS,Material.BEETROOTS);
    private static final Map<EntityType,Material> BREED_FOOD = Map.of(EntityType.COW,Material.WHEAT,EntityType.SHEEP,Material.WHEAT,
        EntityType.GOAT,Material.WHEAT,EntityType.PIG,Material.CARROT,EntityType.CHICKEN,Material.WHEAT_SEEDS,EntityType.RABBIT,Material.CARROT);
    private static final Set<Material> NEVER_MINE = Set.of(Material.BEDROCK,Material.BARRIER,Material.SPAWNER,Material.END_PORTAL_FRAME,
        Material.REINFORCED_DEEPSLATE,Material.COMMAND_BLOCK,Material.STRUCTURE_BLOCK,Material.BUDDING_AMETHYST);
    private static final Set<Material> FUEL = Set.of(Material.COAL,Material.CHARCOAL);
    private static final List<String> TIERS = List.of("WOODEN","STONE","GOLDEN","IRON","DIAMOND","NETHERITE");
    private static final List<String> TOOL_KINDS = List.of("SWORD","AXE","PICKAXE","SHOVEL","HOE");
    private final Map<Material,Double> valueCache = new HashMap<>();
    private static final int OFFER_FIRST=36, OFFER_LAST=44, WANT_FIRST=27, SUMMARY=45, ACCEPT=49, CANCEL=53;
    /** An open trade window between one player and one agent. The top rows only display the agent's
     *  virtual inventory; the only real items in the window are the player's offer in slots 36-44. */
    /** A citizen's panel: what it carries, holds and wears, how it is doing, and buttons to trade or give orders. */
    private final class CitizenPanel implements InventoryHolder {
        final Actor actor; final Player player; Inventory inventory;
        CitizenPanel(Actor actor,Player player){this.actor=actor;this.player=player;}
        @Override public Inventory getInventory(){return inventory;}
    }
    private static final int P_TRADE=45,P_FOLLOW=46,P_COME=47,P_STAY=48,P_HOME=49,P_FREE=50,P_CLOSE=53;
    private static ItemStack icon(Material m,String name,NamedTextColor color,List<String> lore){
        ItemStack s=new ItemStack(m);ItemMeta meta=s.getItemMeta();
        meta.displayName(Component.text(name,color).decoration(net.kyori.adventure.text.format.TextDecoration.ITALIC,false));
        if(!lore.isEmpty())meta.lore(lore.stream().map(l->(Component)Component.text(l,NamedTextColor.GRAY).decoration(net.kyori.adventure.text.format.TextDecoration.ITALIC,false)).toList());
        s.setItemMeta(meta);return s;
    }
    private void openPanel(Actor actor,Player player){
        CitizenPanel panel=new CitizenPanel(actor,player);
        panel.inventory=Bukkit.createInventory(panel,54,Component.text(actor.npc.getName()));
        renderPanel(panel);player.openInventory(panel.inventory);
    }
    private void renderPanel(CitizenPanel p){
        Inventory inv=p.inventory;inv.clear();Actor a=p.actor;
        // Rows 1-4: everything the citizen carries (one slot per kind, with the full count).
        int slot=0;
        for(Map.Entry<String,Integer> e:inventories.getOrDefault(a.id,Map.of()).entrySet()){
            if(slot>=36)break;Material m=Material.matchMaterial(e.getKey());if(m==null||!m.isItem()||m.isAir())continue;
            int n=e.getValue();ItemStack s=new ItemStack(m,Math.max(1,Math.min(n,m.getMaxStackSize())));
            List<String> lore=new ArrayList<>();lore.add("Carrying "+n);
            int max=maxUses(m.name());if(max>0)lore.add("Wear: "+(max-wear.getOrDefault(a.id,Map.of()).getOrDefault(m.name(),0))+"/"+max+" uses left");
            ItemMeta meta=s.getItemMeta();meta.lore(lore.stream().map(l->(Component)Component.text(l,NamedTextColor.GRAY)).toList());s.setItemMeta(meta);
            inv.setItem(slot++,s);
        }
        // Row 5: held item, armour, status.
        String hand=held.get(a.id);
        inv.setItem(36,hand==null?icon(Material.LIGHT_GRAY_STAINED_GLASS_PANE,"Empty hand",NamedTextColor.DARK_GRAY,List.of()):icon(Material.valueOf(hand),"Holding: "+pretty(Material.valueOf(hand)),NamedTextColor.YELLOW,List.of()));
        int i=37;for(String part:ARMOR_SLOTS){String worn=armor.getOrDefault(a.id,Map.of()).get(part);
            inv.setItem(i++,worn==null?icon(Material.LIGHT_GRAY_STAINED_GLASS_PANE,"No "+part.toLowerCase(),NamedTextColor.DARK_GRAY,List.of()):icon(Material.valueOf(worn),"Wearing: "+pretty(Material.valueOf(worn)),NamedTextColor.AQUA,List.of()));}
        List<String> status=new ArrayList<>();
        if(!a.status.isBlank())for(String line:a.status.replaceAll("§.","").split("\\s*[\\n|]\\s*"))if(!line.isBlank())status.add(line);
        if(a.npc.getEntity() instanceof LivingEntity living)status.add("Health "+Math.round(living.getHealth())+"/20");
        status.add("Shift-click items from your inventory to give them.");
        status.add("Their items (mayor): click = take a stack, shift-click = take all, right-click = send all to the warehouse.");
        inv.setItem(43,icon(Material.PAPER,a.npc.getName(),NamedTextColor.GOLD,status));
        // Row 6: buttons (orders go to the town like /sid commands).
        inv.setItem(P_TRADE,icon(Material.EMERALD,"Trade",NamedTextColor.GREEN,List.of("Open the trade window")));
        inv.setItem(P_FOLLOW,icon(Material.LEAD,"Follow me",NamedTextColor.WHITE,List.of("/sid follow "+a.id)));
        inv.setItem(P_COME,icon(Material.COMPASS,"Come here",NamedTextColor.WHITE,List.of("/sid come "+a.id)));
        inv.setItem(P_STAY,icon(Material.IRON_BARS,"Stay here",NamedTextColor.WHITE,List.of("/sid stay "+a.id)));
        inv.setItem(P_HOME,icon(Material.RED_BED,"Go home",NamedTextColor.WHITE,List.of("/sid home "+a.id)));
        inv.setItem(P_FREE,icon(Material.IRON_PICKAXE,"Back to work",NamedTextColor.WHITE,List.of("/sid free "+a.id,"Ends follow, come, stay or home")));
        inv.setItem(P_CLOSE,icon(Material.BARRIER,"Close",NamedTextColor.RED,List.of()));
    }
    @EventHandler(priority=EventPriority.HIGH)
    public void panelClick(InventoryClickEvent e){
        if(!(e.getView().getTopInventory().getHolder() instanceof CitizenPanel panel))return;
        e.setCancelled(true);
        Player player=panel.player;Actor actor=panel.actor;int raw=e.getRawSlot();
        if(raw>=54){
            // Shift-click from the player's own inventory: a gift, exactly like right-clicking with the item.
            if(e.getAction()!=InventoryAction.MOVE_TO_OTHER_INVENTORY)return;
            ItemStack gift=e.getCurrentItem();if(gift==null||gift.getType().isAir())return;
            Map<String,Integer> inventory=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
            if(inventory.size()>=36&&!inventory.containsKey(gift.getType().name())){say(actor,"My pockets are full, sorry!");return;}
            ItemStack given=gift.clone();e.setCurrentItem(null);addOrDrop(actor,given);
            boolean equipped=maybeEquip(actor,given.getType());
            say(actor,"Thank you for the "+(given.getAmount()>1?given.getAmount()+" ":"")+pretty(given.getType())+", "+player.getName()+"!"+(equipped?" Equipped it.":""));
            event("trade",Map.of("kind","received","agent",actor.id,"from",player.getName(),"item",given.getType().name(),"count",given.getAmount(),"equipped",equipped));
            Bukkit.getScheduler().runTask(this,()->renderPanel(panel));return;
        }
        if(raw<36){
            // The mayor clears a citizen's pack (2.26.0), no trade and no penalty: left-click takes a stack, shift-click
            // takes all of that item, right-click sends all of it to the warehouse (Jasper files it). Operators and the
            // players listed under inventory-managers (the mayor) only.
            ItemStack shown=e.getCurrentItem();if(shown==null||shown.getType().isAir()||shown.getType()==Material.LIGHT_GRAY_STAINED_GLASS_PANE)return;
            if(!player.isOp()&&!getConfig().getStringList("inventory-managers").contains(player.getName())&&!(getConfig().getStringList("inventory-managers").isEmpty()&&player.getName().equals(getConfig().getString("mayor","jrmym1981")))){
                player.sendMessage(Component.text("Only the mayor can take things from a citizen's pack.",NamedTextColor.RED));return;}
            Material m=shown.getType();Map<String,Integer> inv=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
            int have=inv.getOrDefault(m.name(),0);if(have<=0)return;
            boolean toWarehouse=e.isRightClick(),all=e.isShiftClick()||toWarehouse;
            int n=all?have:Math.min(have,m.getMaxStackSize());
            int moved=0;
            if(toWarehouse){
                int left=n;
                for(org.bukkit.block.Container c:warehouseChests()){if(left<=0)break;
                    while(left>0){int k=Math.min(left,m.getMaxStackSize());Map<Integer,ItemStack> over=c.getInventory().addItem(new ItemStack(m,k));int back=over.values().stream().mapToInt(ItemStack::getAmount).sum();left-=k-back;if(back>0)break;}}
                moved=n-left;
                if(moved<=0){player.sendMessage(Component.text("The warehouse has no room for "+pretty(m)+".",NamedTextColor.RED));return;}
            }else{
                int left=n;
                while(left>0){int k=Math.min(left,m.getMaxStackSize());Map<Integer,ItemStack> over=player.getInventory().addItem(new ItemStack(m,k));int back=over.values().stream().mapToInt(ItemStack::getAmount).sum();left-=k-back;if(back>0)break;}
                moved=n-left;
                if(moved<=0){player.sendMessage(Component.text("Your inventory is full.",NamedTextColor.RED));return;}
            }
            if(have-moved<=0)inv.remove(m.name());else inv.put(m.name(),have-moved);inventoryDirty=true;
            if(held.get(actor.id)!=null&&held.get(actor.id).equals(m.name())&&!inv.containsKey(m.name())){held.remove(actor.id);applyHeld(actor);}
            player.sendMessage(Component.text((toWarehouse?"Sent ":"Took ")+moved+" "+pretty(m)+(toWarehouse?" to the warehouse":"")+" from "+actor.npc.getName()+".",NamedTextColor.GREEN));
            event("trade",Map.of("kind",toWarehouse?"mayor_to_warehouse":"mayor_took","agent",actor.id,"player",player.getName(),"item",m.name(),"count",moved));
            Bukkit.getScheduler().runTask(this,()->renderPanel(panel));return;
        }
        String verb=switch(raw){case P_FOLLOW->"follow";case P_COME->"come";case P_STAY->"stay";case P_HOME->"home";case P_FREE->"free";default->null;};
        if(raw==P_TRADE){Bukkit.getScheduler().runTask(this,()->{player.closeInventory();if(actor.npc.isSpawned())openTrade(actor,player);});return;}
        if(raw==P_CLOSE){Bukkit.getScheduler().runTask(this,()->player.closeInventory());return;}
        if(verb==null)return;
        boolean listening=clients.values().stream().anyMatch(c->c.events.contains("command"));
        if(!listening){player.sendMessage(Component.text("The SID agent runtime is offline right now.",NamedTextColor.RED));return;}
        Location l=player.getLocation();
        event("command",Map.of("player",player.getName(),"args",List.of(verb,actor.id),"x",l.getX(),"y",l.getY(),"z",l.getZ(),"yaw",l.getYaw()));
        player.sendMessage(Component.text("Sent to "+actor.npc.getName()+": /sid "+verb+" "+actor.id,NamedTextColor.GREEN));
        Bukkit.getScheduler().runTask(this,()->player.closeInventory());
    }
    @EventHandler(priority=EventPriority.HIGH)
    public void panelDrag(InventoryDragEvent e){if(e.getView().getTopInventory().getHolder() instanceof CitizenPanel)e.setCancelled(true);}

    private final class TradeView implements InventoryHolder {
        final Actor actor; final Player player; final Map<Material,Integer> want = new LinkedHashMap<>(); Inventory inventory; boolean done;
        TradeView(Actor actor,Player player){this.actor=actor;this.player=player;}
        @Override public Inventory getInventory(){return inventory;}
    }
    private static final Set<Material> SURFACE = Set.of(Material.GRASS_BLOCK,Material.DIRT,Material.COARSE_DIRT,Material.PODZOL);
    private static final Map<String,Double> WEAPON_DAMAGE = Map.ofEntries(
        Map.entry("WOODEN_SWORD",4.0),Map.entry("STONE_SWORD",5.0),Map.entry("IRON_SWORD",6.0),Map.entry("GOLDEN_SWORD",4.0),
        Map.entry("DIAMOND_SWORD",7.0),Map.entry("NETHERITE_SWORD",8.0),Map.entry("WOODEN_AXE",7.0),Map.entry("STONE_AXE",9.0),
        Map.entry("IRON_AXE",9.0),Map.entry("DIAMOND_AXE",9.0),Map.entry("NETHERITE_AXE",10.0),Map.entry("TRIDENT",9.0));

    private static final class Client {
        final Set<String> events = new HashSet<>(); // main thread only
        final LinkedHashMap<String, String> replies = new LinkedHashMap<>();
        final Queue<String> outgoing = new ConcurrentLinkedQueue<>();
        final long opened = System.currentTimeMillis();
        long window = opened;
        int requests;
    }
    private static final class Actor {
        final String id;
        final NPC npc;
        WebSocket owner;
        long detached;
        long lastAction;
        Location lastPosition;
        long buildWindow;
        long deadSince;
        double marginOverride;
        long fishReadyAt;
        int rodUses;
        String goal;          // block this agent is walking to (reserved so no one else is sent there)
        long goalAt;
        int overlapTicks;     // seconds spent standing in the same block as another agent
        Location progressAt;  // where it last made progress while walking
        long progressTime;
        final Set<Long> tickets=new HashSet<>();
        String status="";
        boolean thinking;     // the runtime is waiting on the citizen's model right now (shown as a pulsing brain on the map)
        String thought="";    // what it last decided, or what it is thinking about
        int built;
        Actor(String id, NPC npc, WebSocket owner) { this.id=id; this.npc=npc; this.owner=owner; }
    }

    private void loadBuildable(){
        Set<Material> materials=new HashSet<>();
        for(String materialName:getConfig().getStringList("build-materials")){
            Material material=Material.matchMaterial(materialName);
            if(material!=null&&material.isBlock()&&!material.isAir())materials.add(material);else getLogger().warning("Ignoring build material: "+materialName);
        }
        buildable=Set.copyOf(materials);
    }
    /** /sidlocal reload: re-read config.yml (materials, zones, limits) without restarting the server. */
    @Override public boolean onCommand(CommandSender sender,Command command,String label,String[] args){
        if(command.getName().equalsIgnoreCase("sid"))return sidCommand(sender,args);
        if(command.getName().equalsIgnoreCase("coords")){
            if(sender instanceof Player)return sidCommand(sender,new String[]{"gps"});
            for(Player p:Bukkit.getOnlinePlayers())sender.sendMessage(p.getName()+": "+gpsLine(p.getLocation()));
            for(Actor a:actors.values())if(a.npc.isSpawned())sender.sendMessage(a.npc.getName()+" ("+a.id+"): "+gpsLine(a.npc.getEntity().getLocation()));
            if(Bukkit.getOnlinePlayers().isEmpty()&&actors.isEmpty())sender.sendMessage("Nobody online.");
            return true;
        }
        if(args.length!=1||!args[0].equalsIgnoreCase("reload"))return false;
        reloadConfig();loadBuildable();allowed=new HashSet<>(getConfig().getStringList("allowed-agents"));sender.sendMessage("SIDLocal config reloaded, including allowed-agents (token, port and spawn need a restart).");return true;
    }
    /** /sid list is answered here; other subcommands are relayed to the agent runtime as a "command" event. */
    private boolean sidCommand(CommandSender sender,String[] args){
        if(!(sender instanceof Player player)){sender.sendMessage("Players only.");return true;}
        if(args.length>0&&args[0].equalsIgnoreCase("gps")){
            boolean off=!gpsOff.remove(player.getUniqueId());if(off)gpsOff.add(player.getUniqueId());saveGps();
            if(off)player.sendActionBar(Component.empty());
            player.sendMessage(Component.text("GPS line "+(off?"off":"on")+" (/sid gps to switch).",NamedTextColor.GRAY));return true;
        }
        if(args.length==0||args[0].equalsIgnoreCase("help")){
            for(String line:List.of("/sid list - who is where and what they are doing","/sid come <bot|all> - come to me","/sid follow <bot> - follow me",
                "/sid stay <bot|all> - stay where you are","/sid free <bot|all> - back to normal","/sid build <house|floor|walls|path> [size] [material] - builder builds in front of you",
                "/sid home <bot> - send a bot home","/sid gps - show/hide the coordinates line above your hotbar","/sid quests - the notice board","/sid vote <id> yes|no, /sid veto <id> - decide proposals","Talk to a bot by using its name in chat; right-click to give or trade."))player.sendMessage(Component.text(line,NamedTextColor.GRAY));
            return true;
        }
        if(args[0].equalsIgnoreCase("list")){
            if(actors.isEmpty()){player.sendMessage(Component.text("No SID agents are online.",NamedTextColor.RED));return true;}
            for(Actor a:actors.values()){
                if(!a.npc.isSpawned())continue;Location l=a.npc.getEntity().getLocation();
                player.sendMessage(Component.text(a.id,NamedTextColor.GOLD).append(Component.text(" @ "+l.getBlockX()+" "+l.getBlockY()+" "+l.getBlockZ()+(a.status.isBlank()?"":" - "+a.status),NamedTextColor.GRAY)));
            }
            return true;
        }
        boolean listening=clients.values().stream().anyMatch(c->c.events.contains("command"));
        if(!listening){player.sendMessage(Component.text("The SID agent runtime is offline right now.",NamedTextColor.RED));return true;}
        Location l=player.getLocation();
        List<String> words=Arrays.stream(args).limit(8).map(a->a.substring(0,Math.min(32,a.length()))).toList();
        event("command",Map.of("player",player.getName(),"args",words,"x",l.getX(),"y",l.getY(),"z",l.getZ(),"yaw",l.getYaw()));
        player.sendMessage(Component.text("Sent to the SID agents: /sid "+String.join(" ",words),NamedTextColor.GREEN));
        return true;
    }
    @Override public void onEnable() {
        saveDefaultConfig();
        String token=getConfig().getString("token", "");
        if (token.length()<32 || token.startsWith("REPLACE")) {
            getLogger().severe("Set SIDLocal/config.yml token to at least 32 random characters before enabling.");
            getServer().getPluginManager().disablePlugin(this); return;
        }
        allowed=new HashSet<>(getConfig().getStringList("allowed-agents"));
        String name=getConfig().getString("world", "");
        World world=name.isBlank()?Bukkit.getWorlds().getFirst():Bukkit.getWorld(name);
        if(world==null)throw new IllegalArgumentException("Configured world is not loaded");
        origin=getConfig().getBoolean("configured-spawn")
            ?new Location(world,getConfig().getDouble("spawn.x"),getConfig().getDouble("spawn.y"),getConfig().getDouble("spawn.z"))
            :world.getSpawnLocation().add(0.5,0,0.5);
        loadBuildable();
        loadPlaced();loadDamage();loadGps();
        Bukkit.getScheduler().runTaskTimer(this,this::gpsTick,20,5);   // four times a second
        if(getServer().getPluginManager().getPlugin("BlueMap")!=null)
            try{markers=new MapMarkers(world);getLogger().info("BlueMap found: live citizen and town layers on");}
            catch(Throwable t){getLogger().warning("BlueMap layers off: "+t);}
        loadInventories();
        registry=CitizensAPI.createInMemoryNPCRegistry("SIDLocal");
        running=true;
        Bukkit.getPluginManager().registerEvents(this,this);
        leases=new ChunkLeases(this);
        Bukkit.getScheduler().runTaskTimer(this,this::tick,1,1);
        startClock();
        server=new Server(new InetSocketAddress(getConfig().getString("bind","0.0.0.0"),getConfig().getInt("port",3001)),token);
        server.setConnectionLostTimeout(30);
        server.start();
    }

    @Override public void onDisable() {
        running=false;
        if(clockWorld!=null)clockWorld.setGameRule(org.bukkit.GameRules.ADVANCE_TIME,true);
        for(Actor a:actors.values())for(long k:a.tickets)origin.getWorld().removePluginChunkTicket((int)(k>>32),(int)k,this);
        for(GlobalNavigation g:navs.values())try{g.close();}catch(RuntimeException ignored){}
        for(GlobalNavigation g:horseNavs.values())try{g.close();}catch(RuntimeException ignored){}
        horseNavs.clear();riding.clear();for(NPC h:horses.values())if(h.isSpawned())h.despawn();horses.clear();
        navs.clear();if(leases!=null)leases.close();
        for(Player p:Bukkit.getOnlinePlayers())if(p.getOpenInventory().getTopInventory().getHolder() instanceof TradeView||p.getOpenInventory().getTopInventory().getHolder() instanceof CitizenPanel)p.closeInventory();
        if(server!=null)try{server.stop(1000);}catch(InterruptedException e){Thread.currentThread().interrupt();}
        for(Actor actor:actors.values())actor.npc.destroy();
        actors.clear();clients.clear();queue.clear();
        if(registry!=null)CitizensAPI.removeNamedNPCRegistry("SIDLocal");
        savePlaced();saveDamage();
        saveInventories();
    }

    private void enqueue(Runnable task) {
        if(!running)return;
        if(queued.incrementAndGet()>256){queued.decrementAndGet();return;}
        queue.add(task);
    }
    private static Block feetOf(Location l){return l.clone().add(0,0.2,0).getBlock();}
    /** Another spawned agent stands in this block (feet or head level) or is walking to it. */
    private boolean taken(Block feet,Actor except){
        String k=key(feet);
        for(Actor o:actors.values()){
            if(o==except||!o.npc.isSpawned())continue;
            Location l=o.npc.getEntity().getLocation();Block of=feetOf(l);
            if(l.getWorld()==feet.getWorld()&&of.getX()==feet.getX()&&of.getZ()==feet.getZ()&&Math.abs(of.getY()-feet.getY())<2)return true;
            if(k.equals(o.goal)&&o.npc.getNavigator().isNavigating())return true;
        }
        return false;
    }
    private boolean standable(Block feet){
        Block below=feet.getRelative(org.bukkit.block.BlockFace.DOWN),head=feet.getRelative(org.bukkit.block.BlockFace.UP);
        return feet.isPassable()&&!feet.isLiquid()&&head.isPassable()&&!head.isLiquid()&&below.getType().isSolid();
    }
    /** The wanted block if nobody else is there, otherwise the nearest free standable block within r (null if none). */
    private Location freeSpot(Actor actor,Block want,int r){return freeSpot(actor,want,r,false);}
    private Location freeSpot(Actor actor,Block want,int r,boolean mustMove){
        if(!mustMove&&!taken(want,actor))return want.getLocation().add(0.5,0,0.5);
        Block best=null;double bestD=Double.MAX_VALUE;
        for(int dx=-r;dx<=r;dx++)for(int dz=-r;dz<=r;dz++)for(int dy=-1;dy<=1;dy++){
            if(dx==0&&dz==0&&dy==0)continue;
            Block b=want.getRelative(dx,dy,dz);
            double d=dx*dx+dz*dz+dy*dy*0.5;
            if(d>=bestD||!standable(b)||taken(b,actor))continue;
            best=b;bestD=d;
        }
        return best==null?null:best.getLocation().add(0.5,0,0.5);
    }
    /** Agents standing still in the same block as another are moved to the nearest free block (walk first, then teleport). */
    private void separate(){
        List<Actor> list=actors.values().stream().filter(a->a.npc.isSpawned()).sorted(Comparator.comparing(a->a.id)).toList();
        Set<Actor> overlapping=new HashSet<>();
        for(int i=0;i<list.size();i++)for(int j=i+1;j<list.size();j++){
            Location a=list.get(i).npc.getEntity().getLocation(),b=list.get(j).npc.getEntity().getLocation();
            if(a.getWorld()!=b.getWorld()||Math.abs(a.getY()-b.getY())>=1.5)continue;
            boolean sameBlock=a.getBlockX()==b.getBlockX()&&a.getBlockZ()==b.getBlockZ();
            if(!sameBlock&&Math.hypot(a.getX()-b.getX(),a.getZ()-b.getZ())>=0.6)continue;
            // The one that got there first stays; the later (or the one that is not busy walking) steps aside.
            Actor mover=list.get(j).npc.getNavigator().isNavigating()&&!list.get(i).npc.getNavigator().isNavigating()?list.get(i):list.get(j);
            overlapping.add(mover);
        }
        // Stuck: walking for 6 s without getting anywhere (a wall, a failed path pushing straight ahead):
        // hop to a free spot at the destination instead of pressing into the wall.
        long now=System.currentTimeMillis();
        for(Actor a:list){
            Location at=a.npc.getEntity().getLocation();
            if(!a.npc.getNavigator().isNavigating()){a.progressAt=null;continue;}
            // Progress is measured on the ground (x/z): a bot jumping in place against an obstacle is not getting anywhere.
            if(a.progressAt==null||a.progressAt.getWorld()!=at.getWorld()||Math.pow(a.progressAt.getX()-at.getX(),2)+Math.pow(a.progressAt.getZ()-at.getZ(),2)>0.36){a.progressAt=at;a.progressTime=now;continue;}
            if(now-a.progressTime<6000)continue;
            Location target=a.npc.getNavigator().getTargetAsLocation();a.progressAt=null;
            if(target==null||target.getWorld()!=at.getWorld()||target.distanceSquared(at)<4)continue;
            Location spot=freeSpot(a,feetOf(target),2);
            if(spot==null)continue;
            spot.setYaw(at.getYaw());a.npc.getNavigator().cancelNavigation();
            a.npc.teleport(spot,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
            event("action",Map.of("agent",a.id,"action","unstuck","result","walked into an obstacle; moved to its destination"));
        }
        for(Actor a:list){
            if(!overlapping.contains(a)){a.overlapTicks=0;continue;}
            if(a.npc.getNavigator().isNavigating()&&a.overlapTicks<3){a.overlapTicks++;continue;}
            Location at=a.npc.getEntity().getLocation();
            Location spot=freeSpot(a,feetOf(at),3,true);
            if(spot==null){a.overlapTicks++;continue;}
            spot.setYaw(at.getYaw());spot.setPitch(at.getPitch());
            a.goal=key(spot.getBlock());
            if(++a.overlapTicks>=3){a.npc.getNavigator().cancelNavigation();a.npc.teleport(spot,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);a.overlapTicks=0;}
            else a.npc.getNavigator().setTarget(spot);
        }
    }
    // Doors agents opened on their way, closed again once nobody needs the passage (value = last demand).
    private final Map<String,Double> doorBest=new HashMap<>();private final Map<String,Long> doorSince=new HashMap<>();
    private final Map<Block,Long> openedDoors=new HashMap<>();
    /**
     * Open only along an active path. Hold while approached or occupied, then close after a clear interval.
     * Never adopt player-opened doors. Animal containment retains its original forced-close policy.
     * A citizen idling in a doorway for 3 seconds is sent two blocks clear of it.
     */
    // ---------- Citizens / Sentinel traits (v2.18.0) ----------
    private List<String> listOr(String key,List<String> def){return getConfig().isSet(key)?getConfig().getStringList(key):def;}
    private boolean sentinelOn(){return getServer().getPluginManager().isPluginEnabled("Sentinel");}
    private boolean sentinel(Actor a){return sentinelOn()&&listOr("sentinel-agents",List.of("guardian","sheriff")).contains(a.id);}
    /**
     * Life-like behaviour from Citizens' traits: they look at people near them, a right-click pauses their walk while
     * the menu is open, their chunk stays loaded wherever they work, per-role attributes (a quick courier, sturdy
     * guards), and Sentinel's combat AI for the guards.
     */
    private void applyTraits(String agent,NPC npc){
        net.citizensnpcs.trait.LookClose look=npc.getOrAddTrait(net.citizensnpcs.trait.LookClose.class);
        look.lookClose(true);look.setRange(6);look.setRealisticLooking(true);look.setDisableWhileNavigating(true);
        look.setTargetNPCs(true);look.setRandomlySwitchTargets(true);
        net.citizensnpcs.trait.PausePathfindingTrait pause=npc.getOrAddTrait(net.citizensnpcs.trait.PausePathfindingTrait.class);
        pause.setPauseOnRightClick(true);pause.setPauseDuration(200);pause.setPlayerRange(0);   // only while you talk to them
        npc.getOrAddTrait(net.citizensnpcs.trait.ChunkTicketTrait.class);
        // Walking pace: speed.<agent> multiplies the navigator speed (the courier is 25% quicker). Not the movement_speed
        // attribute: Citizens' player NPCs walk at 0.3 there, so an absolute value is easy to get wrong.
        float pace=(float)getConfig().getDouble("speed."+agent,agent.equals("courier")?1.25:1.0);
        npc.getNavigator().getDefaultParameters().speedModifier(pace);
        // attributes.<agent>.<attribute key>: value (defaults: sturdier guards)
        Map<String,Map<String,Double>> defaults=Map.of("guardian",Map.of("armor",6.0),"sheriff",Map.of("armor",4.0));
        Map<String,Double> attrs=new HashMap<>(defaults.getOrDefault(agent,Map.of()));
        org.bukkit.configuration.ConfigurationSection sec=getConfig().getConfigurationSection("attributes."+agent);
        if(sec!=null)for(String k:sec.getKeys(false))attrs.put(k.toLowerCase(),sec.getDouble(k));
        if(!attrs.isEmpty()){
            net.citizensnpcs.trait.AttributeTrait at=npc.getOrAddTrait(net.citizensnpcs.trait.AttributeTrait.class);
            for(Map.Entry<String,Double> e:attrs.entrySet()){
                org.bukkit.attribute.Attribute attr=org.bukkit.Registry.ATTRIBUTE.get(org.bukkit.NamespacedKey.minecraft(e.getKey()));
                if(attr!=null)at.setAttributeValue(attr,e.getValue());else getLogger().warning("Unknown attribute "+e.getKey()+" for "+agent);
            }
        }
        if(sentinelOn()&&listOr("sentinel-agents",List.of("guardian","sheriff")).contains(agent))
            try{SentinelSupport.equip(npc,getConfig().getDouble("sentinel-health."+agent,agent.equals("guardian")?40:30));}
            catch(RuntimeException|LinkageError e){getLogger().warning("Sentinel for "+agent+": "+e);}
    }
    /** Up from a seat (no-op when not sitting). */
    private void stand(Actor a){
        net.citizensnpcs.trait.SitTrait z=a.npc.getTraitNullable(net.citizensnpcs.trait.SitTrait.class);
        if(z!=null&&z.isSitting())z.setSitting(null);
    }
    private boolean sitting(Actor a){net.citizensnpcs.trait.SitTrait z=a.npc.getTraitNullable(net.citizensnpcs.trait.SitTrait.class);return z!=null&&z.isSitting();}
    /** A seat near them: the bottom half of a stair or slab, free above, nobody on it - or null. */
    private Block seatNear(Actor a){
        Location here=a.npc.getEntity().getLocation();Block best=null;double bd=99;
        for(int dx=-2;dx<=2;dx++)for(int dz=-2;dz<=2;dz++)for(int dy=-1;dy<=0;dy++){
            Block b=here.getBlock().getRelative(dx,dy,dz);
            boolean seat=b.getBlockData() instanceof org.bukkit.block.data.type.Stairs st&&st.getHalf()==org.bukkit.block.data.Bisected.Half.BOTTOM
                ||b.getBlockData() instanceof org.bukkit.block.data.type.Slab sl&&sl.getType()==org.bukkit.block.data.type.Slab.Type.BOTTOM;
            if(!seat||!b.getRelative(BlockFace.UP).isPassable()||!b.getRelative(BlockFace.UP,2).isPassable())continue;
            Location c=b.getLocation().add(0.5,0.5,0.5);
            if(actors.values().stream().anyMatch(o->o!=a&&o.npc.isSpawned()&&o.npc.getEntity().getLocation().distanceSquared(c)<0.8))continue;
            double d=c.distanceSquared(here);if(d<bd){bd=d;best=b;}
        }
        return best;
    }
    private void unfollow(Actor a){
        net.citizensnpcs.trait.FollowTrait f=a.npc.getTraitNullable(net.citizensnpcs.trait.FollowTrait.class);
        if(f!=null&&f.getFollowing()!=null)f.follow(null);
    }
    private org.bukkit.entity.Entity following(Actor a){net.citizensnpcs.trait.FollowTrait f=a.npc.getTraitNullable(net.citizensnpcs.trait.FollowTrait.class);return f==null?null:f.getFollowing();}
    // ---------- riding: the courier rides a horse on long trips (Citizens cannot steer a rider: the horse is steered) ----------
    private final Map<String,NPC> horses=new HashMap<>();
    private final Map<String,GlobalNavigation> horseNavs=new HashMap<>();
    private final Map<String,Location> riding=new HashMap<>();
    private boolean ride(Actor actor,Location dest){
        if(!listOr("riders",List.of("courier")).contains(actor.id))return false;
        Location here=actor.npc.getEntity().getLocation();
        if(here.getWorld()!=dest.getWorld()||here.distance(dest)<getConfig().getDouble("ride-min-distance",32))return false;
        if(roofed(here.getBlock()))return false;   // indoors: walk out first, mount outside
        NPC horse=horses.get(actor.id);
        if(horse==null){
            horse=registry.createNPC(EntityType.HORSE,actor.npc.getName()+"'s horse");
            horse.setProtected(true);horse.data().setPersistent(NPC.Metadata.COLLIDABLE,false);
            horse.getNavigator().getDefaultParameters().range(48).speedModifier(1.4f).avoidWater(true);
            horses.put(actor.id,horse);
        }
        if(!horse.isSpawned()&&!horse.spawn(here.clone()))return false;
        if(horse.getEntity() instanceof org.bukkit.entity.Horse h){h.setTamed(true);h.setAdult();h.getInventory().setSaddle(new ItemStack(Material.SADDLE));}
        {GlobalNavigation g=navs.get(actor.id);if(g!=null&&g.active())g.stop();}
        actor.npc.getNavigator().cancelNavigation();
        actor.npc.getOrAddTrait(net.citizensnpcs.trait.MountTrait.class).setMountedOn(horse.getUniqueId());
        final NPC mount=horse;
        horseNavs.computeIfAbsent(actor.id,k->new GlobalNavigation(actor.id+"-horse",mount,leases,(type,data)->{})).go(dest);
        riding.put(actor.id,dest);
        event("action",Map.of("agent",actor.id,"action","ride","result","rode off toward "+dest.getBlockX()+","+dest.getBlockZ()));
        return true;
    }
    private void dismount(Actor actor){
        Location dest=riding.remove(actor.id);
        net.citizensnpcs.trait.MountTrait m=actor.npc.getTraitNullable(net.citizensnpcs.trait.MountTrait.class);
        if(m!=null&&m.getMountedOn()!=null)m.unmount();
        GlobalNavigation g=horseNavs.get(actor.id);if(g!=null&&g.active())g.stop();
        NPC horse=horses.get(actor.id);
        if(horse!=null&&horse.isSpawned())Bukkit.getScheduler().runTaskLater(this,()->{if(!riding.containsKey(actor.id)&&horse.isSpawned())horse.despawn();},60L);
        if(dest!=null)event("action",Map.of("agent",actor.id,"action","dismount","result","got off the horse"));
    }
    /** Every tick: riders arrive (within 6 blocks: off the horse, the last steps on foot) or, if the horse is stuck, walk. */
    private void rides(){
        for(Map.Entry<String,Location> e:new ArrayList<>(riding.entrySet())){
            Actor a=actors.get(e.getKey());NPC horse=horses.get(e.getKey());GlobalNavigation g=horseNavs.get(e.getKey());
            if(a==null||!a.npc.isSpawned()||horse==null||!horse.isSpawned()){if(a!=null)dismount(a);else riding.remove(e.getKey());continue;}
            g.tick();
            Location at=horse.getEntity().getLocation(),dest=e.getValue();
            boolean arrived=at.getWorld()==dest.getWorld()&&Math.hypot(at.getX()-dest.getX(),at.getZ()-dest.getZ())<=6;
            if(arrived||!g.active()){
                dismount(a);
                if(!arrived)nav(a).go(dest);   // the horse could not get there: on foot from here
            }
        }
    }
    // ---------- ferries (2.23.0): citizens row across water in the boats left at the shore ----------
    // A trip that fails as blocked/stuck whose straight line crosses water: walk to the nearest free boat (32 blocks),
    // get in, row straight for the far bank, step out on dry land, carry on. The boat stays where it landed.
    private static final class Ferry{
        final Location goal,landing;final org.bukkit.entity.Boat boat;int phase;final long started=System.currentTimeMillis();long phaseAt=started;Location lastPos;long lastMove=started;
        Ferry(Location goal,Location landing,org.bukkit.entity.Boat boat){this.goal=goal;this.landing=landing;this.boat=boat;}
    }
    private final Map<String,Ferry> ferries=new HashMap<>();private final Map<String,Long> ferryTried=new HashMap<>();
    private boolean ferrying(Actor a){return ferries.containsKey(a.id);}
    private static boolean waterTop(Block b){return b.getType()==Material.WATER||b.getType()==Material.BUBBLE_COLUMN||b.getType()==Material.SEAGRASS||b.getType()==Material.KELP||b.getType()==Material.KELP_PLANT;}
    /** Along the straight line here -> goal: the first dry stand after open water (the far bank), or null if no water. */
    private Location lastEntry;   // where the line last entered the water (set by farBank)
    private Location farBank(Location here,Location goal){
        lastEntry=null;
        double dx=goal.getX()-here.getX(),dz=goal.getZ()-here.getZ(),len=Math.hypot(dx,dz);if(len<3)return null;
        boolean wet=false;World w=here.getWorld();
        for(double t=1;t<=len+0.5;t+=0.5){
            int x=(int)Math.floor(here.getX()+dx*t/len),z=(int)Math.floor(here.getZ()+dz*t/len);
            if(!w.isChunkLoaded(x>>4,z>>4))return null;
            Block top=w.getHighestBlockAt(x,z,HeightMap.MOTION_BLOCKING_NO_LEAVES);
            if(waterTop(top)){if(!wet)lastEntry=top.getLocation().add(0.5,1,0.5);wet=true;continue;}
            if(wet&&top.getType().isSolid()&&top.getRelative(BlockFace.UP).isPassable()&&top.getRelative(BlockFace.UP,2).isPassable())
                return top.getLocation().add(0.5,1,0.5);
        }
        return null;
    }
    private org.bukkit.entity.Boat freeBoat(Location near){
        Set<UUID> busy=new HashSet<>();for(Ferry f:ferries.values())busy.add(f.boat.getUniqueId());
        org.bukkit.entity.Boat best=null;double bd=Double.MAX_VALUE;
        for(org.bukkit.entity.Entity e:near.getWorld().getNearbyEntities(near,40,10,40,x->x instanceof org.bukkit.entity.Boat)){
            org.bukkit.entity.Boat b=(org.bukkit.entity.Boat)e;
            if(!b.getPassengers().isEmpty()||busy.contains(b.getUniqueId()))continue;
            double d=b.getLocation().distanceSquared(near);if(d<bd){bd=d;best=b;}
        }
        return best;
    }
    /** A stand on dry ground within r blocks of p (nearest first), or null. */
    private Location dryStandNear(Location p,int r){return dryStandNear(p,r,4);}
    private Location dryStandNear(Location p,int r,int dy){
        Location best=null;double bd=Double.MAX_VALUE;World w=p.getWorld();
        for(int dx=-r;dx<=r;dx++)for(int dz=-r;dz<=r;dz++){
            Block top=w.getHighestBlockAt(p.getBlockX()+dx,p.getBlockZ()+dz,HeightMap.MOTION_BLOCKING_NO_LEAVES);
            if(waterTop(top)||!top.getType().isSolid()||!top.getRelative(BlockFace.UP).isPassable()||!top.getRelative(BlockFace.UP,2).isPassable())continue;
            if(Math.abs(top.getY()+1-p.getY())>dy)continue;
            Location l=top.getLocation().add(0.5,1,0.5);double d=l.distanceSquared(p);if(d<bd){bd=d;best=l;}
        }
        return best;
    }
    private boolean tryFerry(Actor a,Location goal){
        if(ferrying(a)||!a.npc.isSpawned())return false;
        Location here=a.npc.getEntity().getLocation();
        Location bank=farBank(here,goal);if(bank==null||lastEntry==null)return false;
        // The same crossing tried again within a minute (it ran aground, the boat drifted): not again so soon.
        Long tried=ferryTried.get(a.id+"@"+goal.getBlockX()/8+","+goal.getBlockZ()/8);if(tried!=null&&System.currentTimeMillis()-tried<60000)return false;
        ferryTried.put(a.id+"@"+goal.getBlockX()/8+","+goal.getBlockZ()/8,System.currentTimeMillis());
        org.bukkit.entity.Boat boat=freeBoat(lastEntry);   // a boat on this water: nearest to where the way enters it
        if(boat==null){event("action",Map.of("agent",a.id,"action","ferry","result","no boat on this water (within 40 blocks of "+lastEntry.getBlockX()+","+lastEntry.getBlockZ()+")"));return false;}
        ferries.put(a.id,new Ferry(goal,bank,boat));
        Location to=dryStandNear(boat.getLocation(),3);if(to!=null)a.npc.getNavigator().setTarget(to);
        event("action",Map.of("agent",a.id,"action","ferry","result","going to a boat at "+boat.getLocation().getBlockX()+","+boat.getLocation().getBlockZ()+" to cross to "+bank.getBlockX()+","+bank.getBlockZ()));
        return true;
    }
    private void endFerry(Actor a,String result,boolean resume){
        Ferry f=ferries.remove(a.id);if(f==null)return;
        if(a.npc.isSpawned()){
            org.bukkit.entity.Entity body=a.npc.getEntity();
            if(body.getVehicle()!=null)body.leaveVehicle();
            if(f.phase>=1){Location land=dryStandNear(f.boat.isValid()?f.boat.getLocation():body.getLocation(),4);if(land==null)land=f.landing;land.setYaw(body.getLocation().getYaw());a.npc.teleport(land,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);}
        }
        event("action",Map.of("agent",a.id,"action","ferry","result",result));
        if(resume&&a.npc.isSpawned())nav(a).go(f.goal);
    }
    // Dry footing (2.23.3): each citizen's last dry spot; one that slips into water (not in a boat) is put straight back
    // there. Paths that hug a shore cut corners into the water and nobody could climb out (dozens of rescues an hour).
    private final Map<String,Location> lastDry=new HashMap<>();
    private final Map<String,Integer> wetHops=new HashMap<>();
    private void keepDry(){
        for(Actor a:actors.values()){
            if(!a.npc.isSpawned())continue;
            org.bukkit.entity.Entity body=a.npc.getEntity();
            if(body.getVehicle()!=null||ferrying(a))continue;
            Location here=body.getLocation();Block feet=here.getBlock(),below=feet.getRelative(BlockFace.DOWN);
            boolean wet=waterTop(feet)||waterTop(feet.getRelative(BlockFace.UP))||(waterTop(below)&&!below.getType().isSolid()&&!feet.getType().isSolid()&&here.getY()-Math.floor(here.getY())<0.3);
            if(!wet){
                if(below.getType().isSolid()&&!feet.isLiquid())lastDry.put(a.id,here.clone());
                continue;
            }
            Location back=lastDry.get(a.id);
            if(back==null||back.getWorld()!=here.getWorld()||back.distanceSquared(here)>64)continue;   // far from dry footing: the runtime's ashore handles it
            int hops=wetHops.merge(a.id,1,Integer::sum);
            back=back.clone();back.setYaw(here.getYaw());
            Location target=a.npc.getNavigator().isNavigating()?a.npc.getNavigator().getTargetAsLocation():null;
            a.npc.teleport(back,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
            if(target!=null&&hops<4)a.npc.getNavigator().setTarget(target);
            else if(hops>=4){a.npc.getNavigator().cancelNavigation();wetHops.remove(a.id);}   // keeps walking into it: stop, let the trip re-plan (or ferry)
            if(hops==1)event("action",Map.of("agent",a.id,"action","kept_dry","result","stepped back from the water at "+here.getBlockX()+","+here.getBlockY()+","+here.getBlockZ()));
        }
    }
    /** Every tick: walk to the boat, get in, row for the far bank, get out. */
    private void ferries(){
        long now=System.currentTimeMillis();
        for(Map.Entry<String,Ferry> e:new ArrayList<>(ferries.entrySet())){
            Actor a=actors.get(e.getKey());Ferry f=e.getValue();
            if(a==null||!a.npc.isSpawned()||!f.boat.isValid()){if(a!=null)endFerry(a,"the boat is gone",false);else ferries.remove(e.getKey());continue;}
            org.bukkit.entity.Entity body=a.npc.getEntity();Location bl=f.boat.getLocation();
            if(f.phase==0){
                if(now-f.phaseAt>45000){endFerry(a,"could not reach the boat",false);continue;}
                if(body.getLocation().distanceSquared(bl)>6.25){if(!a.npc.getNavigator().isNavigating()){Location to=dryStandNear(bl,3);if(to!=null)a.npc.getNavigator().setTarget(to);}continue;}
                // In the water first (a boat pulled up on the bank is pushed into the nearest water), then aboard.
                if(!waterTop(bl.getBlock())&&!waterTop(bl.clone().subtract(0,1,0).getBlock())){
                    Block wet=null;double wd=Double.MAX_VALUE;
                    for(int dx=-4;dx<=4;dx++)for(int dz=-4;dz<=4;dz++){Block t=bl.getWorld().getHighestBlockAt(bl.getBlockX()+dx,bl.getBlockZ()+dz,HeightMap.MOTION_BLOCKING_NO_LEAVES);
                        if(waterTop(t)&&t.getRelative(BlockFace.UP).isPassable()){double d=t.getLocation().distanceSquared(f.landing);if(d<wd){wd=d;wet=t;}}}
                    if(wet==null){endFerry(a,"no water beside the boat",false);continue;}
                    f.boat.teleport(wet.getLocation().add(0.5,0.9,0.5));bl=f.boat.getLocation();
                }
                a.npc.getNavigator().cancelNavigation();
                if(!f.boat.addPassenger(body)){endFerry(a,"could not get into the boat",false);continue;}
                f.phase=1;f.phaseAt=now;f.lastPos=bl.clone();f.lastMove=now;
                event("action",Map.of("agent",a.id,"action","ferry","result","rowing across"));continue;
            }
            if(f.phase==1){
                if(!f.boat.getPassengers().contains(body)){endFerry(a,"fell out of the boat",true);continue;}
                double dx=f.landing.getX()-bl.getX(),dz=f.landing.getZ()-bl.getZ(),d=Math.hypot(dx,dz);
                if(d<2.2||now-f.phaseAt>90000){endFerry(a,d<2.2?"rowed across":"gave up rowing",true);continue;}
                if(bl.distanceSquared(f.lastPos)>0.25){f.lastPos=bl.clone();f.lastMove=now;}
                else if(now-f.lastMove>5000){endFerry(a,"ran aground; stepped out",true);continue;}   // at a bank short of the landing
                org.bukkit.util.Vector v=new org.bukkit.util.Vector(dx/d*0.35,f.boat.getVelocity().getY(),dz/d*0.35);
                f.boat.setVelocity(v);
                f.boat.setRotation((float)Math.toDegrees(Math.atan2(-dx,dz)),0f);
            }
        }
    }
    /** Up out of bed (no-op when not asleep). */
    private void wake(Actor a){
        net.citizensnpcs.trait.SleepTrait z=a.npc.getTraitNullable(net.citizensnpcs.trait.SleepTrait.class);
        if(z!=null&&z.isSleeping())z.setSleeping(null);
    }
    private void doors(){
        long now=System.currentTimeMillis();
        for(Actor a:actors.values()){
            if(!a.npc.isSpawned())continue;
            Location here=a.npc.getEntity().getLocation();
            Block feet=feetOf(here);
            if(!a.npc.getNavigator().isNavigating()){
                // Standing still in a doorway blocks it: step aside after a moment - INTO the room (the side with a roof
                // over it), or toward where the citizen was going. The old rule tried the door's facing first, which is
                // often outside: at night citizens were pushed out of their homes, walked back in, stopped in the
                // doorway again, and so on (the "spinning at their doorway").
                Block door=doorAt(feet)?feet:null;
                if(door==null){doorIdle.remove(a.id);continue;}
                if(ObstacleExaminer.PEN_DOORS.contains(ObstacleExaminer.pack(door.getX(),door.getY(),door.getZ()))
                    ||!door.getWorld().getNearbyEntities(door.getLocation().add(0.5,0,0.5),2.5,2,2.5,e->e instanceof org.bukkit.entity.Animals).isEmpty())continue;
                long since=doorIdle.computeIfAbsent(a.id,k->now);
                if(now-since<3000)continue;
                doorIdle.remove(a.id);
                if(door.getBlockData() instanceof org.bukkit.block.data.type.Door d){
                    org.bukkit.block.BlockFace f=d.getFacing();
                    Block goal=a.goal==null||now-a.goalAt>15000?null:blockOf(a.goal);
                    if(goal!=null&&goal.getWorld()==here.getWorld()&&goal.getLocation().add(0.5,0,0.5).distanceSquared(here)<2.25)goal=null;
                    final Block pendingGoal=goal;
                    List<Block> spots=new ArrayList<>(List.of(door.getRelative(f,2),door.getRelative(f.getOppositeFace(),2)));
                    spots.sort(Comparator.comparingDouble(s->{
                        double toGoal=pendingGoal!=null&&pendingGoal.getWorld()==s.getWorld()?s.getLocation().distance(pendingGoal.getLocation()):0;
                        return DoorTiming.escapeScore(toGoal,roofed(s),pendingGoal!=null&&pendingGoal.getWorld()==s.getWorld());
                    }));
                    for(Block spot:spots)
                        if(spot.isPassable()&&spot.getRelative(org.bukkit.block.BlockFace.UP).isPassable()&&spot.getRelative(org.bukkit.block.BlockFace.DOWN).getType().isSolid()){
                            a.npc.getNavigator().setTarget(spot.getLocation().add(0.5,0,0.5));
                            event("action",Map.of("agent",a.id,"action","doorway","result","stepped out of a doorway"+(roofed(spot)?" (inside)":"")));break;
                        }
                }
                continue;
            }
            doorIdle.remove(a.id);
            // Door assist (2.21.0): walking, right beside a door, and not getting any closer to where it is going for
            // 4 s - the pathfinder is caught on the open leaf or the frame (citizens jittered in doorways for minutes,
            // in and out of houses, the warehouse, the town hall). Put it through: the cell on the far side of the door
            // that is nearer its destination; the walk then carries on from there.
            {
                Block nearDoor=null;
                for(int ddx=-1;ddx<=1&&nearDoor==null;ddx++)for(int ddz=-1;ddz<=1&&nearDoor==null;ddz++)for(int ddy=0;ddy>=-1&&nearDoor==null;ddy--){
                    Block b=feet.getRelative(ddx,ddy,ddz);
                    if(b.getType()!=Material.IRON_DOOR&&b.getBlockData() instanceof org.bukkit.block.data.type.Door dd&&dd.getHalf()==org.bukkit.block.data.Bisected.Half.BOTTOM)nearDoor=b;
                }
                Location tgt=a.npc.getNavigator().getTargetAsLocation();
                if(nearDoor!=null&&!ObstacleExaminer.PEN_DOORS.contains(ObstacleExaminer.pack(nearDoor.getX(),nearDoor.getY(),nearDoor.getZ()))
                    &&nearDoor.getWorld().getNearbyEntities(nearDoor.getLocation().add(0.5,0,0.5),2.5,2,2.5,e->e instanceof org.bukkit.entity.Animals).isEmpty()
                    &&tgt!=null&&tgt.getWorld()==here.getWorld()){
                    double dd=Math.hypot(tgt.getX()-here.getX(),tgt.getZ()-here.getZ());
                    Double best=doorBest.get(a.id);
                    if(best==null||dd<best-0.5){doorBest.put(a.id,dd);doorSince.put(a.id,now);}
                    else if(now-doorSince.getOrDefault(a.id,now)>4000&&dd>0.7){
                        org.bukkit.block.data.type.Door door=(org.bukkit.block.data.type.Door)nearDoor.getBlockData();
                        BlockFace f=door.getFacing();
                        Block s1=nearDoor.getRelative(f),s2=nearDoor.getRelative(f.getOppositeFace());
                        double d1=s1.getLocation().add(0.5,0,0.5).distanceSquared(tgt),d2=s2.getLocation().add(0.5,0,0.5).distanceSquared(tgt);
                        Block pick=d1<=d2?s1:s2;
                        if(pick.isPassable()&&pick.getRelative(BlockFace.UP).isPassable()&&pick.getRelative(BlockFace.DOWN).getType().isSolid()){
                            Location to=pick.getLocation().add(0.5,0,0.5);to.setYaw(here.getYaw());to.setPitch(here.getPitch());
                            a.npc.teleport(to,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
                            a.npc.getNavigator().setTarget(tgt);
                            event("action",Map.of("agent",a.id,"action","door_assist","result","through the door at "+nearDoor.getX()+","+nearDoor.getY()+","+nearDoor.getZ()));
                        }
                        doorBest.remove(a.id);doorSince.remove(a.id);
                    }
                }else{doorBest.remove(a.id);doorSince.remove(a.id);}
            }
            // The next few steps of its path: only a door on them is opened.
            Set<Long> ahead=new HashSet<>();int n=0;
            try{for(org.bukkit.util.Vector v:a.npc.getNavigator().getPathStrategy().getPath()){ahead.add(((long)v.getBlockX()<<32)^(v.getBlockZ()&0xffffffffL));if(++n>=6)break;}}catch(RuntimeException ignored){}
            org.bukkit.Location dest=a.npc.getNavigator().getPathStrategy().getCurrentDestination();
            if(dest!=null)ahead.add(((long)dest.getBlockX()<<32)^(dest.getBlockZ()&0xffffffffL));
            for(int dx=-1;dx<=1;dx++)for(int dz=-1;dz<=1;dz++)for(int dy=0;dy<=1;dy++){
                Block b=feet.getRelative(dx,dy,dz);
                if(b.getType()==Material.IRON_DOOR||!(b.getBlockData() instanceof org.bukkit.block.data.type.Door door))continue;
                if(!ahead.contains(((long)b.getX()<<32)^(b.getZ()&0xffffffffL)))continue;   // not its way: leave it shut
                if(ObstacleExaminer.PEN_DOORS.contains(ObstacleExaminer.pack(b.getX(),b.getY(),b.getZ())))continue;   // animals behind it
                // Also check current proximity: the cached pen scan may not yet include an approaching animal.
                if(!b.getWorld().getNearbyEntities(b.getLocation().add(0.5,0,0.5),2.5,2,2.5,x->x instanceof org.bukkit.entity.Animals).isEmpty())continue;
                Block base=door.getHalf()==org.bukkit.block.data.Bisected.Half.BOTTOM?b:b.getRelative(org.bukkit.block.BlockFace.DOWN);
                if(door.isOpen()){
                    // Refresh demand only for doors we opened (never adopt a player's open door).
                    if(openedDoors.containsKey(base))openedDoors.put(base,now);
                    continue;
                }
                // Open it from up to 2 blocks away: approaching at an angle a citizen used to bump into the closed door
                // short of the old 1-block trigger and jitter there without it ever opening.
                if(b.getLocation().add(0.5,0,0.5).distanceSquared(new Location(b.getWorld(),here.getX(),b.getY(),here.getZ()))>4.0)continue;
                openDoor(base,now);
                // A double door opens as one: its other leaf too (the door beside it, hinged the other way).
                for(org.bukkit.block.BlockFace side:List.of(org.bukkit.block.BlockFace.NORTH,org.bukkit.block.BlockFace.SOUTH,org.bukkit.block.BlockFace.EAST,org.bukkit.block.BlockFace.WEST)){
                    Block twin=base.getRelative(side);
                    if(twin.getType()==base.getType()&&twin.getBlockData() instanceof org.bukkit.block.data.type.Door t&&!t.isOpen()
                        &&t.getHalf()==org.bukkit.block.data.Bisected.Half.BOTTOM&&t.getFacing()==door.getFacing()&&t.getHinge()!=door.getHinge())openDoor(twin,now);
                }
            }
        }
        for(Iterator<Map.Entry<Block,Long>> it=openedDoors.entrySet().iterator();it.hasNext();){
            Map.Entry<Block,Long> e=it.next();Block b=e.getKey();
            Location c=b.getLocation().add(0.5,0,0.5);
            // Occupants always win over closure, including human players. A citizen counts while anywhere near the
            // doorway (2.5 blocks), not just standing in it: the door used to shut on someone who had stepped back
            // half a block to re-route, leaving them pushing at a closed door.
            boolean inDoor=actors.values().stream().anyMatch(a->a.npc.isSpawned()&&a.npc.getEntity().getWorld()==c.getWorld()
                &&Math.pow(a.npc.getEntity().getLocation().getX()-c.getX(),2)+Math.pow(a.npc.getEntity().getLocation().getZ()-c.getZ(),2)<6.25
                &&Math.abs(a.npc.getEntity().getLocation().getY()-c.getY())<2);
            boolean playerInDoor=b.getWorld().getPlayers().stream().anyMatch(p->Math.pow(p.getLocation().getX()-c.getX(),2)+Math.pow(p.getLocation().getZ()-c.getZ(),2)<0.36&&Math.abs(p.getLocation().getY()-c.getY())<2);
            boolean animal=!b.getWorld().getNearbyEntities(c,2.5,2,2.5,x->x instanceof org.bukkit.entity.Animals).isEmpty();
            // Preserve the original containment policy near animals, including its 4-second cap.
            if(!animal&&(inDoor||playerInDoor)){e.setValue(now);continue;}
            if(!DoorTiming.shouldClose(now,e.getValue(),inDoor||playerInDoor,animal))continue;
            it.remove();
            if(!(b.getBlockData() instanceof org.bukkit.block.data.type.Door door)||!door.isOpen())continue;
            door.setOpen(false);b.setBlockData(door,false);
            Block up=b.getRelative(org.bukkit.block.BlockFace.UP);
            if(up.getBlockData() instanceof org.bukkit.block.data.type.Door top){top.setOpen(false);up.setBlockData(top,false);}
            b.getWorld().playSound(c,"minecraft:block.wooden_door.close",SoundCategory.BLOCKS,0.6f,1f);
        }
    }
    private final Map<String,Long> doorIdle=new HashMap<>();
    /** Opens a door (both its halves) the agents need, remembered so it is closed again once nobody is near. */
    private void openDoor(Block base,long now){
        if(!(base.getBlockData() instanceof org.bukkit.block.data.type.Door door)||door.isOpen())return;
        door.setOpen(true);base.setBlockData(door,false);
        Block top=base.getRelative(org.bukkit.block.BlockFace.UP);
        if(top.getBlockData() instanceof org.bukkit.block.data.type.Door t){t.setOpen(true);top.setBlockData(t,false);}
        base.getWorld().playSound(base.getLocation(),"minecraft:block.wooden_door.open",SoundCategory.BLOCKS,0.6f,1f);
        openedDoors.put(base,now);
    }
    /** Indoors: a solid block somewhere in the 6 above (a roof), so a citizen in a doorway is stepped into the room. */
    private static boolean roofed(Block b){for(int i=2;i<=7;i++)if(b.getRelative(0,i,0).getType().isSolid())return true;return false;}
    /** Doors within 6 blocks of an animal in the town (pens, stables, coops): kept shut to citizens. */
    private void penDoors(){
        if(origin==null)return;
        Set<Long> found=new HashSet<>();double r=loadedRadius()+16;
        for(org.bukkit.entity.Entity e:origin.getWorld().getNearbyEntities(origin,r,96,r,x->x instanceof org.bukkit.entity.Animals)){
            Block c=e.getLocation().getBlock();
            for(int dx=-6;dx<=6;dx++)for(int dz=-6;dz<=6;dz++)for(int dy=-2;dy<=3;dy++){
                Block b=c.getRelative(dx,dy,dz);
                if(doorAt(b))found.add(ObstacleExaminer.pack(b.getX(),b.getY(),b.getZ()));
            }
        }
        ObstacleExaminer.PEN_DOORS.retainAll(found);ObstacleExaminer.PEN_DOORS.addAll(found);
    }
    private static boolean doorAt(Block b){return b.getBlockData() instanceof org.bukkit.block.data.type.Door&&b.getType()!=Material.IRON_DOOR;}
    private void tick() {
        if(leases!=null){leases.tick();for(GlobalNavigation g:navs.values())try{g.tick();}catch(RuntimeException e){getLogger().warning("Navigation: "+e.getMessage());}}
        for(int i=0;i<32;i++){
            Runnable task=queue.poll();if(task==null)break;queued.decrementAndGet();
            try{task.run();}catch(RuntimeException e){getLogger().warning("Bridge task: "+e.getMessage());}
        }
        for(Map.Entry<WebSocket,Client> entry:clients.entrySet()){
            WebSocket ws=entry.getKey();
            if(ws.isOpen()&&!ws.hasBufferedData()){
                for(int i=0;i<16;i++){
                    String output=entry.getValue().outgoing.poll();if(output==null)break;
                    try{ws.send(output);}catch(RuntimeException e){ws.close();break;}
                }
            }
        }
        if(ticks%5==0)try{doors();}catch(RuntimeException e){getLogger().warning("Doors: "+e.getMessage());}
        if(++ticks%20!=0)return;
        try{separate();}catch(RuntimeException e){getLogger().warning("Separation: "+e.getMessage());}
        try{rides();}catch(RuntimeException e){getLogger().warning("Rides: "+e.getMessage());}
        // Ferries: a trip blocked by water becomes a boat crossing (2.23.0).
        if(ticks%2==0)try{keepDry();}catch(RuntimeException e){getLogger().warning("Dry: "+e.getMessage());}
        try{ferries();for(Actor a:new ArrayList<>(actors.values())){GlobalNavigation g=navs.get(a.id);if(g!=null){Location fg=g.takeFailedGoal();if(fg!=null)tryFerry(a,fg);}}}catch(RuntimeException e){getLogger().warning("Ferries: "+e.getMessage());}
        if(placedDirty&&ticks%200==0)savePlaced();
        if(damageDirty&&ticks%200==0)saveDamage();
        if(ticks%100==0)try{penDoors();}catch(RuntimeException e){getLogger().warning("Pen doors: "+e.getMessage());}
        if(markers!=null)try{
            List<MapMarkers.Citizen> list=new ArrayList<>();
            for(Actor a:actors.values())if(a.npc.isSpawned()){Location l=a.npc.getEntity().getLocation();
                list.add(new MapMarkers.Citizen(a.id,a.npc.getName(),l.getX(),l.getY(),l.getZ(),a.status.split("\n")[0],a.thinking,a.thought));}
            markers.citizens(list);
        }catch(RuntimeException e){getLogger().warning("Map markers: "+e.getMessage());}
        if(inventoryDirty&&ticks%200==0)saveInventories();
        // Any agent outside the always-loaded town area keeps a 5x5 block of chunks around it loaded.
        for(Actor a:actors.values()){
            Set<Long> want=new HashSet<>();
            if(a.npc.isSpawned()&&a.owner!=null){
                Location l=a.npc.getEntity().getLocation();
                if(l.getWorld()!=origin.getWorld()||l.distanceSquared(origin)>Math.pow(loadedRadius()-8,2))
                    for(int dx=-2;dx<=2;dx++)for(int dz=-2;dz<=2;dz++)want.add((((long)((l.getBlockX()>>4)+dx))<<32)|(((l.getBlockZ()>>4)+dz)&0xffffffffL));
            }
            World w=origin.getWorld();
            for(Iterator<Long> it=a.tickets.iterator();it.hasNext();){long k=it.next();if(!want.contains(k)){w.removePluginChunkTicket((int)(k>>32),(int)k,this);it.remove();}}
            for(long k:want)if(a.tickets.add(k))w.addPluginChunkTicket((int)(k>>32),(int)k,this);
        }
        if(ticks%100==0)for(Map.Entry<String,List<String>> e:pets.entrySet()){
            Actor owner=actors.get(e.getKey());if(owner==null||!owner.npc.isSpawned())continue;
            Location at=owner.npc.getEntity().getLocation();
            for(String id:e.getValue()){
                Entity pet=Bukkit.getEntity(UUID.fromString(id));
                if(!(pet instanceof Mob mob)||pet.getWorld()!=at.getWorld())continue;
                double d=pet.getLocation().distanceSquared(at);
                if(d>24*24)pet.teleport(at.clone().add(1,0,1));
                else if(d>6*6)mob.getPathfinder().moveTo(at,1.2);
            }
        }
        long now=System.currentTimeMillis();
        Iterator<Actor> it=actors.values().iterator();
        while(it.hasNext()){
            Actor actor=it.next();
            if(actor.owner!=null&&!actor.owner.isOpen()){
                actor.owner=null;actor.detached=now;actor.npc.getNavigator().cancelNavigation();
            }
            if(actor.owner==null&&now-actor.detached>60000){navs.remove(actor.id);if(leases!=null)leases.release("nav:"+actor.id);actor.npc.destroy();it.remove();continue;}
            if(actor.owner!=null&&!actor.npc.isSpawned()){
                // A vulnerable agent fell: respawn it at its spawn spot after 20 seconds.
                if(actor.deadSince==0){actor.deadSince=now;event("action",Map.of("agent",actor.id,"action","fell","result","respawning in 20s"));}
                else if(now-actor.deadSince>20000&&actor.npc.spawn(spawnPoint(actor.id))){actor.deadSince=0;applyHeld(actor);applyArmor(actor);event("action",Map.of("agent",actor.id,"action","respawned","result","ok"));}
            }
            if(actor.npc.isSpawned()){
                pickUp(actor);
                Location current=actor.npc.getEntity().getLocation();
                if(actor.lastPosition!=null&&current.getWorld()==actor.lastPosition.getWorld()&&current.distanceSquared(actor.lastPosition)>0.04)
                    event("movement",Map.of("agent",actor.id,"position",position(current)));
                actor.lastPosition=current;
            }
        }
        for(Map.Entry<WebSocket,Client> entry:clients.entrySet()){
            WebSocket ws=entry.getKey();
            List<Object> views=new ArrayList<>();
            for(Actor actor:actors.values())if(actor.owner==ws&&actor.npc.isSpawned())views.add(snapshot(actor));
            if(!views.isEmpty())send(ws,Map.of("type","snapshot","seq",++seq,"time",now,"worldTime",origin.getWorld().getTime(),"agents",views,
                "weather",Map.of("storm",origin.getWorld().hasStorm(),"thunder",origin.getWorld().isThundering()),
                // Where agents may go: the world border, the height limits and the dimension (agent-core/intel/executor.mjs).
                "world",Map.of("border",Map.of("x",origin.getWorld().getWorldBorder().getCenter().getX(),"z",origin.getWorld().getWorldBorder().getCenter().getZ(),"size",origin.getWorld().getWorldBorder().getSize()),
                    "minY",origin.getWorld().getMinHeight(),"maxY",origin.getWorld().getMaxHeight(),"dimension",origin.getWorld().getEnvironment().name())));
        }
    }

    private final class Server extends WebSocketServer {
        private final byte[] authorization;
        Server(InetSocketAddress address,String token){super(address,2,List.of(new Draft_6455(Collections.emptyList(),16384)));authorization=("Bearer "+token).getBytes(StandardCharsets.UTF_8);}
        @Override public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(WebSocket ws,Draft draft,ClientHandshake request)throws InvalidDataException{
            if(!MessageDigest.isEqual(authorization,request.getFieldValue("Authorization").getBytes(StandardCharsets.UTF_8)))throw new InvalidDataException(1008,"Unauthorized");
            if(clients.size()>=8)throw new InvalidDataException(1013,"Too many clients");
            return super.onWebsocketHandshakeReceivedAsServer(ws,draft,request);
        }
        @Override public void onOpen(WebSocket ws,ClientHandshake request){clients.put(ws,new Client());send(ws,Map.of("type","hello","protocol",1));}
        @Override public void onMessage(WebSocket ws,String text){
            Client client=clients.get(ws);if(client==null)return;
            synchronized(client){
                long now=System.currentTimeMillis();if(now-client.window>1000){client.window=now;client.requests=0;}
                if(++client.requests>20||text.length()>8192||queued.get()>200){ws.close(1008,"Request limit");return;}
            }
            enqueue(()->handle(ws,client,text));
        }
        @Override public void onClose(WebSocket ws,int code,String reason,boolean remote){clients.remove(ws);}
        @Override public void onError(WebSocket ws,Exception error){getLogger().warning("WebSocket: "+error.getMessage());}
        @Override public void onStart(){getLogger().info("SIDLocal listening on "+getAddress());}
    }

    private void send(WebSocket ws,Object value){sendText(ws,JSON.toJson(value));}
    private void sendText(WebSocket ws,String text){
        if(!ws.isOpen())return;
        Client client=clients.get(ws);if(client==null)return;
        if(client.outgoing.size()>=128){ws.close(1013,"Slow consumer; reconnect for snapshot");return;}
        client.outgoing.add(text);
    }
    private void handle(WebSocket ws,Client client,String text){
        String id="";
        try{
            JsonObject message=JsonParser.parseString(text).getAsJsonObject();
            id=string(message,"id",64);
            if(client.replies.containsKey(id)){sendText(ws,client.replies.get(id));return;}
            Object result;
            switch(string(message,"type",32)){
                case "subscribe" -> {
                    client.events.clear();
                    for(JsonElement item:message.getAsJsonArray("events")){
                        String event=item.getAsString();if(Set.of("chat","movement","block","entity","action","trade","command","player","vandalism","damage").contains(event))client.events.add(event);
                    }
                    result=Map.of("subscribed",true,"build",getConfig().getBoolean("allow-build"),
                        "materials",buildable.stream().map(Material::name).sorted().toList(),
                        "mineMaxY",getConfig().getInt("mine-max-y",50),"mineShafts",getConfig().getMapList("mine-shafts"));
                }
                case "session" -> {
                    String agent=string(message,"agent",32);
                    if(!allowed.contains(agent))throw new IllegalArgumentException("Agent not allowlisted");
                    Actor actor=actors.get(agent);
                    if(actor!=null&&actor.owner!=null&&actor.owner!=ws&&actor.owner.isOpen())throw new IllegalArgumentException("Agent already owned");
                    if(actor!=null&&!actor.npc.isSpawned()){actor.npc.destroy();actors.remove(agent);actor=null;}
                    if(actor==null){
                        if(actors.size()>=getConfig().getInt("max-agents",12))throw new IllegalArgumentException("Agent limit");
                        NPC npc=registry.createNPC(EntityType.PLAYER,getConfig().getString("display-names."+agent,"SID_"+agent));
                        // No skin downloads: use the deterministic default skin.
                        SkinTrait skin=npc.getOrAddTrait(SkinTrait.class);
                        skin.setFetchDefaultSkin(false);
                        skin.setShouldUpdateSkins(false);
                        npc.setProtected(!getConfig().getStringList("vulnerable-agents").contains(agent));
                        // Citizens pass through each other (and players) instead of shoving: two meeting in a narrow
                        // doorway used to push each other aside, re-route and meet again - circling in the door.
                        npc.data().setPersistent(NPC.Metadata.COLLIDABLE,false);
                        // Citizens' A* pathfinder with the door examiner: agents open and walk through doors.
                        npc.getNavigator().getDefaultParameters().range(32).speedModifier(1.0f).avoidWater(true).useNewPathfinder(true).examiner(new ObstacleExaminer());
                        applyTraits(agent,npc);
                        if(!npc.spawn(spawnPoint(agent))){npc.destroy();throw new IllegalStateException("NPC spawn failed");}
                        actor=new Actor(agent,npc,ws);actors.put(agent,actor);
                        if(!inventories.containsKey(agent)){
                            Map<String,Integer> kit=new TreeMap<>();
                            for(String entry:getConfig().getStringList("starter-items."+agent)){
                                String[] part=entry.split(":");Material m=Material.matchMaterial(part[0].trim());
                                if(m!=null&&m.isItem())kit.merge(m.name(),part.length>1?Math.max(1,Integer.parseInt(part[1].trim())):1,Integer::sum);
                            }
                            inventories.put(agent,kit);inventoryDirty=true;
                            // Tools first (a miner should start with its pickaxe), otherwise a weapon.
                            kit.keySet().stream().filter(k->k.endsWith("_PICKAXE")).findFirst().or(()->kit.keySet().stream().filter(WEAPON_DAMAGE::containsKey).findFirst()).ifPresent(w->held.put(agent,w));
                        }
                        for(String entry:getConfig().getStringList("grant-once."+agent)){
                            String[] part=entry.split(":");Material m=Material.matchMaterial(part[0].trim());
                            if(m==null||!granted.add(agent+":"+m.name()))continue;
                            inventories.computeIfAbsent(agent,k->new TreeMap<>()).merge(m.name(),part.length>1?Integer.parseInt(part[1].trim()):1,Integer::sum);
                            String slot=armorSlot(m.name());if(slot!=null)armor.computeIfAbsent(agent,k->new HashMap<>()).put(slot,m.name());
                            inventoryDirty=true;
                        }
                        applyHeld(actor);applyArmor(actor);
                    }
                    actor.owner=ws;actor.detached=0;
                    result=Map.of("agent",agent,"uuid",actor.npc.getEntity().getUniqueId().toString());
                }
                case "action" -> {
                    Actor actor=actors.get(string(message,"agent",32));
                    if(actor==null||actor.owner!=ws||!actor.npc.isSpawned())throw new IllegalArgumentException("No owned active session");
                    if(System.currentTimeMillis()-actor.lastAction<250)throw new IllegalArgumentException("Action rate exceeded");
                    actor.lastAction=System.currentTimeMillis();
                    result=act(actor,message.getAsJsonObject("action"));
                }
                default -> throw new IllegalArgumentException("Unknown request");
            }
            reply(ws,client,id,true,result,"");
        }catch(RuntimeException error){reply(ws,client,id,false,"",Objects.toString(error.getMessage(),"Invalid request"));}
    }
    private void reply(WebSocket ws,Client client,String id,boolean ok,Object result,String error){
        String text=JSON.toJson(Map.of("type","ack","id",id,"ok",ok,"result",result,"error",error));
        if(!id.isBlank()){
            client.replies.put(id,text);
            while(client.replies.size()>128)client.replies.remove(client.replies.keySet().iterator().next());
        }
        sendText(ws,text);
    }
    private static String string(JsonObject object,String key,int max){
        JsonElement value=object.get(key);
        if(value==null||!value.isJsonPrimitive()||!value.getAsJsonPrimitive().isString())throw new IllegalArgumentException("Missing string: "+key);
        String text=value.getAsString();if(text.length()>max)throw new IllegalArgumentException("Too long: "+key);return text;
    }
    private static double number(JsonObject object,String key){
        double value=object.get(key).getAsDouble();if(!Double.isFinite(value))throw new IllegalArgumentException("Nonfinite coordinate");return value;
    }
    private double radiusFor(Actor actor){
        if(roamRadius()<=0)return Double.POSITIVE_INFINITY;
        return getConfig().getStringList("expedition-agents").contains(actor.id)?Math.max(getConfig().getDouble("roam-radius",128),getConfig().getDouble("expedition-radius",150)):getConfig().getDouble("roam-radius",128);
    }
    private Location target(Actor actor,JsonObject action,double range){
        Location here=actor.npc.getEntity().getLocation();
        Location target=new Location(here.getWorld(),number(action,"x"),number(action,"y"),number(action,"z"));
        double radius=radiusFor(actor);
        if(target.getY()<here.getWorld().getMinHeight()||target.getY()>=here.getWorld().getMaxHeight()
            ||Math.abs(target.getX())>29999984||Math.abs(target.getZ())>29999984
            ||here.distanceSquared(target)>range*range||origin.distanceSquared(target)>radius*radius
            ||!target.getWorld().getWorldBorder().isInside(target))throw new IllegalArgumentException("Target outside allowed range");
        if(!target.getWorld().isChunkLoaded(target.getBlockX()>>4,target.getBlockZ()>>4))throw new IllegalArgumentException("Target chunk not loaded");
        return target;
    }
    private static String key(Block block){return block.getWorld().getName()+"|"+block.getX()+"|"+block.getY()+"|"+block.getZ();}
    private Block buildTarget(Actor actor,JsonObject action){
        if(!getConfig().getBoolean("allow-build"))throw new IllegalArgumentException("Building disabled");
        long now=System.currentTimeMillis();
        if(now-actor.buildWindow>60000){actor.buildWindow=now;actor.built=0;}
        if(++actor.built>getConfig().getInt("build-per-minute",60))throw new IllegalArgumentException("Build rate exceeded; wait a minute");
        return target(actor,action,getConfig().getDouble("build-reach",6)).getBlock();
    }
    private boolean inZone(Block block,String path){
        for(Map<?,?> zone:getConfig().getMapList(path)){
            int x1=((Number)zone.get("x1")).intValue(),x2=((Number)zone.get("x2")).intValue(),z1=((Number)zone.get("z1")).intValue(),z2=((Number)zone.get("z2")).intValue();
            // Optional height limits (excavation sites carry y1/y2; the old mine shafts do not).
            if(zone.get("y1") instanceof Number y1&&(block.getY()<y1.intValue()||block.getY()>((Number)zone.get("y2")).intValue()))continue;
            if(block.getX()>=Math.min(x1,x2)&&block.getX()<=Math.max(x1,x2)&&block.getZ()>=Math.min(z1,z2)&&block.getZ()<=Math.max(z1,z2))return true;
        }
        return false;
    }
    /** Shared checks for mine/tend: reach, community area, loaded chunk and a per-minute budget. */
    private Block workTarget(Actor actor,JsonObject action){
        long now=System.currentTimeMillis();
        if(now-actor.buildWindow>60000){actor.buildWindow=now;actor.built=0;}
        if(++actor.built>getConfig().getInt("build-per-minute",60))throw new IllegalArgumentException("Work rate exceeded; wait a minute");
        return target(actor,action,getConfig().getDouble("build-reach",6)).getBlock();
    }
    private int count(String agent,Material item){return inventories.getOrDefault(agent,Map.of()).getOrDefault(item.name(),0);}
    private boolean take(String agent,Material item,int n){
        Map<String,Integer> inventory=inventories.computeIfAbsent(agent,k->new TreeMap<>());
        if(inventory.getOrDefault(item.name(),0)<n)return false;
        inventory.merge(item.name(),-n,Integer::sum);inventory.remove(item.name(),0);inventoryDirty=true;
        if(!inventory.containsKey(item.name())&&item.name().equals(held.get(agent))){held.remove(agent);Actor actor=actors.get(agent);if(actor!=null)applyHeld(actor);}
        if(!inventory.containsKey(item.name())&&armor.getOrDefault(agent,Map.of()).containsValue(item.name())){armor.get(agent).values().remove(item.name());Actor actor=actors.get(agent);if(actor!=null)applyArmor(actor);}
        return true;
    }
    /** Adds to the agent inventory; with 36 different items already carried, the stack is dropped at its feet. */
    private void addOrDrop(Actor actor,ItemStack stack){
        Map<String,Integer> inventory=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
        if(inventory.size()>=36&&!inventory.containsKey(stack.getType().name())){actor.npc.getEntity().getWorld().dropItemNaturally(actor.npc.getEntity().getLocation(),stack);return;}
        inventory.merge(stack.getType().name(),stack.getAmount(),Integer::sum);inventoryDirty=true;
    }
    /** Crafts one result using any known shaped/shapeless recipe whose ingredients the agent carries. */
    private boolean craftOnce(Actor actor,Material item){
        for(Recipe recipe:Bukkit.getRecipesFor(new ItemStack(item))){
            List<RecipeChoice> slots=new ArrayList<>();
            if(recipe instanceof ShapedRecipe shaped){
                for(String row:shaped.getShape())for(char c:row.toCharArray()){RecipeChoice choice=shaped.getChoiceMap().get(c);if(choice!=null)slots.add(choice);}
            }else if(recipe instanceof ShapelessRecipe shapeless)slots.addAll(shapeless.getChoiceList());
            else continue;
            Map<String,Integer> spare=new TreeMap<>(inventories.getOrDefault(actor.id,Map.of()));
            Map<Material,Integer> use=new HashMap<>();boolean ok=true;
            for(RecipeChoice choice:slots){
                List<Material> options=choice instanceof RecipeChoice.MaterialChoice m?m.getChoices():choice instanceof RecipeChoice.ExactChoice e?e.getChoices().stream().map(ItemStack::getType).toList():List.of();
                Material pick=options.stream().filter(m->spare.getOrDefault(m.name(),0)>0).findFirst().orElse(null);
                if(pick==null){ok=false;break;}
                spare.merge(pick.name(),-1,Integer::sum);use.merge(pick,1,Integer::sum);
            }
            if(!ok)continue;
            for(Map.Entry<Material,Integer> e:use.entrySet())take(actor.id,e.getKey(),e.getValue());
            addOrDrop(actor,recipe.getResult().clone());
            return true;
        }
        return false;
    }
    /** Each agent gets its own spot on a ring around spawn, standing on the ground, instead of one shared block. */
    private Location spawnPoint(String agent){
        List<String> ids=getConfig().getStringList("allowed-agents");
        int index=Math.max(0,ids.indexOf(agent)),count=Math.max(1,ids.size());
        double angle=2*Math.PI*index/count,radius=getConfig().getDouble("spawn-spread",4);
        Location spot=origin.clone().add(Math.cos(angle)*radius,0,Math.sin(angle)*radius);
        if(!spot.getWorld().isChunkLoaded(spot.getBlockX()>>4,spot.getBlockZ()>>4))return origin.clone();
        Block ground=spot.getWorld().getHighestBlockAt(spot.getBlockX(),spot.getBlockZ(),HeightMap.MOTION_BLOCKING_NO_LEAVES);
        return new Location(spot.getWorld(),spot.getBlockX()+0.5,ground.getY()+1,spot.getBlockZ()+0.5);
    }
    private void say(Actor actor,String text){
        Entity body=actor.npc.getEntity();
        Component message=Component.text("["+actor.id+"] "+text);
        for(Player player:body.getWorld().getPlayers())if(player.getLocation().distanceSquared(body.getLocation())<=4096)player.sendMessage(message);
    }
    private static String pretty(Material m){String n=m.name().toLowerCase().replace('_',' ');return Character.toUpperCase(n.charAt(0))+n.substring(1);}
    private static int tier(String item){for(int i=0;i<TIERS.size();i++)if(item.startsWith(TIERS.get(i)+"_"))return i;return -1;}
    private static String kind(String item){for(String k:TOOL_KINDS)if(item.endsWith("_"+k))return k;return null;}
    /** Equip a received tool or weapon if the agent holds nothing, or holds a lower tier of the same kind. */
    private boolean maybeEquip(Actor actor,Material item){
        String incoming=item.name(),current=held.get(actor.id);
        if(kind(incoming)==null)return false;
        if(current!=null&&!(incoming.endsWith("_"+kind(current))&&tier(incoming)>tier(current)))return false;
        held.put(actor.id,incoming);inventoryDirty=true;applyHeld(actor);return true;
    }
    /** Trade value: configured base prices, otherwise derived from crafting/smelting recipes, else 1. */
    private double value(Material item){return value(item,new HashSet<>());}
    private double value(Material item,Set<Material> visiting){
        Double live=priceOverride.get(item.name());if(live!=null)return live;
        Double cached=valueCache.get(item);if(cached!=null)return cached;
        double base=getConfig().getDouble("trade-values."+item.name(),-1);
        if(base>=0){valueCache.put(item,base);return base;}
        if(!visiting.add(item)||visiting.size()>6)return Double.POSITIVE_INFINITY;
        double best=Double.POSITIVE_INFINITY;
        for(Recipe recipe:Bukkit.getRecipesFor(new ItemStack(item))){
            List<RecipeChoice> slots=new ArrayList<>();
            if(recipe instanceof ShapedRecipe shaped){for(String row:shaped.getShape())for(char c:row.toCharArray()){RecipeChoice ch=shaped.getChoiceMap().get(c);if(ch!=null)slots.add(ch);}}
            else if(recipe instanceof ShapelessRecipe shapeless)slots.addAll(shapeless.getChoiceList());
            else if(recipe instanceof FurnaceRecipe furnace)slots.add(furnace.getInputChoice());
            else continue;
            double sum=recipe instanceof FurnaceRecipe?0.2:0;
            for(RecipeChoice choice:slots){
                List<Material> options=choice instanceof RecipeChoice.MaterialChoice m?m.getChoices():choice instanceof RecipeChoice.ExactChoice e?e.getChoices().stream().map(ItemStack::getType).toList():List.of();
                sum+=options.stream().mapToDouble(o->value(o,visiting)).min().orElse(Double.POSITIVE_INFINITY);
            }
            best=Math.min(best,sum/Math.max(1,recipe.getResult().getAmount()));
        }
        visiting.remove(item);
        double result=Double.isFinite(best)?Math.round(best*100)/100.0:1.0;
        if(visiting.isEmpty())valueCache.put(item,result);
        return result;
    }
    private static ItemStack icon(Material material,int amount,String name,List<String> lore){
        ItemStack stack=new ItemStack(material,Math.max(1,Math.min(64,amount)));
        ItemMeta meta=stack.getItemMeta();
        if(name!=null)meta.displayName(Component.text(name));
        if(lore!=null)meta.lore(lore.stream().map(l->(Component)Component.text(l,NamedTextColor.GRAY)).toList());
        stack.setItemMeta(meta);return stack;
    }
    private double offerValue(TradeView view){
        double sum=0;
        for(int slot=OFFER_FIRST;slot<=OFFER_LAST;slot++){ItemStack s=view.inventory.getItem(slot);if(s!=null&&!s.getType().isAir())sum+=value(s.getType())*s.getAmount();}
        return sum;
    }
    private double wantValue(TradeView view){return view.want.entrySet().stream().mapToDouble(e->value(e.getKey())*e.getValue()).sum();}
    private double margin(Actor actor){if(actor.marginOverride>0)return actor.marginOverride;return getConfig().getDouble("trade-margin."+actor.id,getConfig().getDouble("trade-margin.default",1.0));}
    private void render(TradeView view){
        Inventory inv=view.inventory;
        for(int slot=0;slot<=35;slot++)inv.setItem(slot,null);
        for(int slot=45;slot<=53;slot++)inv.setItem(slot,null);
        int slot=0;
        for(Map.Entry<String,Integer> e:inventories.getOrDefault(view.actor.id,Map.of()).entrySet()){
            if(slot>26)break;Material m=Material.matchMaterial(e.getKey());if(m==null||!m.isItem())continue;
            inv.setItem(slot++,icon(m,e.getValue(),pretty(m),List.of("Has "+e.getValue()+" - worth "+value(m)+" each","Left-click: ask for 1","Right-click: 1 less","Shift-click: ask for a stack")));
        }
        slot=WANT_FIRST;
        for(Map.Entry<Material,Integer> e:view.want.entrySet()){
            if(slot>35)break;
            inv.setItem(slot++,icon(e.getKey(),e.getValue(),"You get: "+e.getValue()+" x "+pretty(e.getKey()),List.of("Click to remove")));
        }
        double give=offerValue(view),get=wantValue(view),need=get*margin(view.actor);
        inv.setItem(SUMMARY,icon(Material.PAPER,1,"Trade summary",List.of("You give: "+Math.round(give*10)/10.0,"You get: "+Math.round(get*10)/10.0,
            view.want.isEmpty()?"Nothing requested: this is a gift":give+1e-9>=need?view.actor.id+" will accept":"Needs about "+Math.round((need-give)*10)/10.0+" more",
            "Put your offer in the row above these buttons")));
        inv.setItem(ACCEPT,icon(Material.EMERALD_BLOCK,1,"Offer trade",List.of("Click to propose this trade")));
        inv.setItem(CANCEL,icon(Material.BARRIER,1,"Cancel",List.of("Your offer is returned")));
    }
    private void openTrade(Actor actor,Player player){
        TradeView view=new TradeView(actor,player);
        view.inventory=Bukkit.createInventory(view,54,Component.text("Trade with "+actor.id));
        render(view);player.openInventory(view.inventory);
    }
    private void completeTrade(TradeView view){
        Actor actor=view.actor;Player player=view.player;
        List<ItemStack> offer=new ArrayList<>();
        for(int slot=OFFER_FIRST;slot<=OFFER_LAST;slot++){ItemStack s=view.inventory.getItem(slot);if(s!=null&&!s.getType().isAir())offer.add(s.clone());}
        if(offer.isEmpty()&&view.want.isEmpty()){say(actor,"Put something in the offer row, or pick what you'd like.");return;}
        for(Map.Entry<Material,Integer> e:view.want.entrySet())
            if(count(actor.id,e.getKey())<e.getValue()){say(actor,"Sorry, I don't have "+e.getValue()+" "+pretty(e.getKey())+" any more.");view.want.remove(e.getKey());render(view);return;}
        double give=offerValue(view),get=wantValue(view),need=get*margin(actor);
        if(give+1e-9<need){say(actor,"That's worth "+Math.round(give*10)/10.0+" and you're asking for "+Math.round(get*10)/10.0+". Add about "+Math.round((need-give)*10)/10.0+" more?");return;}
        // Room for the offer (2.24.0): a pack of 36 kinds cannot take a new kind - the trade is turned down instead of the
        // item being dropped on the ground (an anvil handed to Bram vanished that way).
        {Map<String,Integer> inv=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
         Set<String> fresh=new TreeSet<>();for(ItemStack s:offer)if(!inv.containsKey(s.getType().name()))fresh.add(s.getType().name());
         int freed=0;for(Map.Entry<Material,Integer> e:view.want.entrySet())if(inv.getOrDefault(e.getKey().name(),0)<=e.getValue())freed++;
         if(inv.size()-freed+fresh.size()>36){
             say(actor,"Sorry "+player.getName()+", my pack is full - I can't carry "+String.join(", ",fresh.stream().map(n->n.toLowerCase().replace('_',' ')).toList())+". Please put it in the warehouse drop box and it will reach me.");
             return;}}
        for(Map.Entry<Material,Integer> e:view.want.entrySet()){
            take(actor.id,e.getKey(),e.getValue());
            for(ItemStack over:player.getInventory().addItem(new ItemStack(e.getKey(),e.getValue())).values())player.getWorld().dropItemNaturally(player.getLocation(),over);
        }
        List<String> equipped=new ArrayList<>();
        for(ItemStack s:offer){addOrDrop(actor,s);if(maybeEquip(actor,s.getType()))equipped.add(pretty(s.getType()));}
        for(int slot=OFFER_FIRST;slot<=OFFER_LAST;slot++)view.inventory.setItem(slot,null);
        view.done=true;player.closeInventory();
        Map<String,Integer> gave=new TreeMap<>(),got=new TreeMap<>();
        offer.forEach(s->gave.merge(s.getType().name(),s.getAmount(),Integer::sum));
        view.want.forEach((m,n)->got.put(m.name(),n));
        say(actor,view.want.isEmpty()?"Thank you, "+player.getName()+"! That's very kind."+(equipped.isEmpty()?"":" I'll use the "+String.join(", ",equipped)+" right away."):"Deal, "+player.getName()+"! Pleasure trading with you."+(equipped.isEmpty()?"":" Equipped the "+String.join(", ",equipped)+"."));
        event("trade",Map.of("kind","traded","agent",actor.id,"player",player.getName(),"received",gave,"gave",got));
    }
    private Actor actorFor(Entity entity){for(Actor a:actors.values())if(a.npc.isSpawned()&&a.npc.getEntity().equals(entity))return a;return null;}
    @EventHandler(priority=EventPriority.HIGH)
    public void rightClick(PlayerInteractEntityEvent e){
        if(e.getHand()!=EquipmentSlot.HAND)return;
        Actor actor=actorFor(e.getRightClicked());if(actor==null)return;
        e.setCancelled(true);
        Player player=e.getPlayer();ItemStack hand=player.getInventory().getItemInMainHand();
        if(player.isSneaking()&&isShopkeeper(actor.id)&&hand.getType().isAir()){openPanel(actor,player);return;}   // a shopkeeper's own panel
        if(player.isSneaking()){
            Map<String,Integer> inv=inventories.getOrDefault(actor.id,Map.of());
            player.sendMessage(Component.text("== "+actor.id+" ==",NamedTextColor.GOLD));
            if(!actor.status.isBlank())player.sendMessage(Component.text(actor.status,NamedTextColor.YELLOW));
            player.sendMessage(Component.text("Holding: "+held.getOrDefault(actor.id,"nothing").toLowerCase().replace('_',' '),NamedTextColor.GRAY));
            player.sendMessage(Component.text("Carrying: "+(inv.isEmpty()?"nothing":inv.entrySet().stream().map(x->x.getValue()+" "+x.getKey().toLowerCase().replace('_',' ')).reduce((a,b)->a+", "+b).orElse("")),NamedTextColor.GRAY));
            player.sendMessage(Component.text("Right-click empty-handed for their panel (inventory, trade, orders), or with an item to give it.",NamedTextColor.DARK_GRAY));
            return;
        }
        if(hand.getType().isAir()){
            // The trader (2.27.0): right-click opens his market (sneak + right-click: his citizen panel; an empty market
            // opens the panel too).
            if(isShopkeeper(actor.id)&&!shopStock(actor.id).isEmpty()){openShop(actor,player);return;}
            openPanel(actor,player);return;
        }
        ItemStack gift=hand.clone();
        Map<String,Integer> inventory=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
        if(inventory.size()>=36&&!inventory.containsKey(gift.getType().name())){say(actor,"My pockets are full, sorry!");return;}
        player.getInventory().setItemInMainHand(null);
        addOrDrop(actor,gift);
        boolean equipped=maybeEquip(actor,gift.getType());
        if(actor.npc.getEntity() instanceof LivingEntity living)living.swingMainHand();
        say(actor,"Thank you for the "+(gift.getAmount()>1?gift.getAmount()+" ":"")+pretty(gift.getType())+", "+player.getName()+"!"+(equipped?" Equipped it.":""));
        event("trade",Map.of("kind","received","agent",actor.id,"from",player.getName(),"item",gift.getType().name(),"count",gift.getAmount(),"equipped",equipped));
    }
    @EventHandler(priority=EventPriority.HIGH)
    public void tradeClick(InventoryClickEvent e){
        if(!(e.getView().getTopInventory().getHolder() instanceof TradeView view))return;
        InventoryAction action=e.getAction();int raw=e.getRawSlot();
        if(action==InventoryAction.COLLECT_TO_CURSOR){e.setCancelled(true);return;}
        if(raw>=54){
            // Shift-click from the player's inventory goes into the offer row only.
            if(action==InventoryAction.MOVE_TO_OTHER_INVENTORY){
                e.setCancelled(true);ItemStack moving=e.getCurrentItem();if(moving==null)return;
                for(int slot=OFFER_FIRST;slot<=OFFER_LAST;slot++)if(view.inventory.getItem(slot)==null){view.inventory.setItem(slot,moving.clone());e.setCurrentItem(null);break;}
                Bukkit.getScheduler().runTask(this,()->render(view));
            }
            return;
        }
        if(raw>=OFFER_FIRST&&raw<=OFFER_LAST){
            if(!Set.of(InventoryAction.PLACE_ALL,InventoryAction.PLACE_ONE,InventoryAction.PLACE_SOME,InventoryAction.PICKUP_ALL,InventoryAction.PICKUP_HALF,
                InventoryAction.PICKUP_ONE,InventoryAction.PICKUP_SOME,InventoryAction.SWAP_WITH_CURSOR,InventoryAction.MOVE_TO_OTHER_INVENTORY).contains(action))e.setCancelled(true);
            Bukkit.getScheduler().runTask(this,()->render(view));
            return;
        }
        e.setCancelled(true);
        if(raw<=26){
            ItemStack clicked=e.getCurrentItem();if(clicked==null)return;
            Material m=clicked.getType();int has=count(view.actor.id,m),now=view.want.getOrDefault(m,0);
            int next=e.isShiftClick()?Math.min(has,now+64):e.isRightClick()?now-1:Math.min(has,now+1);
            if(next<=0)view.want.remove(m);else if(view.want.size()<9||view.want.containsKey(m))view.want.put(m,next);
        }else if(raw<=35){
            ItemStack clicked=e.getCurrentItem();if(clicked!=null)view.want.remove(clicked.getType());
        }else if(raw==ACCEPT){completeTrade(view);if(view.done)return;}
        else if(raw==CANCEL){view.player.closeInventory();return;}
        render(view);
    }
    @EventHandler(priority=EventPriority.HIGH)
    public void tradeDrag(InventoryDragEvent e){
        if(!(e.getView().getTopInventory().getHolder() instanceof TradeView view))return;
        for(int raw:e.getRawSlots())if(raw<54&&(raw<OFFER_FIRST||raw>OFFER_LAST)){e.setCancelled(true);return;}
        Bukkit.getScheduler().runTask(this,()->render(view));
    }
    @EventHandler
    public void tradeClose(InventoryCloseEvent e){
        if(!(e.getInventory().getHolder() instanceof TradeView view))return;
        for(int slot=OFFER_FIRST;slot<=OFFER_LAST;slot++){
            ItemStack s=view.inventory.getItem(slot);if(s==null||s.getType().isAir())continue;
            view.inventory.setItem(slot,null);
            for(ItemStack over:view.player.getInventory().addItem(s).values())view.player.getWorld().dropItemNaturally(view.player.getLocation(),over);
        }
    }
    private static String armorSlot(String item){for(String slot:ARMOR_SLOTS)if(item.endsWith("_"+slot))return slot;return null;}
    private void applyArmor(Actor actor){
        Equipment eq=actor.npc.getOrAddTrait(Equipment.class);Map<String,String> worn=armor.getOrDefault(actor.id,Map.of());
        eq.set(Equipment.EquipmentSlot.HELMET,worn.containsKey("HELMET")?new ItemStack(Material.valueOf(worn.get("HELMET"))):null);
        eq.set(Equipment.EquipmentSlot.CHESTPLATE,worn.containsKey("CHESTPLATE")?new ItemStack(Material.valueOf(worn.get("CHESTPLATE"))):null);
        eq.set(Equipment.EquipmentSlot.LEGGINGS,worn.containsKey("LEGGINGS")?new ItemStack(Material.valueOf(worn.get("LEGGINGS"))):null);
        eq.set(Equipment.EquipmentSlot.BOOTS,worn.containsKey("BOOTS")?new ItemStack(Material.valueOf(worn.get("BOOTS"))):null);
        String colour=getConfig().getString("uniforms."+actor.id,"");
        if(colour.matches("#?[0-9a-fA-F]{6}")){
            Color c=Color.fromRGB(Integer.parseInt(colour.replace("#",""),16));
            if(!worn.containsKey("CHESTPLATE"))eq.set(Equipment.EquipmentSlot.CHESTPLATE,dyed(Material.LEATHER_CHESTPLATE,c));
            if(!worn.containsKey("LEGGINGS"))eq.set(Equipment.EquipmentSlot.LEGGINGS,dyed(Material.LEATHER_LEGGINGS,c));
            if(!worn.containsKey("BOOTS"))eq.set(Equipment.EquipmentSlot.BOOTS,dyed(Material.LEATHER_BOOTS,c));
        }
    }
    private static ItemStack dyed(Material piece,Color colour){ItemStack s=new ItemStack(piece);if(s.getItemMeta() instanceof LeatherArmorMeta m){m.setColor(colour);s.setItemMeta(m);}return s;}
    /** Chests that agents placed; the only containers agents may use (never players' own chests). */
    // ---------- the bank vault (runtime: agent-core/skills/banking.mjs) ----------
    // Emeralds held for citizens' accounts and the town's tax reserves: in the chests inside the bank's vault box
    // (config bank-vault-box: x,y,z,width,height,depth) or, before the bank stands, in a strongbox kept with the
    // agent inventories under the key "bank-vault". Minting is capped per real day (bank-mint-per-day).
    private static final String STRONGBOX="bank-vault";
    private boolean inVault(int x,int y,int z){
        List<Integer> b=getConfig().getIntegerList("bank-vault-box");
        return b.size()==6&&x>=b.get(0)&&x<b.get(0)+b.get(3)&&y>=b.get(1)&&y<b.get(1)+b.get(4)&&z>=b.get(2)&&z<b.get(2)+b.get(5);
    }
    private List<Chest> vaultChests(World world){
        List<Integer> b=getConfig().getIntegerList("bank-vault-box");List<Chest> out=new ArrayList<>();
        if(b.size()!=6)return out;
        for(int x=b.get(0);x<b.get(0)+b.get(3);x++)for(int y=b.get(1);y<b.get(1)+b.get(4);y++)for(int z=b.get(2);z<b.get(2)+b.get(5);z++){
            if(!world.isChunkLoaded(x>>4,z>>4))continue;
            if(world.getBlockAt(x,y,z).getState() instanceof Chest chest){
                if(chest.getBlockData() instanceof org.bukkit.block.data.type.Chest half&&half.getType()==org.bukkit.block.data.type.Chest.Type.RIGHT)continue;
                out.add(chest);
            }
        }
        return out;
    }
    private int vaultCount(List<Chest> chests){
        if(chests.isEmpty())return count(STRONGBOX,Material.EMERALD);
        int n=0;for(Chest c:chests)for(ItemStack i:c.getInventory().getContents())if(i!=null&&i.getType()==Material.EMERALD)n+=i.getAmount();
        return n;
    }
    /** Puts n emeralds in the vault; returns how many did not fit. */
    private int vaultPut(List<Chest> chests,int n){
        if(chests.isEmpty()){inventories.computeIfAbsent(STRONGBOX,k->new TreeMap<>()).merge("EMERALD",n,Integer::sum);inventoryDirty=true;return 0;}
        int left=n;
        for(Chest c:chests){if(left==0)break;Map<Integer,ItemStack> over=c.getInventory().addItem(new ItemStack(Material.EMERALD,left));left=over.values().stream().mapToInt(ItemStack::getAmount).sum();}
        return left;
    }
    private void vaultTake(List<Chest> chests,int n){
        if(chests.isEmpty()){take(STRONGBOX,Material.EMERALD,n);return;}
        int left=n;for(Chest c:chests){if(left==0)break;int here=0;for(ItemStack i:c.getInventory().getContents())if(i!=null&&i.getType()==Material.EMERALD)here+=i.getAmount();
            int t=Math.min(here,left);if(t>0){c.getInventory().removeItem(new ItemStack(Material.EMERALD,t));left-=t;}}
    }
    /** A chest of any kind (plain, trapped, the copper chests and their weathered/waxed forms), never an ender chest. */
    static boolean chestLike(Material m){String n=m.name();return n.endsWith("CHEST")&&!n.equals("ENDER_CHEST");}
    private List<org.bukkit.block.Container> warehouseChests(){
        List<org.bukkit.block.Container> out=new ArrayList<>();Set<String> doubles=new HashSet<>();
        for(Map.Entry<String,String> e:placed.entrySet()){
            if(!e.getValue().equals("CHEST"))continue;
            String[] p=e.getKey().split("\\|");World w=Bukkit.getWorld(p[0]);if(w==null)continue;
            int x=Integer.parseInt(p[1]),y=Integer.parseInt(p[2]),z=Integer.parseInt(p[3]);
            if(!w.isChunkLoaded(x>>4,z>>4))continue;
            if(inVault(x,y,z))continue;   // the bank vault is not the treasury
            if(getConfig().getStringList("private-chests").contains(x+","+y+","+z))continue;   // nor is anyone's private chest
            if(isShopChest(e.getKey()))continue;      // nor a shop's stock (the trader's market, the chef's bakery)
            Block b=w.getBlockAt(x,y,z);
            if(!chestLike(b.getType())||!(b.getState() instanceof org.bukkit.block.Container chest))continue;
            // A double chest shares one inventory between its halves: list it once (by whichever half comes first).
            if(chest.getInventory().getHolder() instanceof org.bukkit.block.DoubleChest dc){
                Location mid=dc.getLocation();if(mid!=null&&!doubles.add(mid.getBlockX()*2+","+mid.getBlockY()+","+Math.round(mid.getX()*2)+","+Math.round(mid.getZ()*2)))continue;
            }
            out.add(chest);
        }
        return out;
    }
    /** A chest's label: a floating text on its front face (lines split on |) and its window title. */
    private void labelChest(Block b,String text){
        String tag="sidlabel:"+b.getX()+","+b.getY()+","+b.getZ();
        BlockFace f=b.getBlockData() instanceof org.bukkit.block.data.Directional dir?dir.getFacing():BlockFace.SOUTH;
        Location at=b.getLocation().add(0.5+f.getModX()*0.47,0.3,0.5+f.getModZ()*0.47);
        at.setYaw(switch(f){case WEST->90f;case NORTH->180f;case EAST->-90f;default->0f;});
        for(Entity e:b.getWorld().getNearbyEntities(b.getLocation().add(0.5,0.5,0.5),1.5,1.5,1.5))if(e instanceof TextDisplay&&e.getScoreboardTags().contains(tag))e.remove();
        String[] lines=text.split("\\|");
        if(b.getState() instanceof org.bukkit.block.Container c){c.customName(text.isBlank()?null:Component.text(String.join(" - ",lines)));c.update(true,false);}
        if(text.isBlank())return;
        Component shown=Component.text(lines[0],NamedTextColor.GOLD);
        for(int i=1;i<lines.length;i++)shown=shown.append(Component.newline()).append(Component.text(lines[i],NamedTextColor.WHITE));
        final Component label=shown;
        b.getWorld().spawn(at,TextDisplay.class,d->{
            d.text(label);d.setBillboard(org.bukkit.entity.Display.Billboard.FIXED);d.setLineWidth(90);
            d.setBackgroundColor(Color.fromARGB(150,0,0,0));d.setShadowed(false);
            d.setTransformation(new org.bukkit.util.Transformation(new org.joml.Vector3f(),new org.joml.AxisAngle4f(),new org.joml.Vector3f(0.3f,0.3f,0.3f),new org.joml.AxisAngle4f()));
            d.addScoreboardTag(tag);d.addScoreboardTag("sidlabel");d.setPersistent(true);
        });
    }
    // ---- The trader's market (2.27.0): stock chests in the market hall, sold to players through a trade window ----
    /** The market's stock chests (config market-chests, "world|x|y|z"), each double chest once. */
    /**
     * Shops (2.29.0): the trader's market (config market-chests) and the chef's bakery (config shops.chef). Each shop
     * belongs to one citizen only - Marlo's market, Antoine's bakery - and sells only from its own chests.
     */
    private static final Set<String> SHOPKEEPERS=Set.of("merchant","chef");
    private String shopKey(String agent){return agent.equals(marketAgent())?"market-chests":"shops."+agent;}
    private boolean isShopkeeper(String agent){return (SHOPKEEPERS.contains(agent)||agent.equals(marketAgent()))&&!getConfig().getStringList(shopKey(agent)).isEmpty();}
    private boolean isShopChest(String key){
        if(getConfig().getStringList("market-chests").contains(key))return true;
        org.bukkit.configuration.ConfigurationSection sec=getConfig().getConfigurationSection("shops");
        if(sec!=null)for(String a:sec.getKeys(false))if(sec.getStringList(a).contains(key))return true;
        return false;
    }
    private List<org.bukkit.block.Container> shopChests(String agent){
        List<org.bukkit.block.Container> out=new ArrayList<>();Set<Object> seen=new HashSet<>();
        for(String k:getConfig().getStringList(shopKey(agent))){
            String[] p=k.split("\\|");World w=Bukkit.getWorld(p[0]);if(w==null||p.length<4)continue;
            int x=Integer.parseInt(p[1]),y=Integer.parseInt(p[2]),z=Integer.parseInt(p[3]);
            if(!w.isChunkLoaded(x>>4,z>>4))continue;
            Block b=w.getBlockAt(x,y,z);
            if(!chestLike(b.getType())||!(b.getState() instanceof org.bukkit.block.Container chest))continue;
            Object id=chest.getInventory().getHolder() instanceof org.bukkit.block.DoubleChest dc?dc.getLocation():b.getLocation();
            if(seen.add(String.valueOf(id)))out.add(chest);
        }
        return out;
    }
    private Map<Material,Integer> shopStock(String agent){
        Map<Material,Integer> out=new LinkedHashMap<>();
        for(org.bukkit.block.Container c:shopChests(agent))for(ItemStack i:c.getInventory().getContents())if(i!=null&&!i.getType().isAir())out.merge(i.getType(),i.getAmount(),Integer::sum);
        return out;
    }
    /** Takes n of an item out of the market chests; false (nothing taken) when there are not that many. */
    private boolean takeFromShop(String agent,Material m,int n){
        if(shopStock(agent).getOrDefault(m,0)<n)return false;
        int left=n;for(org.bukkit.block.Container c:shopChests(agent)){if(left<=0)break;
            int here=Arrays.stream(c.getInventory().getContents()).filter(i->i!=null&&i.getType()==m).mapToInt(ItemStack::getAmount).sum();
            int t=Math.min(here,left);if(t>0){c.getInventory().removeItem(new ItemStack(m,t));left-=t;}}
        return true;
    }
    private String marketAgent(){return getConfig().getString("market-agent","merchant");}
    /** Open shop windows: the trade window's merchant -> the citizen selling. */
    private final Map<org.bukkit.inventory.Merchant,Actor> shops=new HashMap<>();
    /**
     * The trader's shop: everything in the market chests, bought with emeralds at the town's live prices. Cheap goods
     * come in bundles (a stack of seeds for an emerald), each offer limited to what is in stock.
     */
    private void openShop(Actor actor,Player player){
        Map<Material,Integer> stock=shopStock(actor.id);stock.remove(Material.EMERALD);
        if(stock.isEmpty()){say(actor,"My market stalls are empty right now, "+player.getName()+" - come back later!");return;}
        org.bukkit.inventory.Merchant shop=Bukkit.createMerchant(Component.text(actor.npc.getName()+(actor.id.equals("chef")?"'s Bakery":"'s Market")));
        double em=Math.max(0.01,value(Material.EMERALD)),mg=Math.max(0.1,getConfig().getDouble("market-margin",1.0));
        List<org.bukkit.inventory.MerchantRecipe> recipes=new ArrayList<>();
        for(Map.Entry<Material,Integer> e:stock.entrySet().stream().sorted((a,b)->b.getValue()-a.getValue()).limit(120).toList()){
            Material m=e.getKey();int n=e.getValue();if(!m.isItem())continue;
            double unit=value(m);if(!Double.isFinite(unit)||unit<=0)unit=1;
            int bundle=1;for(int b:new int[]{1,2,4,8,16,32,64}){if(b>m.getMaxStackSize()||b>n)break;bundle=b;if(unit*b*mg/em>=1)break;}
            int price=(int)Math.max(1,Math.min(64,Math.round(unit*bundle*mg/em)));
            int uses=n/bundle;if(uses<1)continue;
            org.bukkit.inventory.MerchantRecipe r=new org.bukkit.inventory.MerchantRecipe(new ItemStack(m,bundle),0,uses,false);
            r.addIngredient(new ItemStack(Material.EMERALD,price));recipes.add(r);
        }
        if(recipes.isEmpty()){say(actor,"Nothing for sale right now - come back later!");return;}
        shop.setRecipes(recipes);shops.put(shop,actor);
        player.openMerchant(shop,true);
        say(actor,actor.id.equals("chef")?"Welcome to my bakery, "+player.getName()+"! Fresh from the kitchen - have a look.":"Welcome to my market, "+player.getName()+"! Everything here is the town's surplus - have a look.");
    }
    @EventHandler(priority=EventPriority.HIGH,ignoreCancelled=true)
    public void marketPurchase(io.papermc.paper.event.player.PlayerPurchaseEvent e){
        if(!(e.getPlayer().getOpenInventory().getTopInventory() instanceof org.bukkit.inventory.MerchantInventory mi))return;
        Actor actor=shops.get(mi.getMerchant());if(actor==null)return;
        ItemStack got=e.getTrade().getResult();
        if(!takeFromShop(actor.id,got.getType(),got.getAmount())){e.setCancelled(true);say(actor,"Sorry, "+pretty(got.getType())+" just sold out.");return;}
        int paid=e.getTrade().getIngredients().stream().filter(i->i!=null&&i.getType()==Material.EMERALD).mapToInt(ItemStack::getAmount).sum();
        if(paid>0){addOrDrop(actor,new ItemStack(Material.EMERALD,paid));inventoryDirty=true;}
        event("trade",Map.of("kind","market_sale","agent",actor.id,"player",e.getPlayer().getName(),"item",got.getType().name(),"count",got.getAmount(),"emeralds",paid));
    }
    @EventHandler
    public void marketClose(InventoryCloseEvent e){if(e.getInventory() instanceof org.bukkit.inventory.MerchantInventory mi)shops.remove(mi.getMerchant());}

    private org.bukkit.block.Container warehouseChest(Actor actor,JsonObject action){
        Block block=target(actor,action,5).getBlock();
        if(!chestLike(block.getType())||!(block.getState() instanceof org.bukkit.block.Container chest)||!"CHEST".equals(placed.get(key(block))))throw new IllegalArgumentException("That is not a warehouse chest");
        return chest;
    }
    /** Fills a newly built warehouse chest from the one-time starter stockpile. */
    private void fillStockpile(Block block){
        if(!stockpileStarted){
            for(String entry:getConfig().getStringList("starter-stockpile")){String[] part=entry.split(":");Material m=Material.matchMaterial(part[0].trim());if(m!=null&&m.isItem())stockpileLeft.merge(m.name(),part.length>1?Integer.parseInt(part[1].trim()):1,Integer::sum);}
            stockpileStarted=true;
        }
        if(stockpileLeft.isEmpty()||!(block.getState() instanceof Chest chest))return;
        for(Iterator<Map.Entry<String,Integer>> it=stockpileLeft.entrySet().iterator();it.hasNext();){
            Map.Entry<String,Integer> e=it.next();Material m=Material.valueOf(e.getKey());int left=e.getValue();
            while(left>0){
                int n=Math.min(m.getMaxStackSize(),left);
                int over=chest.getInventory().addItem(new ItemStack(m,n)).values().stream().mapToInt(ItemStack::getAmount).sum();
                left-=n-over;if(over>0)break;
            }
            if(left<=0)it.remove();else{e.setValue(left);break;}
        }
        inventoryDirty=true;
    }
    private void applyHeld(Actor actor){
        String item=held.get(actor.id);
        actor.npc.getOrAddTrait(Equipment.class).set(Equipment.EquipmentSlot.HAND,item==null?null:new ItemStack(Material.valueOf(item)));
    }
    /** Collects items that players threw within reach of the agent; this is how players hand things over. */
    private void pickUp(Actor actor){
        Entity body=actor.npc.getEntity();
        Map<String,Integer> inventory=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
        boolean collector=getConfig().getStringList("collector-agents").contains(actor.id);
        for(Entity near:body.getNearbyEntities(2.5,1.5,2.5)){
            // The warehouse clerk picks up anything lying loose (dropped goods on the warehouse floor) to file it.
            if(collector&&near instanceof Item loose&&loose.getThrower()==null&&loose.getPickupDelay()<=0&&loose.getTicksLived()>40){
                ItemStack stack=loose.getItemStack();loose.remove();addOrDrop(actor,stack);
                event("trade",Map.of("kind","picked_up","agent",actor.id,"item",stack.getType().name(),"count",stack.getAmount()));continue;
            }
            if(near instanceof Item wild&&wild.getThrower()==null&&getConfig().getStringList("forager-agents").contains(actor.id)
                &&(Set.of("APPLE","SWEET_BERRIES","RED_MUSHROOM","BROWN_MUSHROOM","STICK","MANGROVE_PROPAGULE").contains(wild.getItemStack().getType().name())||wild.getItemStack().getType().name().endsWith("_SAPLING"))){
                ItemStack stack=wild.getItemStack();wild.remove();addOrDrop(actor,stack);continue;
            }
            if(!(near instanceof Item drop)||drop.getThrower()==null)continue;
            Player from=Bukkit.getPlayer(drop.getThrower());
            if(from==null||inventory.size()>=36&&!inventory.containsKey(drop.getItemStack().getType().name()))continue;
            ItemStack stack=drop.getItemStack();drop.remove();
            inventory.merge(stack.getType().name(),stack.getAmount(),Integer::sum);inventoryDirty=true;
            event("trade",Map.of("kind","received","agent",actor.id,"from",from.getName(),"item",stack.getType().name(),"count",stack.getAmount()));
        }
    }
    private Path inventoryFile(){return getDataFolder().toPath().resolve("agent-inventories.json");}
    private void loadInventories(){
        try{
            if(!Files.exists(inventoryFile()))return;
            JsonObject root=JsonParser.parseString(Files.readString(inventoryFile())).getAsJsonObject();
            for(Map.Entry<String,JsonElement> agent:root.getAsJsonObject("inventories").entrySet()){
                Map<String,Integer> items=new TreeMap<>();
                for(Map.Entry<String,JsonElement> item:agent.getValue().getAsJsonObject().entrySet())
                    if(Material.matchMaterial(item.getKey())!=null)items.put(item.getKey(),item.getValue().getAsInt());
                inventories.put(agent.getKey(),items);
            }
            for(Map.Entry<String,JsonElement> entry:root.getAsJsonObject("held").entrySet())held.put(entry.getKey(),entry.getValue().getAsString());
            if(root.has("crops"))for(JsonElement crop:root.getAsJsonArray("crops"))crops.add(crop.getAsString());
            if(root.has("playerPlaced"))for(JsonElement b:root.getAsJsonArray("playerPlaced"))playerPlaced.add(b.getAsString());
            if(root.has("armor"))for(Map.Entry<String,JsonElement> a:root.getAsJsonObject("armor").entrySet()){
                Map<String,String> worn=new HashMap<>();for(Map.Entry<String,JsonElement> slot:a.getValue().getAsJsonObject().entrySet())worn.put(slot.getKey(),slot.getValue().getAsString());armor.put(a.getKey(),worn);}
            if(root.has("stockpileLeft"))for(Map.Entry<String,JsonElement> e:root.getAsJsonObject("stockpileLeft").entrySet())stockpileLeft.put(e.getKey(),e.getValue().getAsInt());
            if(root.has("stockpileStarted"))stockpileStarted=root.get("stockpileStarted").getAsBoolean();
            if(root.has("granted"))for(JsonElement g:root.getAsJsonArray("granted"))granted.add(g.getAsString());
            for(String part:List.of("wear","potions"))if(root.has(part))for(Map.Entry<String,JsonElement> a:root.getAsJsonObject(part).entrySet()){
                Map<String,Integer> m=new TreeMap<>();for(Map.Entry<String,JsonElement> e:a.getValue().getAsJsonObject().entrySet())m.put(e.getKey(),e.getValue().getAsInt());
                (part.equals("wear")?wear:potions).put(a.getKey(),m);}
            if(root.has("pets"))for(Map.Entry<String,JsonElement> p:root.getAsJsonObject("pets").entrySet()){List<String> ids=new ArrayList<>();for(JsonElement id:p.getValue().getAsJsonArray())ids.add(id.getAsString());pets.put(p.getKey(),ids);}
        }catch(IOException|RuntimeException e){getLogger().warning("Could not read agent-inventories.json: "+e.getMessage());}
    }
    private void saveInventories(){
        try{
            Files.createDirectories(getDataFolder().toPath());
            Path tmp=inventoryFile().resolveSibling("agent-inventories.json.tmp");
            Map<String,Object> root=new LinkedHashMap<>();
            root.put("inventories",inventories);root.put("held",held);root.put("crops",crops);root.put("armor",armor);root.put("stockpileLeft",stockpileLeft);
            root.put("stockpileStarted",stockpileStarted);root.put("granted",granted);root.put("pets",pets);root.put("wear",wear);root.put("potions",potions);
            root.put("playerPlaced",playerPlaced);
            Files.writeString(tmp,JSON.toJson(root));
            Files.move(tmp,inventoryFile(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
            inventoryDirty=false;
        }catch(IOException e){getLogger().warning("Could not save agent-inventories.json: "+e.getMessage());}
    }
    private Path damageFile(){return getDataFolder().toPath().resolve("damage.json");}
    private void loadDamage(){
        try{
            if(Files.exists(damageFile()))
                for(Map.Entry<String,JsonElement> entry:JsonParser.parseString(Files.readString(damageFile())).getAsJsonObject().entrySet())damaged.put(entry.getKey(),entry.getValue().getAsString());
        }catch(IOException|RuntimeException e){getLogger().warning("Could not read damage.json: "+e.getMessage());}
    }
    private void saveDamage(){
        try{
            Files.createDirectories(getDataFolder().toPath());
            Path tmp=damageFile().resolveSibling("damage.json.tmp");
            Files.writeString(tmp,JSON.toJson(damaged));
            Files.move(tmp,damageFile(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
            damageDirty=false;
        }catch(IOException e){getLogger().warning("Could not save damage.json: "+e.getMessage());}
    }
    private Block blockOf(String key){
        String[] p=key.split("\\|");World w=Bukkit.getWorld(p[0]);
        return w==null?null:w.getBlockAt(Integer.parseInt(p[1]),Integer.parseInt(p[2]),Integer.parseInt(p[3]));
    }
    /** The item a repair uses up: dirt for ground, the block's own item otherwise (nothing for a door's top or a bed's head). */
    private Material repairCost(String data){
        if(data.startsWith("~"))return Material.DIRT;
        BlockData d=Bukkit.createBlockData(data);
        if(d instanceof org.bukkit.block.data.Bisected half&&half.getHalf()==org.bukkit.block.data.Bisected.Half.TOP&&!(d instanceof org.bukkit.block.data.type.Stairs))return null;
        if(d instanceof Bed bed&&bed.getPart()==Bed.Part.HEAD)return null;
        Material m=d.getPlacementMaterial();return m==null||m.isAir()?null:m;
    }
    /** Remembers town blocks an explosion, fire or a mob is about to destroy, so the citizens can put them back. */
    private void recordDamage(Collection<Block> blocks,String cause){
        if(origin==null)return;
        double r=loadedRadius()+16;int built=0,ground=0,n=0;double sx=0,sy=0,sz=0;
        for(Block b:blocks){
            if(b.getWorld()!=origin.getWorld()||b.getLocation().distanceSquared(origin)>r*r)continue;
            Material m=b.getType();
            if(m.isAir()||b.isLiquid()||m==Material.TNT||m==Material.FIRE)continue;
            String k=key(b);if(damaged.containsKey(k))continue;
            if(naturalGround(b)){
                // Ground is refilled; plants, leaves and trees grow back on their own.
                if(!m.isSolid()||Tag.LEAVES.isTagged(m)||Tag.LOGS.isTagged(m))continue;
                damaged.put(k,"~"+m.name());ground++;
            }else{
                if(Tag.LEAVES.isTagged(m)&&!placed.containsKey(k))continue;
                damaged.put(k,b.getBlockData().getAsString());built++;
            }
            sx+=b.getX();sy+=b.getY();sz+=b.getZ();n++;
        }
        if(n==0)return;
        damageDirty=true;
        event("damage",Map.of("cause",cause,"x",(int)Math.round(sx/n),"y",(int)Math.round(sy/n),"z",(int)Math.round(sz/n),"built",built,"ground",ground));
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void grown(StructureGrowEvent e){
        boolean changed=placed.remove(key(e.getLocation().getBlock()))!=null;
        for(org.bukkit.block.BlockState s:e.getBlocks())changed|=placed.remove(key(s.getBlock()))!=null;
        if(changed){placedDirty=true;event("block",Map.of("kind","grown","block",block(e.getLocation().getBlock()),"species",e.getSpecies().name()));}
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void exploded(EntityExplodeEvent e){recordDamage(e.blockList(),e.getEntityType().name());}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void blockExploded(BlockExplodeEvent e){recordDamage(e.blockList(),"explosion");}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void burnt(BlockBurnEvent e){recordDamage(List.of(e.getBlock()),"fire");}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void mobTook(EntityChangeBlockEvent e){
        // An enderman lifting a block, a ravager trampling, a wither breaking: anything but players and falling blocks.
        if(e.getEntity() instanceof Player||e.getEntity() instanceof FallingBlock||!e.getTo().isAir()||e.getBlock().getType().isAir())return;
        recordDamage(List.of(e.getBlock()),e.getEntityType().name());
    }
    private Path placedFile(){return getDataFolder().toPath().resolve("agent-blocks.json");}
    private void loadPlaced(){
        try{
            if(Files.exists(placedFile()))
                for(Map.Entry<String,JsonElement> entry:JsonParser.parseString(Files.readString(placedFile())).getAsJsonObject().entrySet())placed.put(entry.getKey(),entry.getValue().getAsString());
        }catch(IOException|RuntimeException e){getLogger().warning("Could not read agent-blocks.json: "+e.getMessage());}
    }
    private void savePlaced(){
        try{
            Files.createDirectories(getDataFolder().toPath());
            Path tmp=placedFile().resolveSibling("agent-blocks.json.tmp");
            Files.writeString(tmp,JSON.toJson(placed));
            Files.move(tmp,placedFile(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
            placedDirty=false;
        }catch(IOException e){getLogger().warning("Could not save agent-blocks.json: "+e.getMessage());}
    }
    private Object act(Actor actor,JsonObject action){
        String type=string(action,"type",16);
        Entity body=actor.npc.getEntity();
        Object result;
        // Walking anywhere: up out of bed or off the seat first, no longer following, off the horse (a new trip decides
        // afresh). A guard fighting under Sentinel is left to it; a seated citizen asked to a spot right beside them stays put.
        if(Set.of("move","pathfind","travel","unstick","climb").contains(type)){
            if(sentinel(actor)&&SentinelSupport.fighting(actor.npc)&&!"unstick".equals(type))return "fighting";
            if(ferrying(actor)){if("unstick".equals(type))endFerry(actor,"called off",false);else return "ferrying";}   // in a boat: the crossing finishes first
            if(sitting(actor)&&Set.of("pathfind","travel").contains(type)&&action.has("x")&&action.has("z")
                &&Math.hypot(number(action,"x")-body.getLocation().getX(),number(action,"z")-body.getLocation().getZ())<=1.2)return "seated";
            wake(actor);stand(actor);unfollow(actor);
            if(riding.containsKey(actor.id))dismount(actor);
        }
        switch(type){
            case "sleep" -> {
                // Lie down in a bed within reach (the runtime sends citizens to their own bed at night).
                Block b=body.getWorld().getBlockAt((int)Math.floor(number(action,"x")),(int)Math.floor(number(action,"y")),(int)Math.floor(number(action,"z")));
                if(!(b.getBlockData() instanceof Bed bed))throw new IllegalArgumentException("That is not a bed");
                if(b.getLocation().add(0.5,0,0.5).distanceSquared(body.getLocation())>16)throw new IllegalArgumentException("The bed is too far; walk to it first");
                {GlobalNavigation g=navs.get(actor.id);if(g!=null&&g.active())g.stop();}
                actor.npc.getNavigator().cancelNavigation();
                Block head=bed.getPart()==Bed.Part.HEAD?b:b.getRelative(bed.getFacing());
                actor.npc.getOrAddTrait(net.citizensnpcs.trait.SleepTrait.class).setSleeping(head.getLocation().add(0.5,0,0.5));
                result="sleeping";
            }
            case "wake" -> {wake(actor);result="awake";}
            case "sit" -> {
                // On a seat near them (a stair or slab: benches, pews, the jury box), or where they stand.
                if(riding.containsKey(actor.id))throw new IllegalArgumentException("Riding; get off the horse first");
                {GlobalNavigation g=navs.get(actor.id);if(g!=null&&g.active())g.stop();}
                actor.npc.getNavigator().cancelNavigation();
                // A given chair (seat:true with its x,y,z: the town hall's meeting chairs), else the nearest free seat.
                Block seat;
                if(action.has("seat")&&action.get("seat").getAsBoolean()){
                    seat=body.getWorld().getBlockAt((int)Math.floor(number(action,"x")),(int)Math.floor(number(action,"y")),(int)Math.floor(number(action,"z")));
                    if(!(seat.getBlockData() instanceof org.bukkit.block.data.type.Stairs||seat.getBlockData() instanceof org.bukkit.block.data.type.Slab))throw new IllegalArgumentException("That is not a seat");
                    if(seat.getLocation().add(0.5,0,0.5).distanceSquared(body.getLocation())>9)throw new IllegalArgumentException("The seat is too far; walk to it first");
                    Location c=seat.getLocation().add(0.5,0.5,0.5);
                    if(actors.values().stream().anyMatch(o->o!=actor&&o.npc.isSpawned()&&o.npc.getEntity().getLocation().distanceSquared(c)<0.8))throw new IllegalArgumentException("Someone is sitting there");
                }else seat=seatNear(actor);
                Location at=seat!=null?seat.getLocation().add(0.5,0.5,0.5):body.getLocation().clone();
                // On a chair: facing away from its back (stairs face toward their tall side), i.e. toward the table.
                if(seat!=null&&seat.getBlockData() instanceof org.bukkit.block.data.type.Stairs st){
                    BlockFace look=st.getFacing().getOppositeFace();
                    at.setYaw(switch(look){case SOUTH->0f;case WEST->90f;case NORTH->180f;case EAST->-90f;default->body.getLocation().getYaw();});at.setPitch(0f);
                }else if(seat!=null)at.setYaw(body.getLocation().getYaw());
                actor.npc.getOrAddTrait(net.citizensnpcs.trait.SitTrait.class).setSitting(at);
                result=Map.of("sitting",true,"seat",seat!=null);
            }
            case "stand" -> {stand(actor);result="standing";}
            case "ashore" -> {
                // Fallen in the water: onto the nearest dry bank within 6 blocks (not all the way back to the spawn spot).
                Location dry=dryStandNear(body.getLocation(),6,9);   // from the bottom of a pond (or under a walkway) up to the bank
                if(dry==null)throw new IllegalArgumentException("No bank within 6 blocks");
                if(body.getVehicle()!=null)body.leaveVehicle();
                actor.npc.getNavigator().cancelNavigation();dry.setYaw(body.getLocation().getYaw());
                actor.npc.teleport(dry,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
                event("action",Map.of("agent",actor.id,"action","ashore","result","climbed out onto the bank at "+dry.getBlockX()+","+dry.getBlockZ()));
                result=Map.of("x",dry.getX(),"y",dry.getY(),"z",dry.getZ());
            }
            case "demolish" -> {
                // Take down a list of blocks the citizens placed (a mistaken build): each goes back to what was there
                // before (air), leaves the placed-block record (so it is not "repaired" back), and its item goes to
                // the demolisher. Blocks nobody placed are never touched. Up to 400 per call.
                JsonArray list=action.has("blocks")&&action.get("blocks").isJsonArray()?action.getAsJsonArray("blocks"):new JsonArray();
                int removed=0,skipped=0;Map<String,Integer> got=new TreeMap<>();
                for(int i=0;i<Math.min(400,list.size());i++){
                    JsonArray p=list.get(i).getAsJsonArray();
                    Block block=body.getWorld().getBlockAt(p.get(0).getAsInt(),p.get(1).getAsInt(),p.get(2).getAsInt());
                    String recorded=placed.get(key(block));
                    if(recorded==null||playerPlaced.contains(key(block))||block.getType().isAir()){skipped++;continue;}
                    String[] record=recorded.split("<");
                    Material item=block.getType();
                    if(block.getBlockData() instanceof Bed bed){
                        Block other=bed.getPart()==Bed.Part.FOOT?block.getRelative(bed.getFacing()):block.getRelative(bed.getFacing().getOppositeFace());
                        placed.remove(key(other));other.setType(Material.AIR,false);block.setType(Material.AIR,false);
                    }else block.setType(record.length>1?Material.valueOf(record[1]):Material.AIR,false);
                    placed.remove(key(block));removed++;
                    if(item.isItem())got.merge(item.name(),1,Integer::sum);
                }
                if(getConfig().getBoolean("economy"))for(Map.Entry<String,Integer> e:got.entrySet())inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge(e.getKey(),e.getValue(),Integer::sum);
                placedDirty=true;inventoryDirty=true;
                if(body instanceof LivingEntity living)living.swingMainHand();
                event("block",Map.of("kind","demolished","agent",actor.id,"removed",removed,"skipped",skipped));
                result=Map.of("removed",removed,"skipped",skipped,"items",got);
            }
            case "sign" -> {
                // A name sign over a public building's door: a wall sign hung on the wall behind it (facing = the side
                // it is read from), up to four lines (text "a|b|c|d"), glowing and waxed so nobody edits it by accident.
                Block b=body.getWorld().getBlockAt((int)Math.floor(number(action,"x")),(int)Math.floor(number(action,"y")),(int)Math.floor(number(action,"z")));
                if(!b.getType().isAir()&&!b.isReplaceable()&&!(b.getBlockData() instanceof org.bukkit.block.data.type.WallSign))throw new IllegalArgumentException("Space occupied");
                BlockFace f;try{f=BlockFace.valueOf(action.has("facing")?action.get("facing").getAsString().toUpperCase():"SOUTH");}catch(IllegalArgumentException x){f=BlockFace.SOUTH;}
                if(!List.of(BlockFace.NORTH,BlockFace.SOUTH,BlockFace.EAST,BlockFace.WEST).contains(f))f=BlockFace.SOUTH;
                if(!b.getRelative(f.getOppositeFace()).getType().isSolid())throw new IllegalArgumentException("Nothing to hang the sign on");
                Material m=Material.matchMaterial(action.has("target")?action.get("target").getAsString():"SPRUCE_WALL_SIGN");
                if(m==null||!(m.createBlockData() instanceof org.bukkit.block.data.type.WallSign))m=Material.SPRUCE_WALL_SIGN;
                org.bukkit.block.data.type.WallSign data=(org.bukkit.block.data.type.WallSign)m.createBlockData();data.setFacing(f);
                b.setBlockData(data,false);
                if(b.getState() instanceof org.bukkit.block.Sign sign){
                    org.bukkit.block.sign.SignSide side=sign.getSide(org.bukkit.block.sign.Side.FRONT);
                    String[] lines=string(action,"text",200).split("\\|",-1);
                    for(int i=0;i<4;i++)side.line(i,Component.text(i<lines.length?lines[i]:""));
                    side.setGlowingText(true);sign.setWaxed(true);sign.update(true,false);
                }
                placed.put(key(b),m.name());placedDirty=true;
                result="sign placed";
            }
            case "follow" -> {
                // Citizens' own follow (smooth, keeps a couple of blocks back, through doors).
                Player p=Bukkit.getPlayerExact(string(action,"to",32));
                if(p==null||p.getWorld()!=body.getWorld())throw new IllegalArgumentException("That player is not here");
                wake(actor);stand(actor);
                net.citizensnpcs.trait.FollowTrait f=actor.npc.getOrAddTrait(net.citizensnpcs.trait.FollowTrait.class);
                f.setFollowingMargin(2.5);if(f.getFollowing()!=p)f.follow(p);
                result="following";
            }
            case "unfollow" -> {unfollow(actor);result="stopped following";}
            case "mind" -> {
                // The runtime reports when a citizen starts and stops thinking (target "thinking"/"idle") and what about.
                actor.thinking="thinking".equals(string(action,"target",16));
                actor.thought=string(action,"text",300);result="ok";
            }
            case "mapdata" -> {
                // Town layers for the map (sites, homes, farms, damage, remembered resources), drawn by MapMarkers.
                if(markers!=null&&action.has("spec")&&action.get("spec").isJsonObject())markers.update(action.getAsJsonObject("spec"));
                result=markers!=null?"drawn":"no map";
            }
            case "recipes" -> result=Kitchen.recipes();
            case "allrecipes" -> result=Kitchen.allRecipes(Math.max(0,(int)number(action,"x")),Math.max(1,Math.min(400,action.has("count")?action.get("count").getAsInt():300)));   // every crafting and cooking recipe (paged)   // every food recipe the server knows (the chef learns from it)
            case "books" -> result=Kitchen.books(warehouseChests());   // written books in the warehouse chests
            case "climb" -> {
                // Step onto the top of a scaffold column beside the agent (or back down): the spot must have room to
                // stand (feet and head free, solid below) and lie within 3 blocks across and 12 up or down.
                Location here=body.getLocation();
                Location to=new Location(body.getWorld(),number(action,"x"),number(action,"y"),number(action,"z"),here.getYaw(),here.getPitch());
                if(Math.hypot(to.getX()-here.getX(),to.getZ()-here.getZ())>3.2||Math.abs(to.getY()-here.getY())>12)throw new IllegalArgumentException("Too far to climb");
                Block feet=to.getBlock();
                if(!feet.isPassable()||!feet.getRelative(BlockFace.UP).isPassable()||!feet.getRelative(BlockFace.DOWN).getType().isSolid())throw new IllegalArgumentException("No room to stand there");
                actor.npc.getNavigator().cancelNavigation();
                actor.npc.teleport(to.getBlock().getLocation().add(0.5,0,0.5),org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
                result=Map.of("x",to.getBlockX(),"y",to.getBlockY(),"z",to.getBlockZ());
            }
            case "damages" -> {
                // Damaged town blocks still waiting for repair (bottom up), up to 300.
                List<List<Object>> out=new ArrayList<>();
                for(Iterator<Map.Entry<String,String>> it=damaged.entrySet().iterator();it.hasNext()&&out.size()<300;){
                    Map.Entry<String,String> en=it.next();Block b=blockOf(en.getKey());
                    if(b==null||!b.getWorld().isChunkLoaded(b.getX()>>4,b.getZ()>>4))continue;
                    if(!b.isReplaceable()){it.remove();damageDirty=true;continue;}   // someone already filled it
                    boolean natural=en.getValue().startsWith("~");Material cost=repairCost(en.getValue());
                    out.add(List.of(b.getX(),b.getY(),b.getZ(),natural?"DIRT":Bukkit.createBlockData(en.getValue()).getMaterial().name(),natural,cost==null?"":cost.name()));
                }
                out.sort(Comparator.comparingInt(c->(Integer)c.get(1)));
                result=Map.of("blocks",out,"total",damaged.size());
            }
            case "repair" -> {
                // Puts back a destroyed town block exactly as it was (ground: dirt), using the item from the inventory.
                Block block=buildTarget(actor,action);
                String k=key(block),data=damaged.get(k);
                if(data==null)throw new IllegalArgumentException("Nothing to repair there");
                if(!block.isReplaceable()){damaged.remove(k);damageDirty=true;result="already filled";}
                else{
                    if(!block.getWorld().getNearbyEntities(BoundingBox.of(block),e->e instanceof LivingEntity).isEmpty())throw new IllegalArgumentException("Someone is standing there");
                    Material cost=repairCost(data);
                    boolean free=action.has("free")&&action.get("free").getAsBoolean();
                    if(getConfig().getBoolean("economy")&&!free&&cost!=null&&!take(actor.id,cost,1))
                        throw new IllegalArgumentException("Out of "+cost.name()+"; fetch more from the warehouse");
                    block.setBlockData(data.startsWith("~")?Material.DIRT.createBlockData():Bukkit.createBlockData(data),false);
                    damaged.remove(k);damageDirty=true;
                    if(body instanceof LivingEntity living)living.swingMainHand();
                    event("block",Map.of("kind","agent_repair","agent",actor.id,"block",block(block)));result="repaired";
                }
            }
            case "darkspots" -> {
                // Dark ground in the town (no light from blocks: hostile mobs can spawn there), every 3 blocks.
                int radius=action.has("count")?Math.max(8,Math.min(112,action.get("count").getAsInt())):64;
                World w=origin.getWorld();List<Map<String,Object>> out=new ArrayList<>();
                for(int x=-radius;x<=radius;x+=3)for(int z=-radius;z<=radius;z+=3){
                    if(x*x+z*z>radius*radius)continue;
                    int bx=origin.getBlockX()+x,bz=origin.getBlockZ()+z;
                    if(!w.isChunkLoaded(bx>>4,bz>>4))continue;
                    Block top=w.getHighestBlockAt(bx,bz,HeightMap.MOTION_BLOCKING_NO_LEAVES);Material m=top.getType();
                    if(top.isLiquid()||!m.isSolid()||m==Material.FARMLAND||Tag.LOGS.isTagged(m))continue;
                    if(!(naturalGround(top)||m==Material.DIRT_PATH||m==Material.GRAVEL))continue;   // open ground and paths, not roofs
                    Block above=top.getRelative(BlockFace.UP);
                    if(!above.getType().isAir()||above.getLightFromBlocks()>0)continue;
                    out.add(Map.of("x",bx,"y",above.getY(),"z",bz));
                }
                out.sort(Comparator.comparingDouble(p->Math.pow(((Integer)p.get("x"))-origin.getX(),2)+Math.pow(((Integer)p.get("z"))-origin.getZ(),2)));
                result=out.subList(0,Math.min(80,out.size()));
            }
            case "wait" -> {GlobalNavigation g=navs.get(actor.id);if(g!=null&&g.active())g.stop();actor.npc.getNavigator().cancelNavigation();result="stopped";}
            case "travel" -> {
                // Walk to any point in the world: rolling 12-block legs with detours; chunks load asynchronously ahead.
                Location dest=new Location(body.getWorld(),number(action,"x"),number(action,"y"),number(action,"z"));
                actor.goal=key(dest.getBlock());actor.goalAt=System.currentTimeMillis();
                if(dest.getY()<=dest.getWorld().getMinHeight()||dest.getY()+1>=dest.getWorld().getMaxHeight()||!dest.getWorld().getWorldBorder().isInside(dest))
                    throw new IllegalArgumentException("Destination outside the world");
                if(ride(actor,dest))result=Map.of("navigation","started","riding",true);   // the courier's horse on long trips
                else{nav(actor).go(dest);result=Map.of("navigation","started");}
            }
            case "effect" -> {
                // Visible moments of town life: particles (and a sound) at the agent for sermons, blessings,
                // conversions, festivals and hobbies. Unknown kinds fall back to a small sparkle.
                String kind=string(action,"target",32).toLowerCase(Locale.ROOT);
                String[] spec=switch(kind){
                    case "sermon"->new String[]{"ENCHANT","60","1.2","BLOCK_BELL_USE"};
                    case "blessing"->new String[]{"END_ROD","25","1.0","BLOCK_AMETHYST_BLOCK_CHIME"};
                    case "conversion"->new String[]{"TOTEM_OF_UNDYING","30","0.6","ENTITY_PLAYER_LEVELUP"};
                    case "music"->new String[]{"NOTE","8","0.8","BLOCK_NOTE_BLOCK_HARP"};
                    case "gardening"->new String[]{"HAPPY_VILLAGER","12","0.8",""};
                    case "reading"->new String[]{"ENCHANT","20","0.6",""};
                    case "whittling"->new String[]{"CRIT","10","0.4",""};
                    case "angling"->new String[]{"SPLASH","14","0.6",""};
                    case "stargazing"->new String[]{"END_ROD","8","0.5",""};
                    case "cooking"->new String[]{"SMOKE","10","0.4",""};
                    case "festival"->new String[]{"FIREWORK","40","1.5","ENTITY_FIREWORK_ROCKET_TWINKLE"};
                    // Justice: an arrest, the magistrate's gavel, the cell door, release.
                    case "arrest"->new String[]{"CRIT","18","0.5","ITEM_ARMOR_EQUIP_CHAIN"};
                    case "gavel"->new String[]{"WAX_ON","10","0.4","BLOCK_ANVIL_LAND"};
                    case "jail"->new String[]{"SMOKE","16","0.5","BLOCK_IRON_DOOR_CLOSE"};
                    case "release"->new String[]{"HAPPY_VILLAGER","16","0.7","BLOCK_IRON_DOOR_OPEN"};
                    default->new String[]{"HAPPY_VILLAGER","6","0.5",""};
                };
                Location at=body.getLocation().add(0,1.2,0);
                try{Particle p=Particle.valueOf(spec[0]);double r=Double.parseDouble(spec[2]);
                    body.getWorld().spawnParticle(p,at,Integer.parseInt(spec[1]),r,0.6,r,p==Particle.NOTE?1:0.02);}catch(IllegalArgumentException ignored){}
                if(!spec[3].isEmpty())try{body.getWorld().playSound(at,(Sound)Sound.class.getField(spec[3]).get(null),0.8f,1f);}catch(ReflectiveOperationException|RuntimeException ignored){}
                if(kind.equals("conversion")&&body instanceof LivingEntity living)living.swingMainHand();
                result=Map.of("effect",kind);
            }
            case "scan" -> {
                // Block states in a box of up to 8 x 16 x 8 (air omitted) for terrain planning: type, solid, natural, liquid.
                int x0=(int)Math.floor(number(action,"x")),y0=(int)Math.floor(number(action,"y")),z0=(int)Math.floor(number(action,"z"));
                int dx=Math.max(1,Math.min(8,action.get("width").getAsInt())),dy=Math.max(1,Math.min(16,action.get("height").getAsInt())),dz=Math.max(1,Math.min(8,action.get("depth").getAsInt()));
                World world=body.getWorld();
                if(y0<world.getMinHeight()||y0+dy>world.getMaxHeight())throw new IllegalArgumentException("Scan outside the world height");
                List<List<Object>> cells=new ArrayList<>();
                for(int x=x0;x<x0+dx;x++)for(int z=z0;z<z0+dz;z++){
                    if(!world.isChunkLoaded(x>>4,z>>4))throw new IllegalArgumentException("Target chunk not loaded");
                    for(int y=y0;y<y0+dy;y++){Block b=world.getBlockAt(x,y,z);if(b.getType().isAir())continue;
                        cells.add(List.of(x,y,z,b.getType().name(),b.getType().isSolid(),naturalGround(b),b.isLiquid()));}
                }
                result=Map.of("cells",cells);
            }
            case "move", "pathfind" -> {
                {GlobalNavigation g=navs.get(actor.id);if(g!=null&&g.active())g.stop();}
                Location destination=target(actor,action,24);
                // A spot on the water (a model aiming at the lake): the nearest dry bank within 4 blocks instead (2.23.1).
                if(waterTop(destination.getBlock())||waterTop(destination.getBlock().getRelative(BlockFace.DOWN))){Location dry=dryStandNear(destination,4);if(dry==null)throw new IllegalArgumentException("That spot is in the water; pick one on the bank");destination=dry;}
                if(!destination.getBlock().isPassable()||!destination.clone().add(0,1,0).getBlock().isPassable())throw new IllegalArgumentException("Destination obstructed");
                // Never send two agents to the same block: take the nearest free spot instead.
                Location free=freeSpot(actor,destination.getBlock(),3);
                if(free!=null&&!free.getBlock().equals(destination.getBlock()))destination=free;
                actor.goal=key(destination.getBlock());
                actor.goalAt=System.currentTimeMillis();
                actor.npc.getNavigator().setTarget(destination);
                result="navigation_requested"; // Arrival is evaluated from subsequent snapshots.
            }
            case "place" -> {
                Block block=buildTarget(actor,action);
                Material material=Material.matchMaterial(string(action,"target",64));
                if(material==null||!buildable.contains(material))throw new IllegalArgumentException("Material not allowed; use one of the listed build materials");
                if((material==Material.LANTERN||material==Material.TORCH)
                    &&(block.getRelative(BlockFace.DOWN).getType()==Material.LANTERN||block.getRelative(BlockFace.DOWN).getType()==Material.TORCH))
                    throw new IllegalArgumentException("Do not stack lights; use a supported lamp post");
                String original=null;
                if(TerrainPlacement.reclaim(actor.id,action.has("reclaim")&&action.get("reclaim").getAsBoolean(),block.getType().name(),material.name(),playerPlaced.contains(key(block))))original="WATER";
                else if(getConfig().getStringList("surface-materials").contains(material.name())&&SURFACE.contains(block.getType()))original=block.getType().name();
                else if(!block.getType().isAir()&&!block.isReplaceable())throw new IllegalArgumentException("Space occupied; place only into air or grass");
                if(!block.getWorld().getNearbyEntities(BoundingBox.of(block),e->e instanceof LivingEntity).isEmpty())throw new IllegalArgumentException("Someone is standing there");
                // Economy: placing uses the item from the agent's inventory unless the runtime marks it free
                // (bootstrapping the warehouse). The item for a block can differ (redstone wire -> redstone).
                Material cost=material.createBlockData().getPlacementMaterial();
                boolean free=action.has("free")&&action.get("free").getAsBoolean();
                if(getConfig().getBoolean("economy")&&!free&&!take(actor.id,cost,1))
                    throw new IllegalArgumentException("Out of "+cost.name()+"; fetch more from the warehouse");
                boolean paid=getConfig().getBoolean("economy")&&!free;
                if(material.name().endsWith("_BED")){
                    BlockFace facing;try{facing=BlockFace.valueOf(action.has("facing")?action.get("facing").getAsString().toUpperCase():"SOUTH");}catch(IllegalArgumentException x){facing=BlockFace.SOUTH;}
                    if(!List.of(BlockFace.NORTH,BlockFace.SOUTH,BlockFace.EAST,BlockFace.WEST).contains(facing))facing=BlockFace.SOUTH;
                    Block head=block.getRelative(facing);
                    if(!head.getType().isAir()&&!head.isReplaceable()){if(paid)inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge(cost.name(),1,Integer::sum);throw new IllegalArgumentException("No room for the head of the bed");}
                    Bed foot=(Bed)material.createBlockData();foot.setFacing(facing);foot.setPart(Bed.Part.FOOT);
                    Bed top=(Bed)material.createBlockData();top.setFacing(facing);top.setPart(Bed.Part.HEAD);
                    block.setBlockData(foot,false);head.setBlockData(top,false);
                    placed.put(key(head),material.name());
                }
                else if(material.createBlockData() instanceof org.bukkit.block.data.type.Door){
                    // Doors are two blocks: the lower half here, the upper half above (the courthouse's iron cell doors).
                    BlockFace facing;try{facing=BlockFace.valueOf(action.has("facing")?action.get("facing").getAsString().toUpperCase():"SOUTH");}catch(IllegalArgumentException x){facing=BlockFace.SOUTH;}
                    if(!List.of(BlockFace.NORTH,BlockFace.SOUTH,BlockFace.EAST,BlockFace.WEST).contains(facing))facing=BlockFace.SOUTH;
                    Block up=block.getRelative(BlockFace.UP);
                    if(!up.getType().isAir()&&!up.isReplaceable()){if(paid)inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge(cost.name(),1,Integer::sum);throw new IllegalArgumentException("No room for the top of the door");}
                    org.bukkit.block.data.type.Door low=(org.bukkit.block.data.type.Door)material.createBlockData(),high=(org.bukkit.block.data.type.Door)material.createBlockData();
                    low.setFacing(facing);low.setHalf(org.bukkit.block.data.Bisected.Half.BOTTOM);high.setFacing(facing);high.setHalf(org.bukkit.block.data.Bisected.Half.TOP);
                    block.setBlockData(low,false);up.setBlockData(high,false);
                    placed.put(key(up),material.name());
                }
                else{
                    block.setType(material,material!=Material.LANTERN);
                    // Facing for directional blocks (stairs as benches); levers sit on the floor.
                    BlockData data=block.getBlockData();boolean changed=false;
                    if(data instanceof org.bukkit.block.data.type.Lantern lamp&&action.has("hanging")){
                        lamp.setHanging(action.get("hanging").getAsBoolean());changed=true;
                    }
                    if(action.has("facing")&&data instanceof org.bukkit.block.data.Directional dir){
                        try{BlockFace f=BlockFace.valueOf(action.get("facing").getAsString().toUpperCase());if(dir.getFaces().contains(f)){dir.setFacing(f);changed=true;}}catch(IllegalArgumentException ignored){}
                    }
                    if(material==Material.LEVER&&data instanceof org.bukkit.block.data.FaceAttachable att){att.setAttachedFace(org.bukkit.block.data.FaceAttachable.AttachedFace.FLOOR);changed=true;}
                    if(changed)block.setBlockData(data,true);
                }
                if(block.getBlockData() instanceof Leaves leaves){leaves.setPersistent(true);block.setBlockData(leaves);}
                placed.put(key(block),original==null?material.name():material.name()+"<"+original);placedDirty=true;
                if(body instanceof LivingEntity living)living.swingMainHand();
                event("block",Map.of("kind","agent_place","agent",actor.id,"block",block(block)));result="placed";
                if(material==Material.CHEST)fillStockpile(block);
            }
            case "break" -> {
                Block block=buildTarget(actor,action);
                String recorded=placed.get(key(block));
                if(recorded==null)throw new IllegalArgumentException("Only blocks placed by agents can be broken");
                String[] record=recorded.split("<");
                if(!record[0].equals(block.getType().name())){placed.remove(key(block));placedDirty=true;throw new IllegalArgumentException("Block changed since an agent placed it; left alone");}
                if(block.getBlockData() instanceof Bed bed){
                    Block other=bed.getPart()==Bed.Part.FOOT?block.getRelative(bed.getFacing()):block.getRelative(bed.getFacing().getOppositeFace());
                    if(placed.remove(key(other))!=null)other.setType(Material.AIR,false);
                    block.setType(Material.AIR,false);
                }
                else block.setType(record.length>1?Material.valueOf(record[1]):Material.AIR,true);
                placed.remove(key(block));placedDirty=true;
                // The agent gets the item back (its scaffolding, a misplaced block): placing it had used one up.
                Material item=Material.matchMaterial(record[0]);
                if(getConfig().getBoolean("economy")&&item!=null&&item.isItem()){inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge(item.name(),1,Integer::sum);inventoryDirty=true;}
                if(body instanceof LivingEntity living)living.swingMainHand();
                event("block",Map.of("kind","agent_break","agent",actor.id,"block",block(block)));result="broken";
            }
            case "give" -> {
                Material item=Material.matchMaterial(string(action,"target",64));
                JsonElement countValue=action.get("count");
                int count=countValue!=null&&countValue.isJsonPrimitive()?Math.max(1,Math.min(64,countValue.getAsInt())):1;
                Map<String,Integer> inventory=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
                if(item==null||inventory.getOrDefault(item.name(),0)<count)throw new IllegalArgumentException("Not enough of that item in your inventory");
                String to=string(action,"to",32);
                Player player=Bukkit.getPlayerExact(to);Actor mate=actors.get(to);
                if(player!=null){
                    if(player.getWorld()!=body.getWorld()||player.getLocation().distanceSquared(body.getLocation())>16)throw new IllegalArgumentException("Recipient must be within 4 blocks");
                    for(ItemStack overflow:player.getInventory().addItem(new ItemStack(item,count)).values())player.getWorld().dropItemNaturally(player.getLocation(),overflow);
                }else if(mate!=null&&mate!=actor&&mate.npc.isSpawned()){
                    if(mate.npc.getEntity().getLocation().distanceSquared(body.getLocation())>16)throw new IllegalArgumentException("Recipient must be within 4 blocks");
                    inventories.computeIfAbsent(mate.id,k->new TreeMap<>()).merge(item.name(),count,Integer::sum);
                }else throw new IllegalArgumentException("Unknown or offline recipient");
                inventory.merge(item.name(),-count,Integer::sum);inventory.remove(item.name(),0);inventoryDirty=true;
                if(!inventory.containsKey(item.name())&&item.name().equals(held.get(actor.id))){held.remove(actor.id);applyHeld(actor);}
                if(body instanceof LivingEntity living)living.swingMainHand();
                event("trade",Map.of("kind","give","agent",actor.id,"to",to,"item",item.name(),"count",count));result="given";
            }
            case "clear" -> {
                // Site preparation: remove one block of natural ground (soil, rock, sand, plants, trees). Never agent- or
                // player-placed blocks, containers or anything else built. Drops go to the agent like mining.
                if(!getConfig().getBoolean("allow-clear",true))throw new IllegalArgumentException("Clearing disabled");
                Block block=buildTarget(actor,action);
                Material m=block.getType();
                if(m.isAir()||block.isLiquid())result=Map.of("cleared","AIR");
                else{
                    if(placed.containsKey(key(block)))throw new IllegalArgumentException("Built by an agent; use break instead");
                    if(playerPlaced.contains(key(block)))throw new IllegalArgumentException("Placed by a player; left alone");
                    if(!naturalGround(block))throw new IllegalArgumentException("Not natural ground; left alone");
                    if(action.has("expected")&&!string(action,"expected",64).equalsIgnoreCase(m.name()))throw new IllegalArgumentException("Block changed since the scan ("+m.name()+"); rescan");
                    Material tool=Tag.MINEABLE_PICKAXE.isTagged(m)?Material.IRON_PICKAXE:Tag.MINEABLE_AXE.isTagged(m)?Material.IRON_AXE:Material.IRON_SHOVEL;
                    Collection<ItemStack> drops=block.getDrops(new ItemStack(tool),body);
                    block.setType(Material.AIR,true);
                    wearHeld(actor,"PICKAXE","SHOVEL","AXE");
                    Map<String,Integer> got=new TreeMap<>();
                    for(ItemStack drop:drops){addOrDrop(actor,drop);got.merge(drop.getType().name(),drop.getAmount(),Integer::sum);}
                    if(body instanceof LivingEntity living)living.swingMainHand();
                    event("block",Map.of("kind","agent_clear","agent",actor.id,"block",Map.of("type",m.name(),"x",block.getX(),"y",block.getY(),"z",block.getZ())));
                    result=Map.of("cleared",m.name(),"drops",got);
                }
            }
            case "farmscan" -> {
                // Farmland in the community area (surface only), so the town can look after plots players made for it.
                if(!getConfig().getBoolean("allow-farm"))throw new IllegalArgumentException("Farming disabled");
                int cx=(int)Math.floor(number(action,"x")),cz=(int)Math.floor(number(action,"z"));
                int r=Math.max(4,Math.min(64,action.has("radius")?action.get("radius").getAsInt():32));
                World world=body.getWorld();
                List<List<Object>> cells=new ArrayList<>();
                scan:
                for(int x=cx-r;x<=cx+r;x++)for(int z=cz-r;z<=cz+r;z++){
                    if(!world.isChunkLoaded(x>>4,z>>4))continue;
                    Block top=world.getHighestBlockAt(x,z,HeightMap.MOTION_BLOCKING_NO_LEAVES);
                    if(top.getType()!=Material.FARMLAND||outsideArea(top.getLocation(),0))continue;
                    Block above=top.getRelative(BlockFace.UP);
                    cells.add(List.of(x,top.getY(),z,above.getType().name(),crops.contains(key(above))));
                    if(cells.size()>=4000)break scan;
                }
                result=Map.of("cells",cells);
            }
            case "adoptfarm" -> {
                // Adopt (or, with remove, release) farmland cells: their crops become the town's to harvest and replant.
                if(!getConfig().getBoolean("allow-farm"))throw new IllegalArgumentException("Farming disabled");
                boolean remove=action.has("remove")&&action.get("remove").getAsBoolean();
                World world=body.getWorld();int n=0;
                for(JsonElement cell:action.getAsJsonArray("cells")){
                    JsonArray c=cell.getAsJsonArray();int x=c.get(0).getAsInt(),z=c.get(1).getAsInt();
                    if(!world.isChunkLoaded(x>>4,z>>4))continue;
                    Block top=world.getHighestBlockAt(x,z,HeightMap.MOTION_BLOCKING_NO_LEAVES);
                    if(top.getType()!=Material.FARMLAND||outsideArea(top.getLocation(),0))continue;
                    String k=key(top.getRelative(BlockFace.UP));
                    if(remove?crops.remove(k):crops.add(k))n++;
                }
                if(n>0)inventoryDirty=true;
                result=Map.of(remove?"released":"adopted",n);
            }
            case "survey" -> {
                // Ground heights (highest solid, non-leaf block) for up to 16x16 columns, so blueprints sit on the terrain.
                int x0=(int)Math.floor(number(action,"x")),z0=(int)Math.floor(number(action,"z"));
                int w=Math.max(1,Math.min(16,action.get("width").getAsInt())),d=Math.max(1,Math.min(16,action.get("depth").getAsInt()));
                if(origin.distanceSquared(new Location(body.getWorld(),x0,origin.getY(),z0))>Math.pow(radiusFor(actor)+16,2))throw new IllegalArgumentException("Survey outside the community area");
                List<Integer> heights=new ArrayList<>();List<Boolean> liquid=new ArrayList<>();List<String> tops=new ArrayList<>();List<Boolean> natural=new ArrayList<>();
                for(int k=0;k<d;k++)for(int i=0;i<w;i++){
                    if(!body.getWorld().isChunkLoaded((x0+i)>>4,(z0+k)>>4)){heights.add(null);liquid.add(false);tops.add(null);natural.add(false);continue;}
                    Block top=body.getWorld().getHighestBlockAt(x0+i,z0+k,HeightMap.MOTION_BLOCKING_NO_LEAVES);
                    heights.add(top.getY());liquid.add(top.isLiquid());tops.add(top.getType().name());natural.add(naturalGround(top));
                }
                // liquid[i] marks water/lava surfaces, so roads can bridge them and builds avoid them; tops/natural let the
                // builder tell open ground from anything built (by a player or an agent).
                Map<String,Object> r=new LinkedHashMap<>();r.put("x",x0);r.put("z",z0);r.put("width",w);r.put("depth",d);r.put("heights",heights);r.put("liquid",liquid);r.put("tops",tops);r.put("natural",natural);
                result=r;
            }
            case "mine" -> {
                if(!getConfig().getBoolean("allow-mine"))throw new IllegalArgumentException("Mining disabled");
                Block block=workTarget(actor,action);
                Material mined=block.getType();
                if(mined.isAir()||block.isLiquid()||NEVER_MINE.contains(mined)||block.getState() instanceof TileState||mined.getHardness()<0)
                    throw new IllegalArgumentException("That block cannot be mined");
                if(placed.containsKey(key(block)))throw new IllegalArgumentException("Built by an agent; use break instead");
                if(playerPlaced.contains(key(block)))throw new IllegalArgumentException("Placed by a player; left alone");
                if(block.getBlockData() instanceof Leaves leaves&&leaves.isPersistent())throw new IllegalArgumentException("Placed leaves (a hedge); left alone");
                boolean deep=block.getY()<getConfig().getInt("mine-max-y",50);
                boolean shaft=inZone(block,"mine-shafts")||inZone(block,"excavation-sites");
                boolean gather=getConfig().getStringList("gather-anywhere").stream().anyMatch(p->mined.name().endsWith(p));
                if(!deep&&!shaft&&!gather)throw new IllegalArgumentException("Mining is only allowed below y="+getConfig().getInt("mine-max-y",50)+", in the mine shaft, or for gatherable blocks");
                for(org.bukkit.block.BlockFace face:List.of(org.bukkit.block.BlockFace.UP,org.bukkit.block.BlockFace.NORTH,org.bukkit.block.BlockFace.SOUTH,org.bukkit.block.BlockFace.EAST,org.bukkit.block.BlockFace.WEST,org.bukkit.block.BlockFace.DOWN)){
                    Material near=block.getRelative(face).getType();
                    if(near==Material.LAVA||near==Material.WATER)throw new IllegalArgumentException(near==Material.LAVA?"Lava behind this block; leave it":"Water behind this block; leave it");
                }
                String tool=held.get(actor.id);
                Collection<ItemStack> drops=block.getDrops(tool==null?new ItemStack(Material.AIR):new ItemStack(Material.valueOf(tool)),body);
                block.setType(Material.AIR,true);
                wearHeld(actor,"PICKAXE","SHOVEL","AXE");
                Map<String,Integer> got=new TreeMap<>();
                for(ItemStack drop:drops){addOrDrop(actor,drop);got.merge(drop.getType().name(),drop.getAmount(),Integer::sum);}
                if(body instanceof LivingEntity living)living.swingMainHand();
                event("block",Map.of("kind","agent_mine","agent",actor.id,"block",Map.of("type",mined.name(),"x",block.getX(),"y",block.getY(),"z",block.getZ()),"drops",got));
                result=Map.of("mined",mined.name(),"drops",got);
            }
            case "tend" -> {
                // One pass over a farm plot: till grass/dirt, plant seeds on empty farmland, harvest ripe agent-planted crops.
                if(!getConfig().getBoolean("allow-farm"))throw new IllegalArgumentException("Farming disabled");
                Block centre=workTarget(actor,action);
                int w=Math.max(1,Math.min(10,action.get("width").getAsInt())),d=Math.max(1,Math.min(10,action.get("depth").getAsInt()));
                Material seed=Material.matchMaterial(string(action,"target",64));
                if(seed==null||!SEED_CROPS.containsKey(seed))throw new IllegalArgumentException("Use WHEAT_SEEDS, CARROT, POTATO or BEETROOT_SEEDS");
                int tilled=0,planted=0,harvested=0;Map<String,Integer> got=new TreeMap<>();
                double radius=getConfig().getDouble("roam-radius",128);
                for(int i=0;i<w;i++)for(int k=0;k<d;k++){
                    int x=centre.getX()-w/2+i,z=centre.getZ()-d/2+k;
                    Block ground=body.getWorld().getHighestBlockAt(x,z,HeightMap.MOTION_BLOCKING_NO_LEAVES);
                    if(outsideArea(ground.getLocation(),0))continue;
                    Block above=ground.getRelative(org.bukkit.block.BlockFace.UP);
                    // Crops are not motion-blocking, so the highest block is the soil under them.
                    if(crops.contains(key(above))&&above.getBlockData() instanceof Ageable age){
                        if(age.getAge()<age.getMaximumAge())continue;
                        for(ItemStack drop:above.getDrops()){addOrDrop(actor,drop);got.merge(drop.getType().name(),drop.getAmount(),Integer::sum);}
                        harvested++;
                        Material again=SEED_CROPS.entrySet().stream().filter(e->e.getValue()==above.getType()).map(Map.Entry::getKey).findFirst().orElse(seed);
                        if(take(actor.id,again,1)){age.setAge(0);above.setBlockData(age);}else{above.setType(Material.AIR);crops.remove(key(above));}
                        continue;
                    }
                    if(!above.getType().isAir()&&!above.isReplaceable())continue;
                    // Till only where a seed can go in straight away; bare farmland just dries back to dirt.
                    if((ground.getType()==Material.GRASS_BLOCK||ground.getType()==Material.DIRT)&&count(actor.id,seed)>0){
                        if(!above.getType().isAir())above.setType(Material.AIR);
                        ground.setType(Material.FARMLAND);tilled++;
                    }
                    if(ground.getType()==Material.FARMLAND&&above.getType().isAir()&&take(actor.id,seed,1)){
                        above.setType(SEED_CROPS.get(seed));crops.add(key(above));planted++;
                    }
                }
                inventoryDirty=true;
                if(harvested+tilled>0)wearHeld(actor,"HOE");
                if(body instanceof LivingEntity living)living.swingMainHand();
                event("block",Map.of("kind","agent_farm","agent",actor.id,"tilled",tilled,"planted",planted,"harvested",harvested));
                result=Map.of("tilled",tilled,"planted",planted,"harvested",harvested,"items",got);
            }
            case "breed" -> {
                if(!getConfig().getBoolean("allow-farm"))throw new IllegalArgumentException("Farming disabled");
                EntityType kind;try{kind=EntityType.valueOf(string(action,"target",32).toUpperCase());}catch(IllegalArgumentException e){throw new IllegalArgumentException("Unknown animal");}
                Material food=BREED_FOOD.get(kind);if(food==null)throw new IllegalArgumentException("Can breed COW, SHEEP, GOAT, PIG, CHICKEN or RABBIT");
                List<Animals> pair=body.getNearbyEntities(8,4,8).stream().filter(e->e.getType()==kind&&e instanceof Animals a&&a.isAdult()&&a.canBreed()&&!a.isLoveMode()).map(e->(Animals)e).limit(2).toList();
                if(pair.size()<2)throw new IllegalArgumentException("Need two adult "+kind.name().toLowerCase()+"s within 8 blocks that can breed");
                if(!take(actor.id,food,2))throw new IllegalArgumentException("Need 2 "+food.name()+" in inventory");
                for(Animals animal:pair)animal.setLoveModeTicks(600);
                result=Map.of("bred",kind.name(),"used",food.name());
            }
            case "craft" -> {
                Material item=Material.matchMaterial(string(action,"target",64));
                JsonElement times=action.get("count");int n=times!=null&&times.isJsonPrimitive()?Math.max(1,Math.min(16,times.getAsInt())):1;
                if(item==null)throw new IllegalArgumentException("Unknown item");
                int made=0;
                for(int t=0;t<n&&craftOnce(actor,item);t++)made++;
                if(made==0)throw new IllegalArgumentException("Missing ingredients for "+item.name());
                result=Map.of("crafted",item.name(),"times",made);
            }
            case "smelt" -> {
                Material input=Material.matchMaterial(string(action,"target",64));
                JsonElement times=action.get("count");int n=times!=null&&times.isJsonPrimitive()?Math.max(1,Math.min(64,times.getAsInt())):1;
                FurnaceRecipe recipe=null;
                for(Iterator<Recipe> it=Bukkit.recipeIterator();it.hasNext();){
                    if(it.next() instanceof FurnaceRecipe r&&input!=null&&r.getInputChoice().test(new ItemStack(input))){recipe=r;break;}
                }
                if(recipe==null)throw new IllegalArgumentException("That cannot be smelted");
                n=Math.min(n,count(actor.id,input));
                // Fuel: coal or charcoal first (8 items each), otherwise planks or logs (1.5 each) or sticks (0.5).
                final int items=n;
                Map<String,Integer> inv=inventories.getOrDefault(actor.id,Map.of());
                String fuelItem=null;int fuel=0;
                for(String k:inv.keySet()){
                    double per=FUEL_UNITS.getOrDefault(k,k.endsWith("_PLANKS")||k.endsWith("_LOG")?1.5:k.equals("STICK")?0.5:0);
                    if(per<=0)continue;int need=(int)Math.ceil(items/per);
                    if(inv.get(k)>=need&&(fuelItem==null||per>FUEL_UNITS.getOrDefault(fuelItem,1.5))){fuelItem=k;fuel=need;}
                }
                if(n<1||fuelItem==null)throw new IllegalArgumentException("Need the input and fuel (coal, charcoal, planks, logs or sticks)");
                take(actor.id,input,n);take(actor.id,Material.valueOf(fuelItem),fuel);
                ItemStack out=recipe.getResult().clone();out.setAmount(out.getAmount()*n);addOrDrop(actor,out);
                result=Map.of("smelted",input.name(),"into",out.getType().name(),"count",out.getAmount());
            }
            case "deposit" -> {
                org.bukkit.block.Container chest=warehouseChest(actor,action);
                Material item=Material.matchMaterial(string(action,"target",64));
                if(item==null)throw new IllegalArgumentException("Unknown item");
                int want=Math.min(count(actor.id,item),action.has("count")?Math.max(1,action.get("count").getAsInt()):count(actor.id,item));
                if(want<1)throw new IllegalArgumentException("You have no "+item.name());
                int moved=0;
                while(moved<want){
                    int n=Math.min(item.getMaxStackSize(),want-moved);
                    int left=chest.getInventory().addItem(new ItemStack(item,n)).values().stream().mapToInt(ItemStack::getAmount).sum();
                    moved+=n-left;if(left>0)break;
                }
                if(moved>0)take(actor.id,item,moved);
                if(moved==0)throw new IllegalArgumentException("That chest is full");
                event("trade",Map.of("kind","deposit","agent",actor.id,"item",item.name(),"count",moved));
                result=Map.of("deposited",moved,"item",item.name());
            }
            case "withdraw" -> {
                org.bukkit.block.Container chest=warehouseChest(actor,action);
                Material item=Material.matchMaterial(string(action,"target",64));
                if(item==null)throw new IllegalArgumentException("Unknown item");
                int available=Arrays.stream(chest.getInventory().getContents()).filter(i->i!=null&&i.getType()==item).mapToInt(ItemStack::getAmount).sum();
                int want=Math.min(available,action.has("count")?Math.max(1,Math.min(256,action.get("count").getAsInt())):available);
                if(want<1)throw new IllegalArgumentException("That chest has no "+item.name());
                Map<String,Integer> inventory=inventories.computeIfAbsent(actor.id,k->new TreeMap<>());
                if(inventory.size()>=36&&!inventory.containsKey(item.name()))throw new IllegalArgumentException("Your pockets are full");
                int got=0;
                while(got<want){int n=Math.min(item.getMaxStackSize(),want-got);chest.getInventory().removeItem(new ItemStack(item,n));got+=n;}
                inventory.merge(item.name(),got,Integer::sum);inventoryDirty=true;
                event("trade",Map.of("kind","withdraw","agent",actor.id,"item",item.name(),"count",got));
                result=Map.of("withdrew",got,"item",item.name());
            }
            case "stock" -> {
                Map<String,Integer> items=new TreeMap<>();List<Object> chests=new ArrayList<>();
                for(org.bukkit.block.Container chest:warehouseChests()){
                    Map<String,Integer> own=new TreeMap<>();
                    for(ItemStack i:chest.getInventory().getContents())if(i!=null&&!i.getType().isAir()){items.merge(i.getType().name(),i.getAmount(),Integer::sum);own.merge(i.getType().name(),i.getAmount(),Integer::sum);}
                    Map<String,Object> view=new HashMap<>(Map.of("x",chest.getX(),"y",chest.getY(),"z",chest.getZ(),"free",(int)Arrays.stream(chest.getInventory().getContents()).filter(i->i==null||i.getType().isAir()).count(),"items",own,"size",chest.getInventory().getSize()));
                    if(chest.customName()!=null)view.put("name",PlainTextComponentSerializer.plainText().serialize(chest.customName()));
                    chests.add(view);
                }
                result=Map.of("items",items,"chests",chests);
            }
            case "reward" -> {
                // Pays a player from the town treasury (warehouse chests), e.g. for a completed quest.
                Player player=Bukkit.getPlayerExact(string(action,"to",32));
                if(player==null||player.getWorld()!=body.getWorld()||player.getLocation().distanceSquared(body.getLocation())>64)throw new IllegalArgumentException("The player must be within 8 blocks");
                Material item=Material.matchMaterial(string(action,"target",64));
                int n=action.has("count")?Math.max(1,Math.min(64,action.get("count").getAsInt())):1;
                if(item==null)throw new IllegalArgumentException("Unknown item");
                int have=0;for(org.bukkit.block.Container chest:warehouseChests())have+=Arrays.stream(chest.getInventory().getContents()).filter(i->i!=null&&i.getType()==item).mapToInt(ItemStack::getAmount).sum();
                if(have<n)throw new IllegalArgumentException("The treasury only has "+have+" "+item.name());
                int left=n;
                for(org.bukkit.block.Container chest:warehouseChests()){
                    if(left==0)break;
                    int here=Arrays.stream(chest.getInventory().getContents()).filter(i->i!=null&&i.getType()==item).mapToInt(ItemStack::getAmount).sum();
                    int take=Math.min(here,left);if(take>0){chest.getInventory().removeItem(new ItemStack(item,take));left-=take;}
                }
                for(ItemStack over:player.getInventory().addItem(new ItemStack(item,n)).values())player.getWorld().dropItemNaturally(player.getLocation(),over);
                event("trade",Map.of("kind","reward","agent",actor.id,"to",player.getName(),"item",item.name(),"count",n));
                result=Map.of("rewarded",n,"item",item.name());
            }
            case "eat" -> {
                Material food=Material.matchMaterial(string(action,"target",64));
                if(food==null||!food.isEdible())throw new IllegalArgumentException("That is not food");
                if(!take(actor.id,food,1))throw new IllegalArgumentException("You have no "+food.name());
                int value=FOOD_VALUE.getOrDefault(food.name(),2);
                if(body instanceof LivingEntity living){
                    double max=living.getAttribute(org.bukkit.attribute.Attribute.MAX_HEALTH).getValue();
                    living.setHealth(Math.min(max,living.getHealth()+value));
                }
                result=Map.of("ate",food.name(),"value",value);
            }
            case "whisper" -> {
                Player player=Bukkit.getPlayerExact(string(action,"to",32));
                if(player==null)throw new IllegalArgumentException("That player is not online");
                player.sendMessage(Component.text("["+actor.id+" -> you] ",NamedTextColor.GOLD).append(Component.text(string(action,"text",240).replaceAll("[\\p{Cntrl}]"," "),NamedTextColor.WHITE)));
                result="whispered";
            }
            case "appraise" -> {
                Material item=Material.matchMaterial(string(action,"target",64));
                if(item==null)throw new IllegalArgumentException("Unknown item");
                result=Map.of("item",item.name(),"value",value(item),"margin",margin(actor));
            }
            case "sound" -> {
                String sound=string(action,"target",64).toLowerCase();
                if(!SOUNDS.contains(sound))throw new IllegalArgumentException("Sound not allowed");
                Location at=action.has("x")&&action.get("x").getAsDouble()!=0?new Location(body.getWorld(),number(action,"x"),number(action,"y"),number(action,"z")):body.getLocation();
                if(at.distanceSquared(body.getLocation())>64*64)throw new IllegalArgumentException("Too far away");
                float volume=action.has("count")?Math.max(0.2f,Math.min(4f,action.get("count").getAsFloat())):1f;
                body.getWorld().playSound(at,"minecraft:"+sound,sound.startsWith("music_disc")?SoundCategory.RECORDS:SoundCategory.NEUTRAL,volume,1f);
                result="played";
            }
            case "mood" -> {
                double m=action.has("count")?action.get("count").getAsDouble():0;
                actor.marginOverride=m>=0.8&&m<=2?m:0;result=Map.of("margin",margin(actor));
            }
            case "wage", "pay" -> {
                // Treasury transfers (any distance): wages out of the warehouse, payments into it.
                Material item=Material.matchMaterial(action.has("target")?string(action,"target",64):"EMERALD");
                int n=action.has("count")?Math.max(1,Math.min(64,action.get("count").getAsInt())):1;
                if(item==null)throw new IllegalArgumentException("Unknown item");
                if(type.equals("pay")){
                    if(!take(actor.id,item,n))throw new IllegalArgumentException("Not enough "+item.name());
                    org.bukkit.block.Container chest=warehouseChests().stream().filter(c->c.getInventory().firstEmpty()>=0||c.getInventory().contains(item)).findFirst().orElse(null);
                    if(chest==null){inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge(item.name(),n,Integer::sum);throw new IllegalArgumentException("The treasury is full");}
                    chest.getInventory().addItem(new ItemStack(item,n));result=Map.of("paid",n,"item",item.name());
                }else{
                    String to=string(action,"to",32);Actor payee=actors.get(to);
                    if(payee==null)throw new IllegalArgumentException("Unknown agent");
                    int have=0;for(org.bukkit.block.Container chest:warehouseChests())have+=Arrays.stream(chest.getInventory().getContents()).filter(i->i!=null&&i.getType()==item).mapToInt(ItemStack::getAmount).sum();
                    if(have<n)throw new IllegalArgumentException("The treasury only has "+have+" "+item.name());
                    int left=n;for(org.bukkit.block.Container chest:warehouseChests()){if(left==0)break;int here=Arrays.stream(chest.getInventory().getContents()).filter(i->i!=null&&i.getType()==item).mapToInt(ItemStack::getAmount).sum();int t=Math.min(here,left);if(t>0){chest.getInventory().removeItem(new ItemStack(item,t));left-=t;}}
                    inventories.computeIfAbsent(payee.id,k->new TreeMap<>()).merge(item.name(),n,Integer::sum);result=Map.of("paid",n,"to",payee.id,"item",item.name());
                }
                inventoryDirty=true;
            }
            case "adopt" -> {
                EntityType kind;try{kind=EntityType.valueOf(string(action,"target",16).toUpperCase());}catch(IllegalArgumentException x){throw new IllegalArgumentException("Pets can be WOLF or CAT");}
                if(kind!=EntityType.WOLF&&kind!=EntityType.CAT)throw new IllegalArgumentException("Pets can be WOLF or CAT");
                List<String> own=pets.computeIfAbsent(actor.id,k->new ArrayList<>());
                own.removeIf(id->Bukkit.getEntity(UUID.fromString(id))==null&&!body.getWorld().isChunkLoaded(body.getLocation().getBlockX()>>4,body.getLocation().getBlockZ()>>4));
                for(String id:own){Entity p=Bukkit.getEntity(UUID.fromString(id));if(p!=null&&p.getType()==kind&&!p.isDead())throw new IllegalArgumentException("Already has a "+kind.name().toLowerCase());}
                String name=string(action,"text",24).replaceAll("[\\p{Cntrl}]","");
                Entity pet=body.getWorld().spawnEntity(body.getLocation().clone().add(1,0,1),kind);
                if(pet instanceof Tameable t){t.setTamed(true);if(body instanceof AnimalTamer tamer)t.setOwner(tamer);}
                pet.customName(Component.text(name));pet.setCustomNameVisible(true);pet.setPersistent(true);
                if(pet instanceof LivingEntity l)l.setRemoveWhenFarAway(false);
                own.add(pet.getUniqueId().toString());inventoryDirty=true;
                result=Map.of("adopted",kind.name(),"name",name,"uuid",pet.getUniqueId().toString());
            }
            case "name" -> {
                Entity e=Bukkit.getEntity(UUID.fromString(string(action,"target",64)));
                if(!(e instanceof Animals)||e.getWorld()!=body.getWorld()||e.getLocation().distanceSquared(body.getLocation())>256)throw new IllegalArgumentException("Name an animal within 16 blocks");
                e.customName(Component.text(string(action,"text",24).replaceAll("[\\p{Cntrl}]","")));e.setCustomNameVisible(true);if(e instanceof LivingEntity l)l.setRemoveWhenFarAway(false);
                result="named";
            }
            case "pet" -> {
                Entity e=Bukkit.getEntity(UUID.fromString(string(action,"target",64)));
                if(!(e instanceof Animals)||e.getWorld()!=body.getWorld()||e.getLocation().distanceSquared(body.getLocation())>16)throw new IllegalArgumentException("Stand next to the animal");
                e.getWorld().spawnParticle(Particle.HEART,e.getLocation().add(0,1,0),4,0.3,0.3,0.3);
                if(body instanceof LivingEntity living)living.swingMainHand();
                result="petted";
            }
            case "find" -> {
                // Nearest blocks of a material (or animals of a type) around the agent, up to 12.
                String what=string(action,"target",32).toUpperCase();
                int r=action.has("count")?Math.max(4,Math.min(24,action.get("count").getAsInt())):16;
                Location at=body.getLocation();List<Map<String,Object>> found=new ArrayList<>();
                EntityType kind=null;try{kind=EntityType.valueOf(what);}catch(IllegalArgumentException x){}
                if(kind!=null){for(Entity e:body.getNearbyEntities(r,8,r))if(e.getType()==kind)found.add(Map.of("uuid",e.getUniqueId().toString(),"x",e.getLocation().getX(),"y",e.getLocation().getY(),"z",e.getLocation().getZ(),"named",e.customName()!=null));}
                else{
                    Material m=Material.matchMaterial(what);if(m==null||!m.isBlock())throw new IllegalArgumentException("Unknown block or animal");
                    for(int x=-r;x<=r;x++)for(int z=-r;z<=r;z++)for(int y=-8;y<=12;y++){
                        int bx=at.getBlockX()+x,bz=at.getBlockZ()+z;if(!at.getWorld().isChunkLoaded(bx>>4,bz>>4))continue;
                        Block b=at.getWorld().getBlockAt(bx,at.getBlockY()+y,bz);
                        if(b.getType()==m&&!placed.containsKey(key(b)))found.add(Map.of("x",bx,"y",b.getY(),"z",bz));
                    }
                }
                found.sort(Comparator.comparingDouble(p->Math.pow(((Number)p.get("x")).doubleValue()-at.getX(),2)+Math.pow(((Number)p.get("z")).doubleValue()-at.getZ(),2)));
                result=found.subList(0,Math.min(12,found.size()));
            }
            case "grant", "dismiss" -> {
                if(!getConfig().getStringList("visitor-agents").contains(actor.id))throw new IllegalArgumentException("Only visitors");
                if(type.equals("grant")){
                    Material item=Material.matchMaterial(string(action,"target",64));int n=action.has("count")?Math.max(1,Math.min(64,action.get("count").getAsInt())):1;
                    if(item==null||!item.isItem())throw new IllegalArgumentException("Unknown item");
                    inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge(item.name(),n,Integer::sum);inventoryDirty=true;result="granted";
                }else{
                    actor.npc.destroy();actors.remove(actor.id);inventories.remove(actor.id);held.remove(actor.id);inventoryDirty=true;result="dismissed";
                    event("action",Map.of("agent",actor.id,"action","dismissed","result","left town"));
                    return result;
                }
            }
            case "expand" -> {
                // Annex land: grow the roaming radius and keep every chunk inside it loaded.
                int radius=action.has("count")?action.get("count").getAsInt():0;
                int current=(int)loadedRadius();
                if(radius<current||radius>112)throw new IllegalArgumentException("New radius must be between "+current+" and 112");
                getConfig().set("loaded-radius",radius);saveConfig();
                World w=origin.getWorld();int cx=origin.getBlockX()>>4,cz=origin.getBlockZ()>>4,span=(radius>>4)+2,loaded=0;
                for(int x=cx-span;x<=cx+span;x++)for(int z=cz-span;z<=cz+span;z++){
                    double dx=(x<<4)+8-origin.getX(),dz=(z<<4)+8-origin.getZ();
                    if(Math.hypot(dx,dz)<=radius+16){if(!w.isChunkForceLoaded(x,z)){w.setChunkForceLoaded(x,z,true);loaded++;}}
                }
                result=Map.of("radius",radius,"newChunks",loaded);
            }
            case "fish" -> {
                // Cast, wait for a bite, then reel in. Needs a rod in hand and open water within 4 blocks.
                if(!"FISHING_ROD".equals(held.get(actor.id)))throw new IllegalArgumentException("Hold a fishing rod first");
                Block water=null;Location at=body.getLocation();
                for(int dx=-4;dx<=4&&water==null;dx++)for(int dz=-4;dz<=4&&water==null;dz++)for(int dy=-3;dy<=0&&water==null;dy++){
                    Block b=at.getBlock().getRelative(dx,dy,dz);
                    if(b.getType()==Material.WATER&&b.getRelative(BlockFace.UP).getType().isAir())water=b;
                }
                if(water==null)throw new IllegalArgumentException("No open water within 4 blocks");
                long now=System.currentTimeMillis();
                if(actor.fishReadyAt==0){
                    double speed=body.getWorld().hasStorm()?0.8:1.0;
                    actor.fishReadyAt=now+(long)((5000+random.nextInt(20000))*speed);
                    if(body instanceof LivingEntity living)living.swingMainHand();
                    body.getWorld().playSound(water.getLocation(),"minecraft:entity.fishing_bobber.throw",SoundCategory.NEUTRAL,0.8f,1f);
                    result=Map.of("cast",true,"waitMs",actor.fishReadyAt-now);break;
                }
                if(now<actor.fishReadyAt){result=Map.of("waiting",true,"waitMs",actor.fishReadyAt-now);break;}
                actor.fishReadyAt=0;
                int roll=random.nextInt(100);List<Object[]> table=roll<85?FISH:roll<95?JUNK:TREASURE;
                int total=table.stream().mapToInt(o->(Integer)o[1]).sum(),pick=random.nextInt(total);String caught="COD";
                for(Object[] o:table){pick-=(Integer)o[1];if(pick<0){caught=(String)o[0];break;}}
                addOrDrop(actor,new ItemStack(Material.valueOf(caught)));
                body.getWorld().spawnParticle(Particle.SPLASH,water.getLocation().add(0.5,1,0.5),12,0.3,0.1,0.3);
                body.getWorld().playSound(water.getLocation(),"minecraft:entity.fishing_bobber.splash",SoundCategory.NEUTRAL,0.8f,1f);
                if(body instanceof LivingEntity living)living.swingMainHand();
                boolean broke=++actor.rodUses>=getConfig().getInt("rod-durability",64);
                if(broke){actor.rodUses=0;take(actor.id,Material.FISHING_ROD,1);body.getWorld().playSound(at,"minecraft:entity.item.break",SoundCategory.NEUTRAL,1f,1f);}
                inventoryDirty=true;
                event("action",Map.of("agent",actor.id,"action","fish","result",caught));
                result=Map.of("caught",caught,"kind",table==FISH?"fish":table==JUNK?"junk":"treasure","rodBroke",broke,"rodUsesLeft",getConfig().getInt("rod-durability",64)-actor.rodUses);
            }
            case "forage" -> {
                // Wild food: ripe sweet berries, mushrooms, or shaking oak leaves for an apple.
                Block b=target(actor,action,5).getBlock();Map<String,Integer> got=new TreeMap<>();
                Material t=b.getType();
                if(t==Material.SWEET_BERRY_BUSH&&b.getBlockData() instanceof Ageable age){
                    if(age.getAge()<2)throw new IllegalArgumentException("Those berries are not ripe yet");
                    int n=age.getAge()==3?2+random.nextInt(2):1+random.nextInt(2);
                    age.setAge(1);b.setBlockData(age);got.put("SWEET_BERRIES",n);
                    body.getWorld().playSound(b.getLocation(),"minecraft:block.sweet_berry_bush.pick_berries",SoundCategory.BLOCKS,1f,1f);
                }else if(t==Material.RED_MUSHROOM||t==Material.BROWN_MUSHROOM){
                    b.setType(Material.AIR);placed.remove(key(b));got.put(t.name(),1);
                }else if(HERBS.contains(t.name())&&!placed.containsKey(key(b))){
                    // Wild flowers and herbs (the herbalist's ingredients).
                    b.setType(Material.AIR);got.put(t.name(),1);
                }else if(t==Material.SUGAR_CANE&&b.getRelative(org.bukkit.block.BlockFace.DOWN).getType()==Material.SUGAR_CANE){
                    // Cut the cane above the root so it grows back.
                    int n=0;Block top=b;while(top.getType()==Material.SUGAR_CANE&&n<3){n++;top=top.getRelative(org.bukkit.block.BlockFace.UP);}
                    for(Block c=top.getRelative(org.bukkit.block.BlockFace.DOWN);c.getY()>=b.getY();c=c.getRelative(org.bukkit.block.BlockFace.DOWN))c.setType(Material.AIR);
                    got.put("SUGAR_CANE",n);
                }else if(t==Material.OAK_LEAVES||t==Material.DARK_OAK_LEAVES){
                    long now=System.currentTimeMillis();Long last=shaken.get(key(b));
                    if(last!=null&&now-last<600000)throw new IllegalArgumentException("Already shaken; try another tree");
                    shaken.put(key(b),now);if(shaken.size()>2000)shaken.clear();
                    body.getWorld().spawnParticle(Particle.BLOCK,b.getLocation().add(0.5,0.5,0.5),10,0.3,0.3,0.3,b.getBlockData());
                    if(random.nextInt(100)<8)got.put("APPLE",1);
                    if(random.nextInt(100)<5)got.put(t==Material.OAK_LEAVES?"OAK_SAPLING":"DARK_OAK_SAPLING",1);
                }else throw new IllegalArgumentException("Nothing to forage there");
                for(Map.Entry<String,Integer> e:got.entrySet())addOrDrop(actor,new ItemStack(Material.valueOf(e.getKey()),e.getValue()));
                if(body instanceof LivingEntity living)living.swingMainHand();
                inventoryDirty=true;result=Map.of("foraged",got);
            }
            case "largechest" -> {
                // A named double chest: x,y,z is one half, target the direction its front faces.
                Block a=target(actor,action,6).getBlock();
                BlockFace facing;try{facing=BlockFace.valueOf(string(action,"target",8).toUpperCase());}catch(IllegalArgumentException x){throw new IllegalArgumentException("Face NORTH, SOUTH, EAST or WEST");}
                BlockFace side=switch(facing){case NORTH->BlockFace.EAST;case EAST->BlockFace.SOUTH;case SOUTH->BlockFace.WEST;case WEST->BlockFace.NORTH;default->throw new IllegalArgumentException("Face NORTH, SOUTH, EAST or WEST");};
                Block b=a.getRelative(side);
                for(Block x:List.of(a,b))if(!x.getType().isAir()&&!x.isReplaceable())throw new IllegalArgumentException("No room for a large chest there");
                boolean free=action.has("free")&&action.get("free").getAsBoolean();
                if(getConfig().getBoolean("economy")&&!free&&!take(actor.id,Material.CHEST,2))throw new IllegalArgumentException("Out of CHEST; a large chest needs 2");
                org.bukkit.block.data.type.Chest left=(org.bukkit.block.data.type.Chest)Material.CHEST.createBlockData(),right=(org.bukkit.block.data.type.Chest)Material.CHEST.createBlockData();
                left.setFacing(facing);left.setType(org.bukkit.block.data.type.Chest.Type.LEFT);right.setFacing(facing);right.setType(org.bukkit.block.data.type.Chest.Type.RIGHT);
                a.setBlockData(left,false);b.setBlockData(right,false);
                String label=action.has("text")?string(action,"text",40):"";
                for(Block x:List.of(a,b)){placed.put(key(x),"CHEST");if(!label.isBlank()&&x.getState() instanceof Chest c){c.customName(Component.text(label));c.update();}}
                placedDirty=true;
                if(body instanceof LivingEntity living)living.swingMainHand();
                event("block",Map.of("kind","agent_place","agent",actor.id,"block",block(a)));
                result=Map.of("placed","large chest","label",label);
            }
            case "brew" -> {
                // Herbal remedies from wild ingredients (the town has no nether): HEALING, SWIFTNESS, NIGHT_VISION, SPLASH_HEALING.
                String kind=string(action,"target",32).toUpperCase();
                int n=action.has("count")?Math.max(1,Math.min(8,action.get("count").getAsInt())):1,made=0;
                List<String> herbs=HERBS.stream().sorted().toList();
                if(!List.of("HEALING","SWIFTNESS","NIGHT_VISION","SPLASH_HEALING").contains(kind))throw new IllegalArgumentException("Brew HEALING, SWIFTNESS, NIGHT_VISION or SPLASH_HEALING");
                for(int i=0;i<n;i++){
                    List<String> second=switch(kind){case "SWIFTNESS"->List.of("SUGAR","SUGAR_CANE");case "NIGHT_VISION"->List.of("GOLDEN_CARROT","CARROT");default->FRUIT;};
                    int herbsNeed=kind.equals("SPLASH_HEALING")?2:1,secondNeed=kind.equals("HEALING")?2:kind.equals("SPLASH_HEALING")?3:1;
                    if(countAny(actor.id,herbs)<herbsNeed||countAny(actor.id,second)<secondNeed)break;
                    takeAny(actor.id,herbs,herbsNeed);takeAny(actor.id,second,secondNeed);made++;
                }
                if(made==0)throw new IllegalArgumentException("Missing ingredients for "+kind.toLowerCase().replace('_',' '));
                potions.computeIfAbsent(actor.id,k->new TreeMap<>()).merge(kind,made,Integer::sum);inventoryDirty=true;
                body.getWorld().playSound(body.getLocation(),"minecraft:block.brewing_stand.brew",SoundCategory.BLOCKS,1f,1f);
                body.getWorld().spawnParticle(Particle.WITCH,body.getLocation().add(0,1.2,0),12,0.3,0.3,0.3,0);
                result=Map.of("brewed",kind,"count",made);
            }
            case "dose" -> {
                // Give a potion to an agent or player within 5 blocks (or drink it: "to" = self); a splash heals everyone within 4 blocks of the patient.
                String kind=string(action,"target",32).toUpperCase();
                Map<String,Integer> mine=potions.computeIfAbsent(actor.id,k->new TreeMap<>());
                if(mine.getOrDefault(kind,0)<1)throw new IllegalArgumentException("You have no "+kind.toLowerCase().replace('_',' ')+" potion");
                String to=action.has("to")&&!string(action,"to",32).isBlank()?string(action,"to",32):actor.id;
                LivingEntity patient=null;
                Player player=Bukkit.getPlayerExact(to);Actor mate=actors.get(to);
                if(player!=null)patient=player;else if(mate!=null&&mate.npc.isSpawned()&&mate.npc.getEntity() instanceof LivingEntity l)patient=l;
                if(patient==null||patient.getWorld()!=body.getWorld()||patient.getLocation().distanceSquared(body.getLocation())>25)throw new IllegalArgumentException("The patient must be within 5 blocks");
                List<LivingEntity> treated=new ArrayList<>(List.of(patient));
                if(kind.equals("SPLASH_HEALING"))for(Entity e:patient.getNearbyEntities(4,3,4))if(e instanceof LivingEntity l&&(e instanceof Player||CitizensAPI.getNPCRegistry().isNPC(e)))treated.add(l);
                for(LivingEntity l:treated){
                    switch(kind){
                        case "SWIFTNESS" -> l.addPotionEffect(new org.bukkit.potion.PotionEffect(org.bukkit.potion.PotionEffectType.SPEED,20*180,0));
                        case "NIGHT_VISION" -> l.addPotionEffect(new org.bukkit.potion.PotionEffect(org.bukkit.potion.PotionEffectType.NIGHT_VISION,20*300,0));
                        default -> {double max=l.getAttribute(org.bukkit.attribute.Attribute.MAX_HEALTH).getValue();l.setHealth(Math.min(max,l.getHealth()+8));}
                    }
                    l.getWorld().spawnParticle(Particle.HEART,l.getLocation().add(0,2,0),3,0.3,0.2,0.3,0);
                }
                mine.merge(kind,-1,Integer::sum);mine.remove(kind,0);inventoryDirty=true;
                body.getWorld().playSound(patient.getLocation(),kind.startsWith("SPLASH")?"minecraft:entity.splash_potion.break":"minecraft:entity.generic.drink",SoundCategory.NEUTRAL,1f,1f);
                if(body instanceof LivingEntity living)living.swingMainHand();
                result=Map.of("dosed",to,"potion",kind,"treated",treated.size());
            }
            case "climate" -> {
                // Crop growth rate in the town (percent of normal): seasons and droughts.
                growthPct=Math.max(0,Math.min(100,action.get("count").getAsInt()));
                result=Map.of("growth",growthPct);
            }
            case "prices" -> {
                // Live trade values set by the merchant (supply and demand); an empty map clears them.
                priceOverride.clear();
                if(action.has("spec")&&action.get("spec").isJsonObject())for(Map.Entry<String,JsonElement> e:action.getAsJsonObject("spec").entrySet()){
                    Material m=Material.matchMaterial(e.getKey());
                    if(m!=null&&e.getValue().isJsonPrimitive())priceOverride.put(m.name(),Math.max(0.01,Math.min(1000,e.getValue().getAsDouble())));
                }
                result=Map.of("prices",priceOverride.size());
            }
            case "pillar" -> {
                // Climbing out (2.30.0): up one block at a time, a block from the pack (dirt, else cobblestone) set where
                // the feet were - the miner's way out of a hole or a shaft. Stops without headroom; up to 12 at once.
                int n=Math.max(1,Math.min(12,action.has("count")?action.get("count").getAsInt():1)),up=0;
                Material use=null;for(Material m:List.of(Material.DIRT,Material.COBBLESTONE,Material.COBBLED_DEEPSLATE))if(count(actor.id,m)>0){use=m;break;}
                for(int i=0;i<n&&use!=null&&count(actor.id,use)>0;i++){
                    Block feet=body.getLocation().getBlock();
                    if(!feet.isPassable()||!feet.getRelative(BlockFace.UP).isPassable()||!feet.getRelative(BlockFace.UP,2).isPassable())break;
                    actor.npc.getNavigator().cancelNavigation();
                    actor.npc.teleport(feet.getLocation().add(0.5,1,0.5),org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
                    feet.setType(use,false);take(actor.id,use,1);placed.put(key(feet),use.name());placedDirty=true;up++;
                }
                inventoryDirty=true;
                result=Map.of("climbed",up,"block",use==null?"none":use.name());
            }
            case "caravan" -> {
                // A passing caravan buys the town's surplus (2.30.0): the goods leave the town for good (the runtime
                // credits the town). target item, count (the whole stack in the pack when omitted).
                Material item=Material.matchMaterial(string(action,"target",64));
                if(item==null)throw new IllegalArgumentException("Unknown item");
                int n=Math.min(count(actor.id,item),action.has("count")?Math.max(1,action.get("count").getAsInt()):count(actor.id,item));
                if(n<1)throw new IllegalArgumentException("You have no "+item.name());
                take(actor.id,item,n);inventoryDirty=true;
                event("trade",Map.of("kind","caravan","agent",actor.id,"item",item.name(),"count",n));
                result=Map.of("sold",n,"item",item.name());
            }
            case "labels" -> {
                // Chest labels (2.28.0): spec {labels:[[x,y,z,"line|line"],...]} - a small floating text on the chest's front
                // (a text display: no hitbox, the chest opens as before) and the same as the chest's window title. "" removes.
                JsonArray list=action.has("spec")&&action.get("spec").isJsonObject()&&action.getAsJsonObject("spec").has("labels")?action.getAsJsonObject("spec").getAsJsonArray("labels"):new JsonArray();
                int n=0;
                for(JsonElement el:list){
                    JsonArray a=el.getAsJsonArray();
                    Block b=body.getWorld().getBlockAt(a.get(0).getAsInt(),a.get(1).getAsInt(),a.get(2).getAsInt());
                    if(!b.getWorld().isChunkLoaded(b.getX()>>4,b.getZ()>>4)||!chestLike(b.getType()))continue;
                    labelChest(b,a.get(3).getAsString());n++;
                }
                result=Map.of("labelled",n);
            }
            case "market" -> {
                // The trader's market (2.27.0). text = setup | stock | stockup.
                //   setup:   spec {chests:[[x,y,z,facing,LEFT|RIGHT|SINGLE],...]} - chests stood in the market hall (each one
                //            taken from the warehouse) and registered as market stock, apart from the warehouse
                //   stock:   {items, chests:[{x,y,z,size,free,items}]}
                //   stockup: target item, count - from the actor's pack into the market chests (within 12 blocks)
                String op=string(action,"text",16).toLowerCase(Locale.ROOT);
                // to = the shop (default: the trader's market); only the trader and the chef keep a shop (2.29.0)
                String shop=action.has("to")&&!action.get("to").getAsString().isBlank()?action.get("to").getAsString():marketAgent();
                if(!SHOPKEEPERS.contains(shop)&&!shop.equals(marketAgent()))throw new IllegalArgumentException("Only the trader and the chef keep a shop");
                List<String> keys=new ArrayList<>(getConfig().getStringList(shopKey(shop)));
                switch(op){
                    case "setup" -> {
                        JsonArray list=action.has("spec")&&action.get("spec").isJsonObject()&&action.getAsJsonObject("spec").has("chests")?action.getAsJsonObject("spec").getAsJsonArray("chests"):new JsonArray();
                        int made=0,adopted=0;List<String> short_=new ArrayList<>();
                        for(JsonElement el:list){
                            JsonArray c=el.getAsJsonArray();
                            Block b=body.getWorld().getBlockAt(c.get(0).getAsInt(),c.get(1).getAsInt(),c.get(2).getAsInt());
                            if(outsideArea(b.getLocation(),0))throw new IllegalArgumentException("Outside the town");
                            if(!chestLike(b.getType())){
                                if(!b.getType().isAir()&&!b.isReplaceable()){short_.add(b.getX()+","+b.getY()+","+b.getZ()+" occupied");continue;}
                                boolean took=false;
                                for(org.bukkit.block.Container w:warehouseChests())if(w.getInventory().containsAtLeast(new ItemStack(Material.CHEST),1)){w.getInventory().removeItem(new ItemStack(Material.CHEST,1));took=true;break;}
                                if(!took){short_.add("no chest in the warehouse for "+b.getX()+","+b.getY()+","+b.getZ());continue;}
                                org.bukkit.block.data.type.Chest data=(org.bukkit.block.data.type.Chest)Material.CHEST.createBlockData();
                                try{data.setFacing(BlockFace.valueOf(c.get(3).getAsString().toUpperCase(Locale.ROOT)));}catch(RuntimeException x){data.setFacing(BlockFace.SOUTH);}
                                try{data.setType(org.bukkit.block.data.type.Chest.Type.valueOf(c.get(4).getAsString().toUpperCase(Locale.ROOT)));}catch(RuntimeException x){}
                                b.setBlockData(data,false);made++;
                            }else adopted++;
                            placed.put(key(b),"CHEST");placedDirty=true;
                            if(!keys.contains(key(b)))keys.add(key(b));
                        }
                        getConfig().set(shopKey(shop),keys);saveConfig();
                        result=Map.of("made",made,"adopted",adopted,"problems",short_,"chests",keys.size());
                    }
                    case "stock" -> {
                        Map<String,Integer> items=new TreeMap<>();List<Object> chests=new ArrayList<>();
                        for(org.bukkit.block.Container chest:shopChests(shop)){
                            Map<String,Integer> own=new TreeMap<>();
                            for(ItemStack i:chest.getInventory().getContents())if(i!=null&&!i.getType().isAir()){items.merge(i.getType().name(),i.getAmount(),Integer::sum);own.merge(i.getType().name(),i.getAmount(),Integer::sum);}
                            chests.add(Map.of("x",chest.getX(),"y",chest.getY(),"z",chest.getZ(),"size",chest.getInventory().getSize(),"free",(int)Arrays.stream(chest.getInventory().getContents()).filter(i->i==null||i.getType().isAir()).count(),"items",own));
                        }
                        result=Map.of("items",items,"chests",chests);
                    }
                    case "stockup" -> {
                        Material item=Material.matchMaterial(string(action,"target",64));
                        if(item==null)throw new IllegalArgumentException("Unknown item");
                        List<org.bukkit.block.Container> market=shopChests(shop);
                        if(market.isEmpty())throw new IllegalArgumentException("The market has no stock chests");
                        if(market.stream().noneMatch(c->c.getLocation().distanceSquared(body.getLocation())<=144))throw new IllegalArgumentException("Too far from the market stalls");
                        int want=Math.min(count(actor.id,item),action.has("count")?Math.max(1,action.get("count").getAsInt()):count(actor.id,item));
                        if(want<1)throw new IllegalArgumentException("You have no "+item.name());
                        int moved=0;
                        for(org.bukkit.block.Container c:market){
                            while(moved<want){int n=Math.min(item.getMaxStackSize(),want-moved);
                                int back=c.getInventory().addItem(new ItemStack(item,n)).values().stream().mapToInt(ItemStack::getAmount).sum();
                                moved+=n-back;if(back>0)break;}
                            if(moved>=want)break;
                        }
                        if(moved>0)take(actor.id,item,moved);
                        if(moved==0)throw new IllegalArgumentException("The market stalls are full");
                        event("trade",Map.of("kind","market_stock","agent",actor.id,"item",item.name(),"count",moved));
                        result=Map.of("stocked",moved,"item",item.name());
                    }
                    default -> throw new IllegalArgumentException("market: setup | stock | stockup");
                }
            }
            case "adoptchests" -> {
                // Register chests already standing inside a building the agents made (e.g. the warehouse) as town chests.
                int x0=(int)Math.floor(number(action,"x")),z0=(int)Math.floor(number(action,"z"));
                int w=Math.max(1,Math.min(16,action.get("width").getAsInt())),d=Math.max(1,Math.min(16,action.get("depth").getAsInt()));
                if(outsideArea(new Location(body.getWorld(),x0,origin.getY(),z0),0))throw new IllegalArgumentException("Outside the town");
                int y0=body.getLocation().getBlockY(),found=0;
                for(int i=0;i<w;i++)for(int k=0;k<d;k++)for(int y=y0-3;y<=y0+3;y++){
                    Block b=body.getWorld().getBlockAt(x0+i,y,z0+k);
                    if(chestLike(b.getType())&&placed.putIfAbsent(key(b),"CHEST")==null)found++;   // copper chests too
                }
                placedDirty|=found>0;result=Map.of("adopted",found);
            }
            case "site" -> {
                // Excavation sites (agent-core/roles/miner.mjs): a registered box where mining is allowed above mine-max-y
                // (a clay pit, a quarry). text = register | unregister; x,y,z = corner; width,height,depth = size (max 48x48x40).
                String op=string(action,"text",16).toLowerCase(Locale.ROOT);
                int x=(int)Math.floor(number(action,"x")),y=(int)Math.floor(number(action,"y")),z=(int)Math.floor(number(action,"z"));
                int w=action.get("width").getAsInt(),h=action.get("height").getAsInt(),dpt=action.get("depth").getAsInt();
                if(w<1||h<1||dpt<1||w>48||dpt>48||h>40)throw new IllegalArgumentException("Site size must be 1-48 x 1-40 x 1-48");
                {Location home=spawnPoint(actor.id);if(Math.hypot(x+w/2.0-home.getX(),z+dpt/2.0-home.getZ())>loadedRadius()+64)throw new IllegalArgumentException("Excavation sites must be near town (within the loaded radius)");}
                List<Map<String,Object>> sites=new ArrayList<>();
                for(Map<?,?> m:getConfig().getMapList("excavation-sites")){Map<String,Object> c=new LinkedHashMap<>();for(Map.Entry<?,?> e:m.entrySet())c.put(String.valueOf(e.getKey()),e.getValue());sites.add(c);}
                Map<String,Object> box=new LinkedHashMap<>(Map.of("x1",x,"y1",y,"z1",z,"x2",x+w-1,"y2",y+h-1,"z2",z+dpt-1));
                sites.removeIf(m->m.get("x1").equals(x)&&m.get("z1").equals(z));
                if(op.equals("register"))sites.add(box);else if(!op.equals("unregister"))throw new IllegalArgumentException("site text must be register or unregister");
                getConfig().set("excavation-sites",sites);saveConfig();
                event("action",Map.of("agent",actor.id,"action","site","result",op+" "+x+","+y+","+z));
                result=Map.of("sites",sites.size(),op,box);
            }
            case "property" -> {
                // Private chests (agent-core/skills/property.mjs): text register | unregister | contents at x,y,z.
                // Registered chests are left out of the warehouse; agents still reach them with deposit/withdraw.
                String op=string(action,"text",16).toLowerCase(Locale.ROOT);
                int x=(int)Math.floor(number(action,"x")),y=(int)Math.floor(number(action,"y")),z=(int)Math.floor(number(action,"z"));
                String k=x+","+y+","+z;List<String> list=new ArrayList<>(getConfig().getStringList("private-chests"));
                Block b=body.getWorld().getBlockAt(x,y,z);
                switch(op){
                    case "register" -> {if(!(b.getState() instanceof Chest))throw new IllegalArgumentException("No chest at "+k);if(!list.contains(k)){list.add(k);getConfig().set("private-chests",list);saveConfig();}result=Map.of("registered",k);}
                    case "unregister" -> {list.remove(k);getConfig().set("private-chests",list);saveConfig();result=Map.of("unregistered",k);}
                    case "contents" -> {
                        if(!(b.getState() instanceof Chest chest))throw new IllegalArgumentException("No chest at "+k);
                        Map<String,Integer> items=new TreeMap<>();for(ItemStack i:chest.getInventory().getContents())if(i!=null&&!i.getType().isAir())items.merge(i.getType().name(),i.getAmount(),Integer::sum);
                        result=Map.of("items",items,"private",list.contains(k));
                    }
                    default -> throw new IllegalArgumentException("property text must be register, unregister or contents");
                }
            }
            case "vault" -> {
                // text = count | deposit | withdraw | mint | to_treasury; count = emeralds (1-64). The runtime keeps the
                // ledger and calls this only after it has checked identity and balances.
                if(action.has("width")&&action.get("width").getAsInt()>0){
                    List<Integer> box=List.of((int)Math.floor(number(action,"x")),(int)Math.floor(number(action,"y")),(int)Math.floor(number(action,"z")),
                        action.get("width").getAsInt(),Math.max(1,action.get("height").getAsInt()),action.get("depth").getAsInt());
                    if(!box.equals(getConfig().getIntegerList("bank-vault-box"))){
                        if(box.get(3)*box.get(4)*box.get(5)>64)throw new IllegalArgumentException("Vault box too large");
                        getConfig().set("bank-vault-box",box);saveConfig();
                    }
                }
                String op=string(action,"text",16).toLowerCase(Locale.ROOT);
                int n=action.has("count")?Math.max(1,Math.min(64,action.get("count").getAsInt())):1;
                List<Chest> chests=vaultChests(body.getWorld());
                // Moving coins from the strongbox into the new vault chests (once the bank is built).
                int boxed=count(STRONGBOX,Material.EMERALD);
                if(!chests.isEmpty()&&boxed>0){int left=vaultPut(chests,boxed);take(STRONGBOX,Material.EMERALD,boxed-left);}
                int have=vaultCount(chests);
                switch(op){
                    case "count" -> {}
                    case "deposit" -> {
                        if(!take(actor.id,Material.EMERALD,n))throw new IllegalArgumentException("Not enough EMERALD");
                        int left=vaultPut(chests,n);
                        if(left>0){inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge("EMERALD",left,Integer::sum);vaultTake(chests,n-left);inventoryDirty=true;throw new IllegalArgumentException("The vault is full");}
                        have+=n;
                    }
                    case "withdraw" -> {
                        if(have<n)throw new IllegalArgumentException("The vault only has "+have+" EMERALD");
                        vaultTake(chests,n);inventories.computeIfAbsent(actor.id,k->new TreeMap<>()).merge("EMERALD",n,Integer::sum);inventoryDirty=true;have-=n;
                    }
                    case "mint" -> {
                        String today=java.time.LocalDate.now().toString();
                        if(!today.equals(getConfig().getString("bank-mint-day","")))getConfig().set("bank-minted",0);
                        int minted=getConfig().getInt("bank-minted",0),cap=getConfig().getInt("bank-mint-per-day",256);
                        if(minted+n>cap)throw new IllegalArgumentException("Mint cap reached ("+minted+"/"+cap+" today)");
                        int left=vaultPut(chests,n);if(left>0){vaultTake(chests,n-left);throw new IllegalArgumentException("The vault is full");}
                        getConfig().set("bank-mint-day",today);getConfig().set("bank-minted",minted+n);saveConfig();have+=n;
                    }
                    case "grant" -> {
                        int left=vaultPut(chests,n);if(left>0){vaultTake(chests,n-left);throw new IllegalArgumentException("The vault is full");}have+=n;
                    }
                    case "from_treasury" -> {
                        List<org.bukkit.block.Container> treasury=warehouseChests();
                        int available=treasury.stream().mapToInt(c->Arrays.stream(c.getInventory().getContents()).filter(i->i!=null&&i.getType()==Material.EMERALD).mapToInt(ItemStack::getAmount).sum()).sum();
                        if(available<n)throw new IllegalArgumentException("Not enough treasury emeralds");
                        int left=vaultPut(chests,n);if(left>0){vaultTake(chests,n-left);throw new IllegalArgumentException("The vault is full");}
                        int remaining=n;for(org.bukkit.block.Container c:treasury){if(remaining==0)break;int here=Arrays.stream(c.getInventory().getContents()).filter(i->i!=null&&i.getType()==Material.EMERALD).mapToInt(ItemStack::getAmount).sum();int take=Math.min(here,remaining);if(take>0){c.getInventory().removeItem(new ItemStack(Material.EMERALD,take));remaining-=take;}}have+=n;
                    }
                    case "to_treasury" -> {
                        if(have<n)throw new IllegalArgumentException("The vault only has "+have+" EMERALD");
                        org.bukkit.block.Container chest=warehouseChests().stream().filter(c->Arrays.stream(c.getInventory().getStorageContents()).mapToInt(i->i==null||i.getType().isAir()?64:i.getType()==Material.EMERALD?Math.max(0,64-i.getAmount()):0).sum()>=n).findFirst().orElse(null);
                        if(chest==null)throw new IllegalArgumentException("The treasury is full");
                        vaultTake(chests,n);Map<Integer,ItemStack> over=chest.getInventory().addItem(new ItemStack(Material.EMERALD,n));
                        int back=over.values().stream().mapToInt(ItemStack::getAmount).sum();if(back>0){chest.getInventory().removeItem(new ItemStack(Material.EMERALD,n-back));vaultPut(chests,n);throw new IllegalArgumentException("The treasury is full");}have-=n;
                    }
                    default -> throw new IllegalArgumentException("vault text must be count, deposit, withdraw, mint or to_treasury");
                }
                event("bank",Map.of("agent",actor.id,"op",op,"count",n,"vault",have));
                int treasury=warehouseChests().stream().mapToInt(c->Arrays.stream(c.getInventory().getContents()).filter(i->i!=null&&i.getType()==Material.EMERALD).mapToInt(ItemStack::getAmount).sum()).sum();
                result=Map.of("vault",have,"treasury",treasury,"chests",chests.size(),"op",op);
            }
            case "confine" -> {
                // The court's jailer: puts the agent (a convicted citizen) on a given spot - a jail cell, the stocks, or
                // the jail door on release. The spot must be in this world, within 200 blocks, with room to stand.
                Location here=body.getLocation();
                Location to=new Location(body.getWorld(),number(action,"x"),number(action,"y"),number(action,"z"),here.getYaw(),here.getPitch());
                if(Math.hypot(to.getX()-here.getX(),to.getZ()-here.getZ())>200)throw new IllegalArgumentException("Too far to confine");
                Block feet=to.getBlock();
                if(!feet.isPassable()||!feet.getRelative(BlockFace.UP).isPassable()||!feet.getRelative(BlockFace.DOWN).getType().isSolid())throw new IllegalArgumentException("No room to stand there");
                {GlobalNavigation g=navs.get(actor.id);if(g!=null&&g.active())g.stop();}
                actor.npc.getNavigator().cancelNavigation();
                actor.npc.teleport(to,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
                event("action",Map.of("agent",actor.id,"action","confine","result","at "+to.getBlockX()+","+to.getBlockY()+","+to.getBlockZ()));
                result=Map.of("x",to.getX(),"y",to.getY(),"z",to.getZ());
            }
            case "unstick" -> {
                // A stranded agent (on a roof, in a hole) is moved to its own safe spot on the ground near spawn.
                actor.npc.getNavigator().cancelNavigation();
                Location safe=spawnPoint(actor.id);
                actor.npc.teleport(safe,org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
                event("action",Map.of("agent",actor.id,"action","unstick","result","moved to "+safe.getBlockX()+","+safe.getBlockY()+","+safe.getBlockZ()));
                result=Map.of("x",safe.getX(),"y",safe.getY(),"z",safe.getZ());
            }
            case "status" -> {
                actor.status=string(action,"text",200);
                JsonElement tag=action.get("tag");
                if(tag!=null&&tag.isJsonPrimitive()){
                    HologramTrait hologram=actor.npc.getOrAddTrait(HologramTrait.class);
                    String line=tag.getAsString().replaceAll("[\\p{Cntrl}]"," ");line=line.substring(0,Math.min(48,line.length()));
                    if(hologram.getLines().isEmpty())hologram.addLine(line);else hologram.setLine(0,line);
                }
                result="ok";
            }
            case "equip" -> {
                String name=string(action,"target",64).toUpperCase();
                String slot=armorSlot(name);
                if(slot!=null){
                    Material piece=Material.matchMaterial(name);
                    if(piece==null||count(actor.id,piece)<1)throw new IllegalArgumentException("You do not have that armour");
                    armor.computeIfAbsent(actor.id,k->new HashMap<>()).put(slot,piece.name());inventoryDirty=true;applyArmor(actor);
                    result="wearing "+piece.name();break;
                }
                if(name.equals("NONE")||name.isBlank())held.remove(actor.id);
                else{
                    Material item=Material.matchMaterial(name);
                    if(item==null||inventories.getOrDefault(actor.id,Map.of()).getOrDefault(item.name(),0)<1)throw new IllegalArgumentException("You do not have that item");
                    held.put(actor.id,item.name());
                }
                inventoryDirty=true;applyHeld(actor);result="holding "+held.getOrDefault(actor.id,"NONE");
            }
            case "chat" -> {
                String text=string(action,"text",240).replaceAll("[\\p{Cntrl}]"," ");
                Component message=Component.text("["+actor.id+"] "+text);
                for(Player player:body.getWorld().getPlayers())if(player.getLocation().distanceSquared(body.getLocation())<=4096)player.sendMessage(message);
                event("chat",Map.of("agent",actor.id,"text",text));result="said";
                String bubble=text.length()>44?text.substring(0,41)+"...":text;
                actor.npc.getOrAddTrait(HologramTrait.class).addTemporaryLine("\u00a7f"+bubble,100);
            }
            case "interact" -> {
                if(!getConfig().getBoolean("allow-interact"))throw new IllegalArgumentException("Interaction disabled");
                Block block=target(actor,action,4).getBlock();BlockData data=block.getBlockData();
                if(data instanceof Openable open){open.setOpen(!open.isOpen());block.setBlockData(open);}
                else if(block.getType()==Material.LEVER&&data instanceof Powerable power){power.setPowered(!power.isPowered());block.setBlockData(power);}
                else throw new IllegalArgumentException("Only doors, gates, trapdoors and levers are supported");
                event("block",Map.of("kind","agent_interact","agent",actor.id,"block",block(block)));result="toggled";
            }
            case "attack" -> {
                if(!getConfig().getBoolean("allow-attack"))throw new IllegalArgumentException("Attack disabled");
                Entity entity=Bukkit.getEntity(UUID.fromString(string(action,"target",64)));
                if(!(entity instanceof LivingEntity victim)||entity instanceof Player||CitizensAPI.getNPCRegistry().isNPC(entity)
                    ||entity.getWorld()!=body.getWorld()||entity.getLocation().distanceSquared(body.getLocation())>9)
                    throw new IllegalArgumentException("Invalid or out-of-reach attack target");
                if(body instanceof LivingEntity living&&!living.hasLineOfSight(victim))throw new IllegalArgumentException("Target not visible");
                double damage=WEAPON_DAMAGE.getOrDefault(held.getOrDefault(actor.id,""),2.0);
                if(body instanceof LivingEntity living)living.swingMainHand();
                victim.damage(damage,body);wearHeld(actor,"SWORD","AXE");result=Map.of("damage",damage,"target_health",Math.max(0,victim.getHealth()));
            }
            default -> throw new IllegalArgumentException("Unsupported action");
        }
        event("action",Map.of("agent",actor.id,"action",type,"result",result));return result;
    }
    private Map<String,Object> position(Location location){
        Map<String,Object> result=new LinkedHashMap<>();result.put("world",location.getWorld().getName());
        result.put("x",location.getX());result.put("y",location.getY());result.put("z",location.getZ());return result;
    }
    private Map<String,Object> entity(Entity entity){
        Map<String,Object> result=position(entity.getLocation());result.put("uuid",entity.getUniqueId().toString());result.put("type",entity.getType().name());return result;
    }
    // "placed" marks blocks agents built, so a log in a wall is not remembered as a tree.
    private Map<String,Object> block(Block block){return placed.containsKey(key(block))?Map.of("type",block.getType().name(),"x",block.getX(),"y",block.getY(),"z",block.getZ(),"placed",true)
        :Map.of("type",block.getType().name(),"x",block.getX(),"y",block.getY(),"z",block.getZ());}
    private Object snapshot(Actor actor){
        Entity body=actor.npc.getEntity();Location location=body.getLocation();
        Map<String,Object> view=position(location);
        view.put("id",actor.id);view.put("uuid",body.getUniqueId().toString());
        view.put("health",body instanceof LivingEntity living?living.getHealth():0);
        view.put("pathing",actor.npc.getNavigator().isNavigating()||riding.containsKey(actor.id)||ferrying(actor));
        if(ferrying(actor))view.put("boating",true);
        {net.citizensnpcs.trait.SleepTrait z=actor.npc.getTraitNullable(net.citizensnpcs.trait.SleepTrait.class);view.put("sleeping",z!=null&&z.isSleeping());}
        view.put("sitting",sitting(actor));
        {org.bukkit.entity.Entity f=following(actor);if(f!=null)view.put("following",f.getName());}
        if(riding.containsKey(actor.id))view.put("riding",true);
        if(sentinel(actor))view.put("fighting",SentinelSupport.fighting(actor.npc));
        GlobalNavigation trip=riding.containsKey(actor.id)?horseNavs.get(actor.id):navs.get(actor.id);if(trip!=null&&trip.active())view.put("navigation",trip.state());
        view.put("inventory",new TreeMap<>(inventories.getOrDefault(actor.id,Map.of())));
        view.put("held",held.getOrDefault(actor.id,"NONE"));
        view.put("armor",new TreeMap<>(armor.getOrDefault(actor.id,Map.of())));
        Map<String,Integer> left=new TreeMap<>();
        for(String item:inventories.getOrDefault(actor.id,Map.of()).keySet()){int max=maxUses(item);if(max>0)left.put(item,max-wear.getOrDefault(actor.id,Map.of()).getOrDefault(item,0));}
        view.put("wear",left);
        view.put("potions",new TreeMap<>(potions.getOrDefault(actor.id,Map.of())));
        view.put("entities",body.getNearbyEntities(12,8,12).stream().limit(32).map(this::entity).toList());
        List<Object> blocks=new ArrayList<>();
        for(int x=-3;x<=3;x++)for(int y=-1;y<=2;y++)for(int z=-3;z<=3;z++){
            int bx=location.getBlockX()+x, bz=location.getBlockZ()+z;
            if(!body.getWorld().isChunkLoaded(bx>>4,bz>>4))continue;
            Block block=body.getWorld().getBlockAt(bx,location.getBlockY()+y,bz);
            if(!block.getType().isAir())blocks.add(block(block));
        }
        view.put("blocks",blocks);return view;
    }
    private void event(String name,Object data){
        Map<String,Object> message=Map.of("type","event","event",name,"seq",++seq,"time",System.currentTimeMillis(),"data",data);
        for(Map.Entry<WebSocket,Client> entry:clients.entrySet())if(entry.getValue().events.contains(name))send(entry.getKey(),message);
    }
    /** Seasons and droughts: crops in the town grow at growthPct percent of the normal rate. */
    @EventHandler(ignoreCancelled=true)
    public void onGrow(BlockGrowEvent event){
        if(growthPct>=100)return;
        Block b=event.getBlock();
        if(!GROWING.contains(b.getType())&&!GROWING.contains(event.getNewState().getType()))return;
        if(origin==null||b.getWorld()!=origin.getWorld())return;
        double r=loadedRadius()+16;
        if(b.getLocation().distanceSquared(origin)>r*r)return;
        if(random.nextInt(100)>=growthPct)event.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void chat(AsyncChatEvent event){
        String text=PlainTextComponentSerializer.plainText().serialize(event.message());
        UUID player=event.getPlayer().getUniqueId();
        enqueue(()->event("chat",Map.of("player",player.toString(),"text",text.substring(0,Math.min(text.length(),500)))));
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void move(PlayerMoveEvent event){
        Location a=event.getFrom(),b=event.getTo();if(b==null)return;
        if(a.getBlockX()!=b.getBlockX()||a.getBlockY()!=b.getBlockY()||a.getBlockZ()!=b.getBlockZ())
            event("movement",Map.of("player",event.getPlayer().getUniqueId().toString(),"position",position(b)));
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void broken(BlockBreakEvent e){
        boolean agentBuilt=placed.remove(key(e.getBlock()))!=null;placedDirty|=agentBuilt;
        if(playerPlaced.remove(key(e.getBlock())))inventoryDirty=true;
        if(agentBuilt)event("vandalism",Map.of("player",e.getPlayer().getName(),"block",block(e.getBlock())));
        event("block",Map.of("kind","break","block",block(e.getBlock()),"player",e.getPlayer().getUniqueId().toString()));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void placed(BlockPlaceEvent e){placedDirty|=placed.remove(key(e.getBlock()))!=null;if(playerPlaced.add(key(e.getBlock())))inventoryDirty=true;event("block",Map.of("kind","place","block",block(e.getBlock()),"player",e.getPlayer().getUniqueId().toString()));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void joined(PlayerJoinEvent e){
        if(getServer().getPluginManager().getPlugin("Chunky")!=null&&getConfig().getBoolean("pause-chunky-for-players",true))
            Bukkit.getScheduler().runTask(this,()->Bukkit.dispatchCommand(Bukkit.getConsoleSender(),"chunky pause"));event("player",Map.of("kind","join","name",e.getPlayer().getName(),"uuid",e.getPlayer().getUniqueId().toString()));}
    @EventHandler
    public void left(PlayerQuitEvent e){
        if(getServer().getPluginManager().getPlugin("Chunky")!=null&&getConfig().getBoolean("pause-chunky-for-players",true))
            Bukkit.getScheduler().runTaskLater(this,()->{if(Bukkit.getOnlinePlayers().isEmpty())Bukkit.dispatchCommand(Bukkit.getConsoleSender(),"chunky continue");},40L);event("player",Map.of("kind","quit","name",e.getPlayer().getName(),"uuid",e.getPlayer().getUniqueId().toString()));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void bred(EntityBreedEvent e){event("entity",Map.of("kind","bred","entity",entity(e.getEntity()),"parent",e.getMother().getUniqueId().toString()));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void spawn(EntitySpawnEvent e){event("entity",Map.of("kind","spawn","entity",entity(e.getEntity())));}
    @EventHandler(priority=EventPriority.MONITOR)
    public void death(EntityDeathEvent e){event("entity",Map.of("kind","death","entity",entity(e.getEntity())));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=true)
    public void damage(EntityDamageEvent e){event("entity",Map.of("kind","damage","entity",entity(e.getEntity()),"amount",e.getFinalDamage()));}
}
