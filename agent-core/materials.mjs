// Building supplies without dead ends: when the warehouse lacks a block a blueprint asks for, the builder crafts it
// (planks from logs of the same wood, crafting tables from planks), swaps in a block of the same kind that is in stock
// (any planks for planks, any stone for stone), or leaves that block out (furnaces, anvils and other fittings) instead
// of waiting for supplies that nobody will bring. Pure rules; civic.mjs does the fetching and crafting.

const STONE=['STONE_BRICKS','COBBLESTONE','STONE','SMOOTH_STONE','MOSSY_STONE_BRICKS','MOSSY_COBBLESTONE','CRACKED_STONE_BRICKS',
  'BRICKS','ANDESITE','POLISHED_ANDESITE','DIORITE','POLISHED_DIORITE','GRANITE','POLISHED_GRANITE','DEEPSLATE_BRICKS',
  'COBBLED_DEEPSLATE','POLISHED_DEEPSLATE','DEEPSLATE_TILES','TUFF','TUFF_BRICKS','POLISHED_TUFF','MUD_BRICKS','SANDSTONE',
  'SMOOTH_SANDSTONE','CUT_SANDSTONE','RED_SANDSTONE','BLACKSTONE','POLISHED_BLACKSTONE_BRICKS','CALCITE'];
const SOIL=['DIRT','COARSE_DIRT','ROOTED_DIRT','GRASS_BLOCK','PODZOL','MUD','GRAVEL','SAND'];
/** The kind of block, for substitutes: same kind means it can stand in for it in a building. */
export function familyOf(item){
  if(/_PLANKS$/.test(item))return 'planks';
  if(/^(STRIPPED_)?\w+_(LOG|WOOD|STEM|HYPHAE)$/.test(item))return 'log';
  if(STONE.includes(item))return 'stone';
  if(SOIL.includes(item))return 'soil';
  if(/^(GLASS|\w+_STAINED_GLASS)$/.test(item))return 'glass';
  if(/GLASS_PANE$/.test(item))return 'pane';
  for(const suffix of ['STAIRS','SLAB','FENCE','FENCE_GATE','WALL','DOOR','TRAPDOOR','CARPET','WOOL','TERRACOTTA','CONCRETE'])
    if(item.endsWith(`_${suffix}`)||item===suffix)return suffix.toLowerCase();
  return null;
}
const woodOf=item=>item.replace(/^STRIPPED_/,'').replace(/_(PLANKS|LOG|WOOD|STEM|HYPHAE)$/,'');
/** Logs that can be crafted into these planks (4 planks per log). */
export function logsFor(planks){
  const wood=woodOf(planks),stem=['CRIMSON','WARPED'].includes(wood);
  return stem?[`${wood}_STEM`,`STRIPPED_${wood}_STEM`]:[`${wood}_LOG`,`STRIPPED_${wood}_LOG`,`${wood}_WOOD`];
}

/**
 * missing: [[item, count]] the builder lacks for the rest of the project. stock: warehouse items. have: the
 * builder's inventory. Returns the steps:
 *   fetch  {item, count}                 take it from the warehouse
 *   craft  {item, count, from, logs}     take `logs` of `from` and craft `item` (planks: 4 per log; table: 4 planks)
 *   swap   {from, to, count}             use `to` for `count` of the remaining `from` blocks (the last ones)
 *   drop   {item, count}                 leave that many `item` blocks out (the last ones)
 * Every item first gets what the warehouse holds of it, then what can be crafted, then stand-ins of the same kind
 * (split across several if needed); only what is left after that is dropped.
 */
