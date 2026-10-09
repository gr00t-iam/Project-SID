// Pure rules for the town's market, master plans, council, climate, alerts and the specialists
// (courier, smith, herbalist). No I/O: civic.mjs and roles/specialists.mjs apply them. Unit-tested.

// ---------- supply and demand ----------
// Trade value units match the plugin (1 emerald = 10). target = the stock the town wants to hold.
export const PRICE_BOOK={
  BREAD:{value:3,target:100,food:true},WHEAT:{value:1,target:128,food:true},COOKED_COD:{value:2,target:48,food:true},COOKED_SALMON:{value:3,target:48,food:true},
  BAKED_POTATO:{value:2,target:48,food:true},CARROT:{value:0.8,target:48,food:true},POTATO:{value:0.8,target:48,food:true},APPLE:{value:2,target:32,food:true},
  SWEET_BERRIES:{value:0.5,target:32,food:true},MUSHROOM_STEW:{value:4,target:16,food:true},
  IRON_INGOT:{value:6,target:32},RAW_IRON:{value:5,target:32},COAL:{value:1,target:64},COBBLESTONE:{value:0.1,target:256},OAK_PLANKS:{value:0.25,target:192},
  OAK_LOG:{value:1,target:64},STONE_BRICKS:{value:0.2,target:256},TORCH:{value:0.3,target:64},STICK:{value:0.1,target:64},
};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
/** Price factor from stock: 1 at the target, up to 3x when scarce, down to 0.5x when plentiful. */
export const priceFactor=(stock,target)=>Math.round(clamp(Math.pow(target/Math.max(1,stock),0.7),0.5,3)*100)/100;
/** Current prices: {item:{value,factor,base}}; an emergency raises food prices by half again (max 4x). */
export function marketPrices(stock,{emergency=false}={}){
  const out={};
  for(const [item,p] of Object.entries(PRICE_BOOK)){
    let factor=priceFactor(stock?.[item]??0,p.target);
    if(emergency&&p.food)factor=Math.min(4,Math.round(factor*1.5*100)/100);
    out[item]={base:p.value,factor,value:Math.round(p.value*factor*100)/100};
  }
  return out;
}
/** Emeralds the merchant pays a producer for goods brought to the warehouse (a quarter of their value). */
export function payoutFor(items,prices,share=0.25){
  let units=0;for(const [item,n] of Object.entries(items??{}))units+=(prices[item]?.value??0)*n;
  return Math.round(units*share/10*100)/100;
}
/** Prices for the plugin's trade window (value units per item). */
export const tradeValues=prices=>Object.fromEntries(Object.entries(prices).map(([k,p])=>[k,p.value]));
/** Food items whose price is well above normal: producers should make more of them. */
export const scarceFood=prices=>Object.entries(prices).filter(([k,p])=>PRICE_BOOK[k]?.food&&p.factor>=1.4).sort((a,b)=>b[1].factor-a[1].factor).map(([k])=>k);

// ---------- climate ----------
/** Crop growth in percent of normal for a season, with or without a drought. */
export function growthRate(season,drought){
  const base={spring:100,summer:100,autumn:70,winter:35}[season]??100;
  return drought?Math.min(base,30):base;
}
/** At dawn: does a drought start today (summer 20%, spring 5%), and for how many days. */
export function rollDrought(season,r1=Math.random(),r2=Math.random()){
  const chance={summer:0.2,spring:0.05}[season]??0;
  return r1<chance?2+Math.floor(r2*2):0;
}

// ---------- alerts ----------
/**
 * Raid readiness: red = a raid now (4+ monsters near town); yellow = monsters seen near town recently,
 * a thunderstorm, or several kills today; green = calm.
 */
export function readiness({hostilesNow=0,recentThreat=false,storm=false,killsToday=0}){
  if(hostilesNow>=4)return 'red';
  if(hostilesNow>0||recentThreat||storm||killsToday>=3)return 'yellow';
  return 'green';
}
/** Roles that keep working through an alert (the guard fights; everyone else takes shelter). */
export const ALERT_EXEMPT=new Set(['guardian']);
export function nearestShelter(pos,shelters){
  return shelters.slice().sort((a,b)=>Math.hypot(a.x-pos.x,a.z-pos.z)-Math.hypot(b.x-pos.x,b.z-pos.z))[0]??null;
}

