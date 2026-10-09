// The lumberjack's rules (Gideon "Timber" Vance, roles/lumberjack.mjs runs them): a state machine for the supply
// loop - tools, scouting, felling, replanting, hauling - plus the axe recipes, sapling matching, his forestry
// ledger and the lines he says. Pure functions only, so the whole loop can be tested and simulated without a server.
//
//   CHECK_TOOLS -> (no axe) CRAFT_AXE, or GATHER_CRAFTING_MATS first -> SCOUT_TREES -> HARVEST_TREE
//   -> REPLANT_SEED (mandatory, before leaving; CLEAR_FOLIAGE when no sapling dropped) -> ... -> HAUL_TO_WAREHOUSE

export const STATES=Object.freeze({IDLE:'IDLE',CHECK_TOOLS:'CHECK_TOOLS',GATHER_CRAFTING_MATS:'GATHER_CRAFTING_MATS',CRAFT_AXE:'CRAFT_AXE',
  SCOUT_TREES:'SCOUT_TREES',HARVEST_TREE:'HARVEST_TREE',CLEAR_FOLIAGE:'CLEAR_FOLIAGE',REPLANT_SEED:'REPLANT_SEED',HAUL_TO_WAREHOUSE:'HAUL_TO_WAREHOUSE'});

export const TUNING=Object.freeze({
  haulLogs:64,          // carry this many logs, then haul
  haulTrees:4,          // or haul after this many trees
  keepSaplings:8,       // saplings kept for replanting (spec: 5-10)
  foliageTries:2,       // leaf-clearing passes for a sapling before the stump is left "owed" for later
  unreachableMs:600000, // a tree that cannot be reached is skipped this long
  walkTries:6,          // walks toward a tree without getting in reach before it counts as unreachable
});

const WOODS=['OAK','SPRUCE','BIRCH','JUNGLE','ACACIA','DARK_OAK','MANGROVE','CHERRY','PALE_OAK'];
export const isLog=item=>/^(OAK|SPRUCE|BIRCH|JUNGLE|ACACIA|DARK_OAK|MANGROVE|CHERRY|PALE_OAK)_LOG$/.test(item);
export const isSapling=item=>/_SAPLING$|^MANGROVE_PROPAGULE$/.test(item);
export const woodOf=item=>WOODS.filter(w=>String(item).startsWith(`${w}_`)).sort((a,b)=>b.length-a.length)[0]??null;
/** The sapling a log's tree grows from. */
export const saplingFor=log=>{const w=woodOf(log);return w==='MANGROVE'?'MANGROVE_PROPAGULE':w?`${w}_SAPLING`:null;};
/** The sapling to plant where a `log` tree stood: the same kind if carried, else any carried sapling (a forest is a forest). */
// Dark and pale oak grow only from a 2x2 of four saplings: one alone would never become a tree.
const PAIRED=new Set(["DARK_OAK_SAPLING","PALE_OAK_SAPLING"]);
const plantable=(k,inventory)=>isSapling(k)&&(inventory[k]??0)>=(PAIRED.has(k)?4:1);
export function pickSapling(log,inventory={}){
  const same=saplingFor(log);
  if(same&&plantable(same,inventory))return same;
  return Object.keys(inventory).filter(k=>plantable(k,inventory)).sort((a,b)=>inventory[b]-inventory[a])[0]??null;
}

// ---------- axes ----------
export const AXES=['NETHERITE_AXE','DIAMOND_AXE','IRON_AXE','STONE_AXE','WOODEN_AXE'];
export const isAxe=item=>AXES.includes(item)||/_AXE$/.test(String(item))&&!/PICKAXE/.test(String(item));
const STONES=['COBBLESTONE','COBBLED_DEEPSLATE','BLACKSTONE'];
/** The best axe carried (held first). */
export function bestAxe(held,inventory={}){
  if(isAxe(held))return held;
  return AXES.find(a=>(inventory[a]??0)>0)??null;
}
/**
 * How to get an axe from what Gideon carries plus the warehouse stock: the best one possible - iron, then stone,
 * then wood. Returns {axe, withdraw:{item:n} (what to take from the warehouse), crafts:[{item,times}] (in order)}, or
 * {missing:{LOG:2}} when nothing can be made yet (then GATHER_CRAFTING_MATS: fell a tree by hand for logs).
 */
export function axePlan(inventory={},stock={}){
  const pool=k=>(inventory[k]??0)+(stock[k]??0);
  const keys=[...new Set([...Object.keys(inventory),...Object.keys(stock)])];
  const planks=keys.filter(k=>k.endsWith("_PLANKS")).sort((a,b)=>pool(b)-pool(a));
  const logs=keys.filter(isLog).sort((a,b)=>pool(b)-pool(a));
  const withdrawOf=use=>Object.fromEntries(Object.entries(use).map(([k,n])=>[k,n-(inventory[k]??0)]).filter(([,n])=>n>0));
  for(const [axe,heads] of [["IRON_AXE",["IRON_INGOT"]],["STONE_AXE",STONES],["WOODEN_AXE",planks]]){
    for(const head of heads){
      const use={},crafts=[],avail=k=>pool(k)-(use[k]??0),spend=(k,n)=>{use[k]=(use[k]??0)+n;};
      if(avail(head)<3)continue;
      spend(head,3);
      // Two sticks: carried or stored, else 2 planks make 4, else a log makes the planks first.
      if(avail("STICK")>=2)spend("STICK",2);
      else{
        const p=planks.find(x=>avail(x)>=2);
        if(p){spend(p,2);crafts.push({item:"STICK",times:1});}
        else{const l=logs.find(x=>avail(x)>=1);if(!l)continue;spend(l,1);crafts.push({item:woodOf(l)+"_PLANKS",times:1},{item:"STICK",times:1});}
      }
      crafts.push({item:axe,times:1});
      return {axe,withdraw:withdrawOf(use),crafts};
    }
  }
  // No planks at all: two logs make eight planks - three for the head, two for the sticks.
  const l=logs.find(x=>pool(x)>=2);
  if(l)return {axe:"WOODEN_AXE",withdraw:withdrawOf({[l]:2,...(pool("STICK")>=2?{STICK:2}:{})}),
    crafts:[{item:woodOf(l)+"_PLANKS",times:2},...(pool("STICK")>=2?[]:[{item:"STICK",times:1}]),{item:"WOODEN_AXE",times:1}]};
  return {missing:{LOG:2}};
}