export function supplyPlan(missing,{stock={},have={}}={}){
  const used={},steps=[],rest=Object.fromEntries(missing.filter(([,n])=>n>0));
  // The counts in `missing` already allow for what the builder carries of those items.
  const own=Object.fromEntries(Object.entries(have).filter(([k])=>!(k in rest)));
  const left=item=>(stock[item]??0)+(own[item]??0)-(used[item]??0);
  const kinds=()=>[...new Set([...Object.keys(stock),...Object.keys(own)])];
  // Carried items are used first; the rest is fetched from the warehouse.
  const fetch=(item,n)=>{const k=Math.min(n,Math.max(0,left(item)));if(k<=0)return 0;
    const before=used[item]??0;used[item]=before+k;
    const fromStock=Math.max(0,used[item]-(own[item]??0))-Math.max(0,before-(own[item]??0));
    if(fromStock>0)steps.push({kind:'fetch',item,count:fromStock});return k;};
  const craft=(item,n)=>{
    let made=0;
    if(item.endsWith('_PLANKS'))for(const log of logsFor(item)){
      const logs=Math.min(Math.ceil((n-made)/4),Math.max(0,left(log)));if(logs<=0)continue;
      used[log]=(used[log]??0)+logs;steps.push({kind:'craft',item,count:Math.min(n-made,logs*4),from:log,logs});made+=Math.min(n-made,logs*4);if(made>=n)break;
    }
    if(item==='CRAFTING_TABLE'){
      const planks=kinds().filter(k=>k.endsWith('_PLANKS')).sort((a,b)=>left(b)-left(a))[0];
      const k=planks?Math.min(n,Math.floor(left(planks)/4)):0;
      if(k>0){used[planks]=(used[planks]??0)+4*k;steps.push({kind:'craft',item,count:k,from:planks,logs:4*k});made+=k;}
    }
    return made;
  };
  const supply=item=>left(item)+(item.endsWith('_PLANKS')?4*logsFor(item).reduce((n,l)=>n+Math.max(0,left(l)),0):0);
  // 1. The real thing from the warehouse, for every item before any stand-ins are handed out.
  for(const item of Object.keys(rest))rest[item]-=fetch(item,rest[item]);
  // 2. Crafted (planks from logs of the same wood, crafting tables from planks).
  for(const item of Object.keys(rest))if(rest[item]>0)rest[item]-=craft(item,rest[item]);
  // 3. Stand-ins of the same kind, most plentiful first (planks can also be crafted from any logs).
  for(const item of Object.keys(rest)){
    const family=familyOf(item);if(!family||rest[item]<=0)continue;
    const pool=[...new Set([...kinds(),...(family==='planks'?kinds().filter(k=>familyOf(k)==='log'&&!k.startsWith('STRIPPED_')).map(l=>`${woodOf(l)}_PLANKS`):[])])]
      .filter(k=>k!==item&&familyOf(k)===family&&!(k in rest&&rest[k]>0));
    while(rest[item]>0){
      const alt=pool.filter(k=>supply(k)>0).sort((a,b)=>supply(b)-supply(a))[0];if(!alt)break;
      const want=Math.min(rest[item],supply(alt));
      steps.push({kind:'swap',from:item,to:alt,count:want});
      const got=fetch(alt,want);const made=got<want?craft(alt,want-got):0;
      rest[item]-=got+made;if(got+made<want)break;
    }
  }
  // 4. Whatever is still missing is left out.
  for(const [item,n] of Object.entries(rest))if(n>0)steps.push({kind:'drop',item,count:n});
  return steps;
}

