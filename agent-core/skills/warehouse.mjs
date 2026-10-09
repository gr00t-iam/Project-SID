// The warehouse: every chest has a category, the clerk keeps them sorted, and anyone can ask where a material is.
//
//   CATEGORIES      building blocks, ores and metals, food and agriculture, tools and equipment, redstone and
//                   components, misc and valuables - and one input drop box where haulers (the courier) dump their loads
//   WarehouseMap    which chest holds which category (assigned once from what each chest already mostly holds, so
//                   little has to move), an overflow chest per category when its own fills up, locks so two
//                   citizens never work the same chest at once, and the location index (getMaterialLocation)
//   moves           what the clerk does next, in order: empty the drop box, move misfiled items to their category,
//                   and gather an item spread over several chests into one (partial stacks merge as they go in)
//
// Pure apart from the lock clock; roles/clerk.mjs runs it, civic.mjs routes deposits and withdrawals through it.

export const CATEGORIES=['BUILDING_BLOCKS','ORES_AND_METALS','FOOD_AND_AGRICULTURE','TOOLS_AND_EQUIPMENT','WEAPONS','REDSTONE_AND_COMPONENTS','MISC_AND_VALUABLES'];
export const DROP_BOX='INPUT_DROP_BOX';
const RULES=[
  // Weapons: swords, bows and arrows (axes, pickaxes, shovels and hoes are tools).
  ['WEAPONS',/(_SWORD$|^BOW$|^CROSSBOW$|^ARROW$|^SPECTRAL_ARROW$|^TIPPED_ARROW$|^TRIDENT$|^MACE$)/],
  ['TOOLS_AND_EQUIPMENT',/(_PICKAXE|_AXE|_SHOVEL|_HOE|_SWORD|_HELMET|_CHESTPLATE|_LEGGINGS|_BOOTS|^SHIELD$|^BOW$|^CROSSBOW$|^FISHING_ROD$|^SHEARS$|^FLINT_AND_STEEL$|^ARROW$|^BUCKET$|^WATER_BUCKET$|^SADDLE$)/],
  ['REDSTONE_AND_COMPONENTS',/(REDSTONE|REPEATER|COMPARATOR|PISTON|OBSERVER|HOPPER|DROPPER|DISPENSER|LEVER|_BUTTON$|_PRESSURE_PLATE$|^TORCH$|TRIPWIRE|RAIL$|^TNT$|DAYLIGHT_DETECTOR|TARGET)/],
  ['ORES_AND_METALS',/(^RAW_|_ORE$|_INGOT$|_NUGGET$|^COAL$|^CHARCOAL$|^DIAMOND$|^EMERALD_ORE|^LAPIS_LAZULI$|^QUARTZ$|^NETHERITE_SCRAP$|^FLINT$|^AMETHYST_SHARD$|^(IRON|GOLD|COPPER|COAL|DIAMOND|LAPIS|EMERALD|RAW_IRON|RAW_GOLD|RAW_COPPER)_BLOCK$)/],
  ['FOOD_AND_AGRICULTURE',/(SEEDS$|^WHEAT$|^HAY_BLOCK$|^BREAD$|^COOKIE$|^CAKE$|PIE$|^APPLE$|GOLDEN_CARROT|^CARROT$|POTATO$|^BEETROOT|MELON|PUMPKIN|BERRIES$|^SUGAR|^COCOA|^EGG$|^MILK|^BEEF$|^PORKCHOP$|^MUTTON$|^CHICKEN$|^RABBIT$|^COD$|^SALMON$|TROPICAL_FISH|PUFFERFISH|^COOKED_|STEW$|SOUP$|_SAPLING$|MUSHROOM$|^BONE_MEAL$|^KELP|^DRIED_KELP$|^HONEY|^BOWL$)/],
  ['BUILDING_BLOCKS',/(COBBLE|STONE|_PLANKS$|_LOG$|_WOOD$|^DIRT|GRAVEL|^SAND$|SANDSTONE|BRICK|TERRACOTTA|GLASS|_WOOL$|_STAIRS$|_SLAB$|_WALL$|_FENCE|_DOOR$|_TRAPDOOR$|ANDESITE|DIORITE|GRANITE|TUFF|DEEPSLATE|CALCITE|^CLAY|_CARPET$|LANTERN|^LADDER$|^CHEST$|^BARREL$|^STICK$|_LEAVES$|^MUD|MOSS|^IRON_BARS$|^CAULDRON$|_BED$)/],
];
/** The category of an item (anything unrecognised: misc and valuables). */
// Items that do not stack (a slot each).
const UNSTACKABLE=/(_BED$|_PICKAXE$|_AXE$|_SWORD$|_SHOVEL$|_HOE$|_HELMET$|_CHESTPLATE$|_LEGGINGS$|_BOOTS$|^BOW$|^CROSSBOW$|^SHIELD$|^POTION$|^SPLASH_POTION$|_BUCKET$|^BUCKET$|^SADDLE$|_BOAT$|^FISHING_ROD$|^SHEARS$|^FLINT_AND_STEEL$|^WRITTEN_BOOK$|^WRITABLE_BOOK$|^TRIDENT$|_STEW$|_SOUP$|^ENCHANTED_BOOK$|^TOTEM)/;
export function categoryOf(item){for(const [cat,re] of RULES)if(re.test(item))return cat;return 'MISC_AND_VALUABLES';}
const keyOf=c=>`${c.x},${c.y},${c.z}`;
/** Chest slots a set of items takes: beds, tools, potions one each; everything else stacks to 64. */
export const stackSize=item=>UNSTACKABLE.test(item)?1:64;
export const slotsUsed=items=>Object.entries(items??{}).reduce((a,[k,n])=>a+Math.ceil(n/stackSize(k)),0);