// ---------- master plans ----------
export const MASTER_PLANS=[
  // (The perimeter wall plan was retired 2026-10-06: the mayor never asked for town walls; the north wall sat at 0 of
  // 26 blocks for a day, holding the builder back from the workshops.)
  {id:'stone_roads',name:'Stone road network between the homes',kind:'roads',stages:[
    {id:'walk_west',name:'west sidewalk of the village street',road:{a:{x:299,z:78},b:{x:299,z:116},width:1,block:'STONE_BRICKS'}},
    {id:'walk_east',name:'east sidewalk of the village street',road:{a:{x:303,z:78},b:{x:303,z:116},width:1,block:'STONE_BRICKS'}},
    {id:'walk_square',name:'stone walk from the square to the market',road:{a:{x:289,z:96},b:{x:289,z:103},width:1,block:'STONE_BRICKS'}}]},
  {id:'market',name:'Town square market hall',kind:'market',stages:[{id:'market_hall',name:'market hall',site:'market_hall'}]},
];
export const stageOf=id=>{for(const p of MASTER_PLANS){const s=p.stages.find(x=>x.id===id);if(s)return {plan:p,stage:s};}return null;};
/** Next unbuilt stage of each plan (plans run stage by stage). */
export function openStages(done){
  return MASTER_PLANS.map(p=>{const s=p.stages.find(x=>!done.includes(x.id));return s?{plan:p.id,planName:p.name,kind:p.kind,stage:s.id,name:s.name}:null;}).filter(Boolean);
}
/** Plan progress for the dashboard. */
export const planProgress=done=>MASTER_PLANS.map(p=>({id:p.id,name:p.name,done:p.stages.filter(s=>done.includes(s.id)).length,total:p.stages.length,stages:p.stages.map(s=>({name:s.name,done:done.includes(s.id)}))}));
/**
 * Columns of a wall ring segment around `center` at `radius`, for angles in [from,to] degrees
 * (0 = east/+x, 90 = south/+z). Gates (4 blocks wide) at the four compass points stay open;
 * every `lampEvery`-th column carries a lantern.
 */
export function wallColumns(center,radius,[from,to],{lampEvery=8,gateHalf=2}={}){
  const cols=[],seen=new Set();
  for(let a=from;a<=to;a+=0.25){
    const rad=a*Math.PI/180,x=Math.floor(center.x+Math.cos(rad)*radius),z=Math.floor(center.z+Math.sin(rad)*radius),k=`${x},${z}`;
    if(seen.has(k))continue;seen.add(k);
    const gate=[0,90,180,270,360,-90].some(g=>Math.abs(((a-g)%360+540)%360-180)*Math.PI/180*radius<=gateHalf);
    if(!gate)cols.push({x,z});
  }
  return cols.map((c,i)=>({...c,lamp:i%lampEvery===lampEvery/2}));
}

// ---------- council ----------
// How much each role cares about each kind of project (1 = neutral).
const LIKES={guardian:{wall:3},builder:{market:2,wall:1.5,building:2},merchant:{market:3,roads:1.5},courier:{roads:3},scout:{roads:2},
  farmer:{market:1.5},fisher:{market:1.5},herbalist:{roads:1.5},miner:{wall:1.5},smith:{wall:2},crafter:{market:1.5,building:1.5},governor:{},scribe:{building:1.5}};
/**
 * Every citizen votes for one candidate (next plan stages and unlocked buildings), by role, the town's
 * situation (threats favour the wall, a low pantry favours the market) and a little personal whim.
 */