// ---------- the crafter's supply chain ----------
const WOODS=['OAK','SPRUCE','BIRCH','JUNGLE','ACACIA','DARK_OAK','MANGROVE','CHERRY','PALE_OAK'];
/** How each building material is made: inputs per run and how many one run makes. `any_PLANKS` = planks of any wood. */
export function recipeFor(item){
  const wood=WOODS.filter(w=>item.startsWith(`${w}_`)).sort((x,y)=>y.length-x.length)[0];
  const planks=wood?`${wood}_PLANKS`:null;
  if(wood&&item===planks)return {how:'craft',inputs:{[`${wood}_LOG`]:1},out:4};
  if(wood&&item===`${wood}_STAIRS`)return {how:'craft',inputs:{[planks]:6},out:4};
  if(wood&&item===`${wood}_SLAB`)return {how:'craft',inputs:{[planks]:3},out:6};
  if(wood&&item===`${wood}_FENCE`)return {how:'craft',inputs:{[planks]:4,STICK:2},out:3};
  if(wood&&item===`${wood}_FENCE_GATE`)return {how:'craft',inputs:{[planks]:2,STICK:4},out:1};
  if(wood&&item===`${wood}_DOOR`)return {how:'craft',inputs:{[planks]:6},out:3};
  if(wood&&item===`${wood}_TRAPDOOR`)return {how:'craft',inputs:{[planks]:6},out:2};
  return {
    STICK:{how:'craft',inputs:{any_PLANKS:2},out:4},
    CRAFTING_TABLE:{how:'craft',inputs:{any_PLANKS:4},out:1},
    CHEST:{how:'craft',inputs:{any_PLANKS:8},out:1},
    BARREL:{how:'craft',inputs:{any_PLANKS:6,OAK_SLAB:2},out:1},
    LADDER:{how:'craft',inputs:{STICK:7},out:3},
    FURNACE:{how:'craft',inputs:{COBBLESTONE:8},out:1},
    STONE:{how:'smelt',inputs:{COBBLESTONE:1},out:1},
    SMOOTH_STONE:{how:'smelt',inputs:{STONE:1},out:1},
    STONE_BRICKS:{how:'craft',inputs:{STONE:4},out:4},
    STONE_BRICK_STAIRS:{how:'craft',inputs:{STONE_BRICKS:6},out:4},
    STONE_BRICK_SLAB:{how:'craft',inputs:{STONE_BRICKS:3},out:6},
    CHISELED_STONE_BRICKS:{how:'craft',inputs:{STONE_BRICK_SLAB:2},out:1},
    STONE_BRICK_WALL:{how:'craft',inputs:{STONE_BRICKS:6},out:6},
    COBBLESTONE_STAIRS:{how:'craft',inputs:{COBBLESTONE:6},out:4},
    COBBLESTONE_SLAB:{how:'craft',inputs:{COBBLESTONE:3},out:6},
    COBBLESTONE_WALL:{how:'craft',inputs:{COBBLESTONE:6},out:6},
    GLASS:{how:'smelt',inputs:{SAND:1},out:1},
    GLASS_PANE:{how:'craft',inputs:{GLASS:6},out:16},
    TORCH:{how:'craft',inputs:{COAL:1,STICK:1},out:4},
    CAMPFIRE:{how:'craft',inputs:{STICK:3,COAL:1,any_LOG:3},out:1},
    OAK_PRESSURE_PLATE:{how:'craft',inputs:{OAK_PLANKS:2},out:1},
    IRON_BLOCK:{how:'craft',inputs:{IRON_INGOT:9},out:1},
    ANVIL:{how:'craft',inputs:{IRON_BLOCK:3,IRON_INGOT:4},out:1},   // the forge's anvil (31 iron ingots)   // the tavern's hearth (vanilla: 3 sticks, coal or charcoal, 3 logs)
    IRON_NUGGET:{how:'craft',inputs:{IRON_INGOT:1},out:9},
    LANTERN:{how:'craft',inputs:{IRON_NUGGET:8,TORCH:1},out:1},
    // The courthouse cells: iron bars and iron doors from smelted iron, a lever from a stick and cobblestone.
    IRON_INGOT:{how:'smelt',inputs:{RAW_IRON:1},out:1},
    // The infirmary: beds from wool and planks, a cauldron from iron.
    WHITE_BED:{how:'craft',inputs:{WHITE_WOOL:3,any_PLANKS:3},out:1},
    RED_BED:{how:'craft',inputs:{RED_WOOL:3,any_PLANKS:3},out:1},
    CAULDRON:{how:'craft',inputs:{IRON_INGOT:7},out:1},
    IRON_BARS:{how:'craft',inputs:{IRON_INGOT:6},out:16},
    IRON_DOOR:{how:'craft',inputs:{IRON_INGOT:6},out:3},
    LEVER:{how:'craft',inputs:{STICK:1,COBBLESTONE:1},out:1},
    BRICKS:{how:'craft',inputs:{BRICK:4},out:1},
    BRICK:{how:'smelt',inputs:{CLAY_BALL:1},out:1},
  }[item]??SERVER_RECIPES.get(item)??null;   // anything else: the server's own recipe book (every craft and smelt)
}
// The server's full recipe book (SIDLocal 2.25.0 "allrecipes"), loaded at start: {result: {how, inputs, out}}. The
// hand-written recipes above come first (tuned for the town's builds); everything else craftable is planned from these.
const SERVER_RECIPES=new Map();
export function setServerRecipes(list){
  SERVER_RECIPES.clear();
  for(const r of list??[]){
    if(!r?.result||!r.inputs||!Object.keys(r.inputs).length)continue;
    const prev=SERVER_RECIPES.get(r.result);
    if(prev&&prev.how==='craft')continue;   // a craft is preferred over a smelt
    SERVER_RECIPES.set(r.result,{how:r.how==='smelt'?'smelt':'craft',inputs:{...r.inputs},out:Math.max(1,r.count??1)});
  }
  // Storage pairs (coal <-> coal block, iron ingot <-> iron block, wheat <-> hay bale): the loose item is the raw
  // material - unpacking a block is never planned (coal was "made" from coal blocks made from coal, round and round).
  for(const [item,r] of [...SERVER_RECIPES]){const ins=Object.keys(r.inputs);if(ins.length!==1)continue;const back=SERVER_RECIPES.get(ins[0]);if(back&&Object.keys(back.inputs).length===1&&back.inputs[item])SERVER_RECIPES.delete(item);}
  return SERVER_RECIPES.size;
}
export const serverRecipeCount=()=>SERVER_RECIPES.size;
/** Raw materials the crafter can go out and get itself: logs, by felling trees. */
export const gatherable=item=>/^(OAK|SPRUCE|BIRCH|JUNGLE|ACACIA|DARK_OAK|MANGROVE|CHERRY|PALE_OAK)_LOG$/.test(item);

