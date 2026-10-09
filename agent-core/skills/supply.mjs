// Supply chain: storage caps, standing orders and haul sizes.
//
//   STORAGE CAPS     the warehouse (7 chests, 351 slots) filled up with 6,144 wheat seeds and 4,534 sweet berries
//                    (170 stacks) and 635 dirt; every later deposit - logs, coal, iron - silently failed, and each
//                    junk deposit was still bought (and money minted) at the market. Each item now has a cap: what
//                    is over it stays with whoever produced it (their packs have no limit).
//   CLEAR-OUT        what is already over the cap is moved out by the courier to Marlo's market stall, a load at a
//                    time (HAUL_LIMIT items per trip: heavy loads are split into several smaller runs).
//   STANDING ORDERS  the forge never runs dry: below 3 iron (ingots + raw, the smith's and the warehouse's) or 5 coal,
//                    an order goes to the miner (he delivers to the warehouse on his next trip up); below 16 logs in
//                    the warehouse, the lumberjack is asked to deliver early (at 16 logs instead of 64).

export const HAUL_LIMIT=256,UNSTACK_LOAD=28;
const BULK={WHEAT_SEEDS:256,BEETROOT_SEEDS:128,MELON_SEEDS:64,PUMPKIN_SEEDS:64,SWEET_BERRIES:256,DIRT:128,GRAVEL:128,SAND:256,
  COBBLESTONE:512,STONE:256,ANDESITE:128,DIORITE:128,GRANITE:128,TUFF:128,COBBLED_DEEPSLATE:256,RAW_COPPER:192,ROTTEN_FLESH:32,
  POTATO:384,CARROT:384,WHEAT:256,BEETROOT:128,SUGAR_CANE:128,APPLE:128,COOKIE:96,POPPY:64,DANDELION:64};
/** How many of an item the warehouse keeps (anything else: 640, ten stacks). */
// Things that do not stack (a slot each) are kept in small numbers: 598 bows (fishing treasure) and 564 wooden pickaxes
// (the miner's spares) filled half the warehouse. The rest goes to the merchant on the clerk's clear-out runs.
const ONE_EACH=/(_PICKAXE$|_AXE$|_SWORD$|_SHOVEL$|_HOE$|_HELMET$|_CHESTPLATE$|_LEGGINGS$|_BOOTS$|^BOW$|^CROSSBOW$|^SHIELD$|^FISHING_ROD$|^SHEARS$|^FLINT_AND_STEEL$|^SADDLE$|_BOAT$|^TRIDENT$|_BED$)/;
export const capOf=item=>BULK[item]??(/_PICKAXE$|^BOW$/.test(item)?8:ONE_EACH.test(item)?16:640);
/** Over the cap among the things that do not stack (cleared out even when the warehouse is not full). */
export const unstackableSurplus=items=>Object.entries(items??{}).filter(([k,n])=>ONE_EACH.test(k)&&n>capOf(k)).map(([item,n])=>({item,over:n-capOf(item)}));
/** How many of `count` may go in, given what is stored. */
export const roomFor=(item,count,stored=0)=>Math.max(0,Math.min(count,capOf(item)-stored));
/** Items over their cap, largest surplus first: [{item, over}]. */
export function surplusOf(items){
  // Unstackables first: a bow takes a whole chest slot, a seed 1/64 of one.
  return Object.entries(items??{}).map(([item,n])=>({item,over:n-capOf(item)})).filter(x=>x.over>0).sort((a,b)=>ONE_EACH.test(b.item)-ONE_EACH.test(a.item)||b.over-a.over);
}
/** One courier load from the surplus (at most HAUL_LIMIT items in all): [{item, count}]. */
export function loadOf(surplus,limit=HAUL_LIMIT){
  const out=[];let left=limit;
  // A pack has 36 slots: at most UNSTACK_LOAD unstackable things per trip (one slot each).
  let slots=UNSTACK_LOAD;
  for(const s of surplus){if(left<=0)break;const one=ONE_EACH.test(s.item);if(one&&slots<=0)continue;
    const n=Math.min(s.over,left,one?slots:Infinity);out.push({item:s.item,count:n});left-=n;if(one)slots-=n;}
  return out;
}
export const FORGE_MIN={iron:3,coal:5},WOOD_MIN=16;
const LOG=/_LOG$/;
/**
 * Standing orders from stock levels: [{key, item, count, for, role}]. smith = the smith's inventory, stock = the
 * warehouse. The forge counts what the smith carries and what the warehouse holds.
 */
export function standingOrders({smith={},stock={}}){
  const n=(o,k)=>o?.[k]??0,out=[];
  const iron=n(smith,'IRON_INGOT')+n(smith,'RAW_IRON')+n(stock,'IRON_INGOT')+n(stock,'RAW_IRON');
  const coal=n(smith,'COAL')+n(stock,'COAL')+n(smith,'CHARCOAL')+n(stock,'CHARCOAL');
  if(iron<FORGE_MIN.iron)out.push({key:'forge:iron',item:'RAW_IRON',count:16,for:'the forge',role:'miner'});
  if(coal<FORGE_MIN.coal)out.push({key:'forge:coal',item:'COAL',count:16,for:'the forge',role:'miner'});
  const logs=Object.entries(stock).filter(([k])=>LOG.test(k)).reduce((a,[,v])=>a+v,0);
  if(logs<WOOD_MIN)out.push({key:'stock:wood',item:'LOG',count:32,for:'the warehouse',role:'lumberjack'});
  return out;
}