// ---------- the state machine ----------
/**
 * The next state from what Gideon knows right now. ctx: {held, inventory, stock, stumps (unplanted, his own and
 * others'), tree (current target), felled (trees since the last haul), foliageTries, manual (axe broke mid-tree)}.
 * Priorities: finish replanting before anything else (his mandatory rule), haul when loaded, make sure of an axe,
 * then find and fell trees.
 */
export function nextState(ctx){
  const inv=ctx.inventory??{},logs=Object.entries(inv).filter(([k])=>isLog(k)).reduce((n,[,v])=>n+v,0);
  if(ctx.stumps?.length){
    if(pickSapling(ctx.stumps[0].log,inv))return STATES.REPLANT_SEED;
    if((ctx.foliageTries??0)<TUNING.foliageTries&&ctx.stumps[0].canopy!==false)return STATES.CLEAR_FOLIAGE;
    if((ctx.stock?.[saplingFor(ctx.stumps[0].log)]??0)+Object.entries(ctx.stock??{}).filter(([k,v])=>isSapling(k)&&v>0).length>0)return STATES.HAUL_TO_WAREHOUSE;   // fetch stored saplings
  }
  if(ctx.tree&&ctx.manual)return STATES.HARVEST_TREE;    // the axe broke mid-tree: finish it by hand
  if(logs>=(ctx.haulLogs??TUNING.haulLogs)||((ctx.felled??0)>=TUNING.haulTrees&&logs>0))return STATES.HAUL_TO_WAREHOUSE;   // haulLogs: 16 when the warehouse is short of wood
  if(!bestAxe(ctx.held,inv)){
    const plan=axePlan(inv,ctx.stock??{});
    return plan.missing?STATES.GATHER_CRAFTING_MATS:STATES.CRAFT_AXE;
  }
  if(ctx.tree)return STATES.HARVEST_TREE;
  return STATES.SCOUT_TREES;
}

// ---------- the forestry ledger ----------
export function newLedger(){return {trees_harvested:0,seeds_replanted:0,total_logs_delivered:0,saplings_delivered:0,owed:0,since:Date.now()};}
/** Planted minus felled: how much greener the world is for his work (he will tell you). */
export const netGreen=l=>(l.seeds_replanted??0)-(l.trees_harvested??0);
export const greenRatio=l=>(l.trees_harvested?(l.seeds_replanted??0)/l.trees_harvested:1);

// ---------- his voice ----------
export const LINES={
  apology:['Forgive me, old {tree}. You stood tall; your seed will stand taller.','Sorry, friend {tree} - I promise a sapling in your place before sundown.',
    'Easy now, {tree}. Your rings told a good story. Another chapter starts today.','Rest well, {tree}. Heave ho, and a sapling to follow!'],
  shanty:['🎵 Oh the axe swings low and the logs roll high, heave ho, my bonny pines! 🎵','🎵 Fell one, plant one, that is the lumberman\'s creed - yo ho! 🎵',
    '🎵 Haul away the timber, boys, haul away the oak! 🎵'],
  replant:['There you go, little {sapling}. Grow strong - the forest is counting on you.','One down, one planted. The ledger stays green!',
    'Tucked in a {sapling} where the old giant stood. That is how it is done.'],
  stumps:['A bare stump! Who leaves a stump unplanted? Not on my watch.','I count {n} empty stumps nearby and it makes my bark itch. Replanting now.'],
  boast:['Ledger check: {planted} planted, {felled} felled - that is net green {net}. The forest thanks me.','{planted} saplings in the ground against {felled} trees down. Net green: {net}!'],
  haul:['{logs} logs for the warehouse, fresh from the forest and fairly felled.','Timber delivered: {logs} logs. Every one of them replaced with a sapling, mind you.'],
  noSapling:['Not a single sapling in that canopy... I will clear the leaves and find one.','No seed dropped. The forest owes me one - I will be back for this stump.'],
  axe:['A fine {axe}. Sharp edge, steady hand, clear conscience.','New {axe} in hand. Let us be gentle with it.'],
  broke:['My {axe} gave out mid-swing! Finishing this one by hand, then back to the bench.'],
};
export function line(kind,vars={},random=Math.random){
  const list=LINES[kind]??[''];const t=list[Math.floor(random()*list.length)%list.length];
  return t.replace(/\{(\w+)\}/g,(_,k)=>String(vars[k]??''));
}
export const treeName=log=>({OAK:'oak',SPRUCE:'spruce',BIRCH:'birch',JUNGLE:'jungle giant',ACACIA:'acacia',DARK_OAK:'dark oak',MANGROVE:'mangrove',CHERRY:'cherry',PALE_OAK:'pale oak'})[woodOf(log)]??'tree';