/**
 * How the crafter gets `count` of `item` from what the town has (pool = warehouse + its own pockets). Returns
 * {steps, gather, short}: steps are crafts/smelts in order (each {how, item, times, inputs}); gather says which logs to
 * fell and how many; short lists raw materials it cannot get itself (cobblestone, sand, iron - for the miner).
 */
export function supplySteps(item,count,pool={}){
  const left={...pool},steps=[],gather={},short={};
  const plankKinds=()=>Object.keys(left).filter(k=>k.endsWith('_PLANKS')).sort((a,b)=>(left[b]??0)-(left[a]??0));
  const logKinds=()=>Object.keys(left).filter(k=>/_LOG$/.test(k)&&!/^STRIPPED_/.test(k)).sort((a,b)=>(left[b]??0)-(left[a]??0));
  const chain=[];   // what is being made right now: an ingredient already on the chain is raw (coal <- coal block <- coal...)
  const want=(it,n,depth=0)=>{
    if(it==='any_PLANKS')it=plankKinds().find(k=>(left[k]??0)>=n)??plankKinds()[0]??'OAK_PLANKS';
    if(it==='any_LOG')it=logKinds().find(k=>(left[k]??0)>=n)??logKinds()[0]??'OAK_LOG';
    const have=Math.min(n,Math.max(0,left[it]??0));left[it]=(left[it]??0)-have;n-=have;
    if(n<=0)return;
    const r=depth<5&&!chain.includes(it)?recipeFor(it):null;
    if(!r){if(gatherable(it))gather[it]=(gather[it]??0)+n;else short[it]=(short[it]??0)+n;return;}
    if(Object.keys(r.inputs).some(k=>chain.includes(k)||k===it)){short[it]=(short[it]??0)+n;return;}
    chain.push(it);
    const times=Math.ceil(n/r.out),inputs={};
    for(const [k,per] of Object.entries(r.inputs)){
      const name=k==='any_PLANKS'?(plankKinds().find(p=>(left[p]??0)>=per*times)??'OAK_PLANKS'):k==='any_LOG'?(logKinds().find(p=>(left[p]??0)>=per*times)??'OAK_LOG'):k;
      inputs[name]=per*times;want(name,per*times,depth+1);
    }
    chain.pop();
    steps.push({how:r.how,item:it,times,inputs});
    left[it]=(left[it]??0)+times*r.out-n;
  };
  want(item,count);
  return {steps,gather,short};
}
/** What a build queue still needs that neither the builder nor the warehouse has: [[item, count]], biggest first. */
export function shortages(queue,stock={},carried={}){
  const need={};for(const b of queue){if(b.clear)continue;need[b.block]=(need[b.block]??0)+1;}
  return Object.entries(need).map(([k,n])=>[k,n-(stock[k]??0)-(carried[k]??0)]).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]);
}