export function councilVote(voters,candidates,metrics,rand=Math.random){
  if(!candidates.length)return {votes:{},tally:{},winner:null};
  const votes={},tally=Object.fromEntries(candidates.map(c=>[c.stage,0]));
  for(const v of voters){
    let best=null,bestScore=-Infinity;
    for(const c of candidates){
      let score=LIKES[v.role]?.[c.kind]??1;
      if(c.kind==='wall'&&(metrics.threats??0)>=3)score+=2;
      if(c.kind==='market'&&(metrics.pantryStatus==='low'||metrics.pantryStatus==='critical'))score+=1;
      if(c.kind==='roads'&&(metrics.homes??0)>=6)score+=0.5;
      score+=rand()*1.2;
      if(score>bestScore){bestScore=score;best=c;}
    }
    votes[v.id]=best.stage;tally[best.stage]++;
  }
  const winner=candidates.slice().sort((a,b)=>tally[b.stage]-tally[a.stage])[0];
  return {votes,tally,winner};
}
export const councilDue=(day,lastDay,every=7)=>day>=(lastDay??0)+every;
/** Emergency funds when food is short: emeralds for the food producers and higher food prices for two days. */
export function emergencyPlan(metrics){
  if(metrics.pantryStatus!=='critical'&&metrics.pantryStatus!=='low')return null;
  const grant=metrics.pantryStatus==='critical'?4:2;
  return {grant,to:['farmer','fisher'],days:2};
}

// ---------- courier ----------
const KEEP_TOOLS=/(_SWORD|_PICKAXE|_AXE|_SHOVEL|_HOE|_HELMET|_CHESTPLATE|_LEGGINGS|_BOOTS|^SHIELD$|^FISHING_ROD$)/;
/** What an agent can spare for a quest (keeps its tools, 8 food, the farmer's seeds, the merchant's emeralds). */
export function spareOf(agent,item){
  const have=agent.inventory?.[item]??0;if(!have||KEEP_TOOLS.test(item))return 0;
  const keep=item==='WHEAT_SEEDS'&&agent.role==='farmer'?32:item==='EMERALD'&&agent.role==='merchant'?999:['BREAD','APPLE','COOKED_COD','COOKED_SALMON'].includes(item)?8:0;
  return Math.max(0,have-keep);
}
/** An open quest another citizen can fill from their pockets: the courier fetches it and delivers. */
export function questErrand(quests,agents,courierId){
  for(const q of quests.filter(q=>q.status==='open')){
    const need=q.count-(q.delivered??0);if(need<=0)continue;
    const from=agents.filter(a=>a.id!==q.by&&a.id!==courierId).map(a=>({a,n:spareOf(a,q.item)})).filter(x=>x.n>=Math.min(need,8)).sort((x,y)=>y.n-x.n)[0];
    if(from)return {kind:'quest-collect',quest:q.id,from:from.a.id,item:q.item,count:Math.min(need,from.n,64),to:q.by};
  }
  return null;
}
/** Patrol order of the production sites (farm, dock, mine); the courier visits the next one after `last`. */
export function nextPatrolStop(stops,last){
  if(!stops.length)return null;
  const i=stops.findIndex(s=>s.id===last);
  return stops[(i+1)%stops.length];
}

// ---------- smith ----------
const TIERS=['WOODEN','STONE','GOLDEN','IRON','DIAMOND','NETHERITE'];
export const TOOL_MAX={WOODEN:59,STONE:131,GOLDEN:32,IRON:250,DIAMOND:1561,NETHERITE:2031};
// Tools each role needs to work.
export const TOOL_NEEDS={miner:['PICKAXE','SHOVEL','AXE'],guardian:['SWORD'],farmer:['HOE'],smith:['PICKAXE']};
export function bestTool(inventory,kind){
  return Object.keys(inventory??{}).filter(k=>k.endsWith('_'+kind)&&TIERS.includes(k.split('_')[0])).sort((a,b)=>TIERS.indexOf(b.split('_')[0])-TIERS.indexOf(a.split('_')[0]))[0]??null;
}
/**
 * Citizens missing a work tool, or whose only one is nearly worn out (under 15% left, and no spare),
 * most urgent first: missing before worn, the miner and guardian before others.
 */