export class WarehouseMap{
  /** state: the persisted {assign:{chestKey: category|DROP_BOX}, overflow:{category: chestKey}} (town.warehouseMap). */
  constructor(state={}){this.state=state;state.assign??={};state.overflow??={};state.dedicated??={};this.locks=new Map();
    // One-time: chests given to an item of another category are released (their goods are then filed properly).
    if(!state.dedicateFixV1){state.dedicateFixV1=true;for(const [k,item] of Object.entries(state.dedicated)){const cat=state.assign[k];if(cat&&cat!=='OVERFLOW'&&cat!==categoryOf(item))delete state.dedicated[k];}}
    // One-time: the weapons get their own chests - the overflow chests (there is no overflow any more: what does not
    // fit in its own category's chests goes to the trader's market). Dedications that no longer match are released.
    if(!state.weaponsV1){state.weaponsV1=true;
      for(const [k,cat] of Object.entries(state.assign))if(cat==='OVERFLOW')state.assign[k]='WEAPONS';
      state.overflow={};
      for(const [k,item] of Object.entries(state.dedicated)){const cat=state.assign[k];if(cat&&cat!==categoryOf(item))delete state.dedicated[k];}}}
  /** The one item an emptied chest was given to (dedicated chests take nothing else), or null. */
  dedicatedTo(c){return this.state.dedicated[keyOf(c)]??null;}
  /**
   * Gives every chest a category, once (and any new chest later): the smallest chest becomes the drop box; each
   * category goes to the chest whose contents already match it best, so the first sort moves as little as possible.
   */
  assign(chests){
    const a=this.state.assign,free=chests.filter(c=>!a[keyOf(c)]);if(!free.length)return false;
    const used=new Set(Object.values(a));
    if(!used.has(DROP_BOX)){const box=[...free].sort((x,y)=>(x.size??54)-(y.size??54))[0];a[keyOf(box)]=DROP_BOX;free.splice(free.indexOf(box),1);}
    const match=(c,cat)=>Object.entries(c.items??{}).filter(([k])=>categoryOf(k)===cat).reduce((s,[,n])=>s+n,0)+(/food/i.test(c.name??'')&&cat==='FOOD_AND_AGRICULTURE'?1e6:0)+(/tool/i.test(c.name??'')&&cat==='TOOLS_AND_EQUIPMENT'?1e6:0);
    for(const cat of CATEGORIES.filter(x=>!Object.values(a).includes(x))){
      if(!free.length)break;
      const best=[...free].sort((x,y)=>match(y,cat)-match(x,cat))[0];a[keyOf(best)]=cat;free.splice(free.indexOf(best),1);
    }
    // More chests than categories: each extra goes to whichever category is fullest.
    for(const c of free){
      const fill=cat=>{const own=chests.filter(x=>a[keyOf(x)]===cat);const slots=own.reduce((n,x)=>n+(x.size??54),0);return slots?own.reduce((n,x)=>n+slotsUsed(x.items),0)/slots:1;};
      a[keyOf(c)]=[...CATEGORIES].sort((x,y)=>fill(y)-fill(x))[0];
    }
    return true;
  }
  categoryOfChest(c){return this.state.assign[keyOf(c)]??null;}
  dropBox(chests){return chests.find(c=>this.categoryOfChest(c)===DROP_BOX)??null;}
  /**
   * The chest an item should go into (count: how many are coming - beds, tools and potions take a slot each):
   * a chest already holding it, or given to it, with room; its category chest with room for the whole load; else an
   * EMPTY chest, which is then given to this one item (the drop box filled up with beds while 28 wall chests stood
   * empty - each move found a category chest with a slot or two and failed as "warehouse full"); else the overflow.
   */
  targetFor(item,chests,{agent=null,count=1,probe=false}={}){
    const cat=categoryOf(item),open=c=>(probe||!this.locked(c,agent))&&this.categoryOfChest(c)!=='RETIRED'&&this.categoryOfChest(c)!==DROP_BOX;   // retired: being emptied for removal
    const per=UNSTACKABLE.test(item)?1:64,slots=Math.max(1,Math.ceil(count/per));
    const ded=c=>this.dedicatedTo(c);
    const room=c=>(c.free??0)+(per>1&&(c.items?.[item]??0)%per>0?1:0)>=Math.min(slots,c.size??54)||(per>1&&count<=per-((c.items?.[item]??0)%per)&&(c.items?.[item]??0)%per>0);
    // 1. Where it already is (its own chest), or a chest given to it.
    const mine=chests.filter(c=>open(c)&&(ded(c)===item||(!ded(c)&&(c.items?.[item]??0)>0&&this.categoryOfChest(c)===cat))&&room(c)).sort((a,b)=>(ded(b)===item)-(ded(a)===item)||(b.items?.[item]??0)-(a.items?.[item]??0))[0];
    if(mine)return mine;
    // 2. Its category chest with room for the whole load (not one given to another item).
    const home=chests.filter(c=>this.categoryOfChest(c)===cat&&open(c)&&!ded(c));
    const used=c=>Object.values(c.items??{}).some(n=>n>0);
    const own=home.find(c=>used(c)&&room(c));if(own)return own;   // an empty chest is not "room": it is given to one item (3.)
    // 3. An empty chest: given to this item.
    // ...an empty chest of its own category, or an overflow chest - never another category's (bows and pickaxes had
    // spread over the food, ore and redstone chests, and were then moved round and round as "misfiled").
    const empty=c=>open(c)&&!ded(c)&&Object.values(c.items??{}).every(n=>!n)&&(c.free??0)>0;
    const fresh=home.find(empty);
    if(fresh){if(!probe)this.state.dedicated[keyOf(fresh)]=item;return fresh;}
    const fits=c=>!ded(c)&&(c.free>0||(c.items?.[item]??0)%64>0);
    // Any slot left in its own category's chests. Never another category's chest: when its own are full (stacks
    // merged), the rest goes to the trader's market (nextMove 'to_market').
    const partial=home.find(fits);if(partial)return partial;
    return null;
  }
  /** Where a material is: [{x,y,z,count,category}], most first (locked chests last). getMaterialLocation. */
  locationOf(item,chests){
    return chests.filter(c=>(c.items?.[item]??0)>0).map(c=>({x:c.x,y:c.y,z:c.z,count:c.items[item],category:this.categoryOfChest(c),locked:this.locked(c)}))
      .sort((a,b)=>(a.locked-b.locked)||b.count-a.count);
  }
  // ---- locks: one citizen per chest while they work it ----
  lock(c,agent,ms=15000,now=Date.now()){const k=keyOf(c),l=this.locks.get(k);if(l&&l.agent!==agent&&l.until>now)return false;this.locks.set(k,{agent,until:now+ms});return true;}
  unlock(c,agent){const k=keyOf(c);if(this.locks.get(k)?.agent===agent)this.locks.delete(k);}
  locked(c,agent=null,now=Date.now()){const l=this.locks.get(keyOf(c));return !!l&&l.until>now&&l.agent!==agent;}
  /**
   * The clerk's next move, in order of need: {kind:'drop_box'|'misfiled'|'consolidate', item, count, from, to}, or null.
   * At most 256 items per move (the plugin's limit for one withdrawal).
   */
  nextMove(chests,{agent=null,skip=()=>false}={}){   // skip(item): an item whose last move failed (no room anywhere)
    const box=this.dropBox(chests);
    // A chest given to one item that has emptied out is free again.
    for(const c of chests)if(this.dedicatedTo(c)&&Object.values(c.items??{}).every(n=>!n)&&!this.locked(c))delete this.state.dedicated[keyOf(c)];
    const move=(kind,item,from,count)=>{const n=Math.min(256,count),to=this.targetFor(item,chests,{agent,count:n});
      if(to)return keyOf(to)!==keyOf(from)?{kind,item,count:n,from,to}:null;
      // Its own category is full (not just busy): it goes to the market.
      return kind!=='consolidate'&&!this.targetFor(item,chests,{count:n,probe:true})?{kind:'to_market',item,count:n,from,why:kind}:null;};
    // Chests being retired (the old floor chests): emptied into the wall chests before anything else.
    for(const c of chests)if(this.categoryOfChest(c)==='RETIRED')for(const [item,n] of Object.entries(c.items??{}))if(n>0&&!skip(item)){const m=move('retire',item,c,n);if(m)return m;}
    if(box)for(const [item,n] of Object.entries(box.items??{}))if(n>0&&!skip(item)){const m=move('drop_box',item,box,n);if(m)return m;}
    for(const c of chests){
      const cat=this.categoryOfChest(c);if(!cat||cat===DROP_BOX||cat==='OVERFLOW'||cat==='RETIRED')continue;
      const ded=this.dedicatedTo(c);   // a chest given to one item: anything else in it is misfiled; that item is home
      for(const [item,n] of Object.entries(c.items??{}))if(n>0&&!skip(item)&&(ded?item!==ded:categoryOf(item)!==cat)){const m=move('misfiled',item,c,n);if(m)return m;}
    }
    // An item spread over several chests: from the one holding least into the one holding most (if it has room).
    const spread={};for(const c of chests)if(this.categoryOfChest(c)!=='RETIRED')for(const [item,n] of Object.entries(c.items??{}))if(n>0)(spread[item]??=[]).push({c,n});
    for(const [item,list] of Object.entries(spread)){
      if(list.length<2||skip(item)||categoryOf(item)==='TOOLS_AND_EQUIPMENT')continue;
      list.sort((a,b)=>b.n-a.n);const main=list[0].c,small=list.at(-1);
      if(main.free>0||(main.items[item]%64)+small.n<=64)return {kind:'consolidate',item,count:Math.min(256,small.n),from:small.c,to:main};
    }
    return null;
  }
  /** Retired chests still holding goods (the floor chests waiting to be emptied): [{x,y,z,items}]. */
  retiredLeft(chests){return chests.filter(c=>this.categoryOfChest(c)==='RETIRED'&&Object.values(c.items??{}).some(n=>n>0));}
  /** The whole picture: per category, the chests, slots used and free; totals. */
  summary(chests){
    const out={};
    for(const c of chests){const cat=this.categoryOfChest(c)??'UNASSIGNED';const o=out[cat]??={chests:0,slots:0,used:0,items:0};
      o.chests++;o.slots+=c.size??54;o.used+=slotsUsed(c.items);o.items+=Object.values(c.items??{}).reduce((a,b)=>a+b,0);}
    return out;
  }
}
export {keyOf as chestKey};