export function toolNeeds(agents){
  const out=[];
  for(const a of agents){
    for(const kind of TOOL_NEEDS[a.role]??[]){
      const tool=bestTool(a.inventory,kind);
      if(!tool){out.push({agent:a.id,kind,reason:'missing'});continue;}
      const left=a.wear?.[tool],max=TOOL_MAX[tool.split('_')[0]]??0;
      if(Number.isFinite(left)&&max&&left<max*0.15&&(a.inventory[tool]??0)<2)out.push({agent:a.id,kind,reason:'worn',tool,left});
    }
  }
  const rank=n=>(n.reason==='missing'?0:10)+(['miner','guardian'].includes(agents.find(a=>a.id===n.agent)?.role)?0:1);
  return out.sort((x,y)=>rank(x)-rank(y));
}
const INGOTS={PICKAXE:3,AXE:3,SWORD:2,HOE:2,SHOVEL:1},STICKS={PICKAXE:2,AXE:2,SWORD:1,HOE:2,SHOVEL:2};
/**
 * The smith's next step for a tool kind: hand over a spare, make an iron one, smelt iron first,
 * make sticks, or fall back to a stone tool; null when it has nothing to work with.
 */
export function smithStep(inv,kind){
  const n=k=>inv?.[k]??0;
  const spare=['NETHERITE','DIAMOND','IRON','STONE'].map(t=>`${t}_${kind}`).find(t=>n(t)>0);
  if(spare)return {step:'give',item:spare};
  if(n('STICK')<STICKS[kind]){
    const planks=Object.keys(inv??{}).find(k=>k.endsWith('_PLANKS')&&n(k)>=2);
    if(planks)return {step:'craft',item:'STICK',count:1};
    const log=Object.keys(inv??{}).find(k=>k.endsWith('_LOG')&&n(k)>=1);
    if(log)return {step:'craft',item:log.replace('_LOG','_PLANKS'),count:1};
    return {step:'need',item:'STICK',count:4};
  }
  if(n('IRON_INGOT')>=INGOTS[kind])return {step:'craft',item:`IRON_${kind}`,count:1};
  if(n('RAW_IRON')+n('IRON_INGOT')>=INGOTS[kind])return {step:'smelt',item:'RAW_IRON',count:INGOTS[kind]-n('IRON_INGOT')};
  if(n('COBBLESTONE')>=INGOTS[kind])return {step:'craft',item:`STONE_${kind}`,count:1};
  return {step:'need',item:'IRON_INGOT',count:INGOTS[kind]};
}

// ---------- herbalist ----------
export const HERBS=['POPPY','DANDELION','OXEYE_DAISY','AZURE_BLUET','CORNFLOWER','ALLIUM','LILY_OF_THE_VALLEY','RED_TULIP','ORANGE_TULIP','WHITE_TULIP','PINK_TULIP',
  'BLUE_ORCHID','RED_MUSHROOM','BROWN_MUSHROOM','NETHER_WART','FERN'];
const FRUIT=['SWEET_BERRIES','GLOW_BERRIES','APPLE','MELON_SLICE'];
// Ingredients per potion (mirrors the plugin's brew action).
export const BREWS={
  HEALING:{herbs:1,other:FRUIT,n:2},SWIFTNESS:{herbs:1,other:['SUGAR','SUGAR_CANE'],n:1},
  NIGHT_VISION:{herbs:1,other:['GOLDEN_CARROT','CARROT'],n:1},SPLASH_HEALING:{herbs:2,other:FRUIT,n:3},
};
export const POTION_TARGETS={HEALING:4,SWIFTNESS:2,SPLASH_HEALING:2,NIGHT_VISION:1};
const total=(inv,list)=>list.reduce((s,k)=>s+(inv?.[k]??0),0);
export const herbCount=inv=>total(inv,HERBS);
/** The potion to brew next (the one furthest below its target that the ingredients allow), or null. */
export function brewNext(inv,potions){
  const order=Object.entries(POTION_TARGETS).map(([k,t])=>[k,(potions?.[k]??0)/t]).filter(([,r])=>r<1).sort((a,b)=>a[1]-b[1]);
  for(const [kind] of order){const b=BREWS[kind];if(herbCount(inv)>=b.herbs&&total(inv,b.other)>=b.n)return kind;}
  return null;
}
/** Citizens who need care: hurt (health <= 12 of 20), worst first. */
export const patientsOf=agents=>agents.filter(a=>Number.isFinite(a.health)&&a.health>0&&a.health<=12).sort((a,b)=>a.health-b.health);
/** Herbs and fruit the herbalist would like to gather (keeps a working supply). */
export const needsHerbs=inv=>herbCount(inv)<6||total(inv,FRUIT)<6||total(inv,['SUGAR','SUGAR_CANE'])<2;
