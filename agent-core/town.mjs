// Settlement rules as pure functions: needs, skills, milestones, the daily schedule, production,
// roads, quests, zones and friendships. main.mjs/civic.mjs apply them to the live world.

// --- Needs: hunger 0-20 (like a player's food bar) and energy 0-100. ---
export const NEEDS_START={hunger:20,energy:100};
/** Advances needs by dt seconds. Work burns both faster; resting at home restores energy. */
export function updateNeeds(needs,dt,{working=false,resting=false}={}){
  // About one meal per Minecraft day when idle, two when working hard.
  // Heavy labour (building, digging) burns about 15% faster than other work.
  const heavy=working==='heavy';
  const hunger=Math.max(0,needs.hunger-dt*(heavy?1/70:working?1/80:1/160));
  const energy=resting?Math.min(100,needs.energy+dt*0.6):Math.max(0,needs.energy-dt*(heavy?1/10.5:working?1/12:1/30));
  return {...needs,hunger:Math.round(hunger*100)/100,energy:Math.round(energy*100)/100};
}
export const needsFood=needs=>needs.hunger<12;
/** Work pace: 1 = every worker tick, 2 = every other tick. Hungry or exhausted agents slow down; skill speeds up. */
export function paceOf(needs,level=1){
  const tired=needs.hunger<6||needs.energy<20;
  const base=tired?2:1;
  return level>=4&&!tired?1:base;
}
export const wellbeing=needs=>needs.hunger>=14&&needs.energy>=60?'thriving':needs.hunger<6?'starving':needs.energy<20?'exhausted':needs.hunger<12?'hungry':needs.energy<40?'tired':'fine';

// --- Skills: experience per role, levels 1-5. ---
export const LEVELS=[0,40,150,400,1000];
export const XP={place:0.2,mine:0.4,harvest:0.5,tend:1,craft:1,smelt:1,trade:2,kill:5,reply:0.3,deposit:0.2,project:5,quest:4};
export const levelOf=xp=>LEVELS.filter(t=>xp>=t).length;
export const TITLES=['Apprentice','Journeyman','Skilled','Expert','Master'];
/** Bigger batches as skill grows: a master builder places 28 blocks per step instead of 12. */
export const batchFor=level=>12+4*(level-1);

// --- Calendar: phases of the Minecraft day (0 = 06:00). ---
export function dayPhase(worldTime){
  if(!Number.isFinite(worldTime))return 'day';
  const t=((worldTime%24000)+24000)%24000;
  return t<1500?'dawn':t<11000?'day':t<13000?'evening':t<23000?'night':'dawn';
}
export const isMarketDay=day=>day%3===0;

// --- Milestones unlock public buildings. ---
export const MILESTONES=[
  {id:'well',name:'Town well',need:'3 homes built',progress:t=>[t.homes,3]},
  {id:'town_hall',name:'Town hall',need:'5 homes built',progress:t=>[t.homes,5]},
  {id:'market_hall',name:'Market hall',need:'64 bread in the warehouse',progress:t=>[t.stock.BREAD??0,64]},
  {id:'watchtower',name:'Watchtower and walls',need:'25 monsters defeated',progress:t=>[t.kills,25]},
  {id:'forge',name:'Forge',need:'16 iron ingots in the warehouse',progress:t=>[t.stock.IRON_INGOT??0,16]},
  {id:'library',name:'Library',need:'60 ledger entries',progress:t=>[t.ledger,60]},
];
/** Milestones reached now that were not unlocked before. */
export function newlyUnlocked(town,unlocked){
  return MILESTONES.filter(m=>!unlocked.includes(m.id)&&(([have,need])=>have>=need)(m.progress(town)));
}

// --- Production: the crafter keeps the warehouse stocked. ---
// Each rule makes `item` from `inputs` (per action) when stock is below `target`.
export const PRODUCTION=[
  {item:'BREAD',target:48,how:'craft',inputs:{WHEAT:3},out:1},
  {item:'BAKED_POTATO',target:32,how:'smelt',inputs:{POTATO:1},out:1,fuel:true},
  {item:'SUGAR',target:16,how:'craft',inputs:{SUGAR_CANE:1},out:1},
  {item:'PUMPKIN_PIE',target:16,how:'craft',inputs:{PUMPKIN:1,SUGAR:1,EGG:1},out:1},
  {item:'OAK_PLANKS',target:192,how:'craft',inputs:{OAK_LOG:1},out:4},
  {item:'SPRUCE_PLANKS',target:192,how:'craft',inputs:{SPRUCE_LOG:1},out:4},
  {item:'STICK',target:32,how:'craft',inputs:{OAK_PLANKS:2},out:4},
  {item:'TORCH',target:64,how:'craft',inputs:{COAL:1,STICK:1},out:4},
  {item:'STONE',target:64,how:'smelt',inputs:{COBBLESTONE:1},out:1,fuel:true},
  {item:'STONE_BRICKS',target:192,how:'craft',inputs:{STONE:4},out:4},
  {item:'IRON_INGOT',target:32,how:'smelt',inputs:{RAW_IRON:1},out:1,fuel:true},
  {item:'GLASS',target:32,how:'smelt',inputs:{SAND:1},out:1,fuel:true},
  {item:'GLASS_PANE',target:64,how:'craft',inputs:{GLASS:6},out:16},
  {item:'IRON_NUGGET',target:18,how:'craft',inputs:{IRON_INGOT:1},out:9},
  {item:'LANTERN',target:24,how:'craft',inputs:{IRON_NUGGET:8,TORCH:1},out:1},
];
/** First rule that is below target and whose inputs (and fuel) are available; with how many times to run it. */
export function chooseProduction(stock,rules=PRODUCTION){
  for(const rule of rules){
    const have=stock[rule.item]??0;if(have>=rule.target)continue;
    let times=Math.min(16,Math.ceil((rule.target-have)/rule.out));
    for(const [input,per] of Object.entries(rule.inputs))times=Math.min(times,Math.floor((stock[input]??0)/per));
    if(rule.fuel)times=Math.min(times,((stock.COAL??0)+(stock.CHARCOAL??0))*8);
    if(times>=1)return {...rule,times};
  }
  return null;
}

// --- Roads: axis-aligned segments between waypoints, flush with the ground, lit every 8 blocks. ---
/** Columns of a road from a to b (L-shaped: along x first, then z), width 2 or 3. */
export function roadColumns(a,b,width=2){
  const cols=[],seen=new Set();
  const push=(x,z)=>{const k=`${x},${z}`;if(!seen.has(k)){seen.add(k);cols.push({x,z});}};
  const sx=Math.sign(b.x-a.x)||1,sz=Math.sign(b.z-a.z)||1;
  for(let x=a.x;;x+=sx){for(let w=0;w<width;w++)push(x,a.z+w);if(x===b.x)break;}
  for(let z=a.z;;z+=sz){for(let w=0;w<width;w++)push(b.x+w,z);if(z===b.z)break;}
  return cols;
}
/** Lantern spots beside a road: every 8th column along the centre line, one block to the side. */
export function lanternSpots(a,b,width=2){
  const spots=[];const sx=Math.sign(b.x-a.x),sz=Math.sign(b.z-a.z);let n=0;
  for(let x=a.x;sx&&x!==b.x;x+=sx)if(++n%8===0)spots.push({x,z:a.z-1});
  for(let z=a.z;sz&&z!==b.z;z+=sz)if(++n%8===0)spots.push({x:b.x+width,z});
  return spots;
}

// --- Quests: rewards in emeralds from the treasury, a little above the items' value. ---
export const questReward=value=>Math.max(1,Math.min(16,Math.round(value*1.25/10)));

// --- Town planning: zones by kind and what may be built in them. ---
export const ZONE_KINDS={houses:['house','floor','walls','box','roof','pillar','path'],public:null,park:['path','pillar','floor','well'],
  workshops:['house','box','walls','floor','forge','pavilion','windmill','pillar','path'],farms:['path','windmill'],industry:['path','pillar','box','walls']};
/** Zone that fully contains the footprint and allows the shape (public zones allow anything). */
export function zoneFor(footprint,shape,zones){
  return zones.find(z=>z.status==='adopted'&&footprint.x1>=z.x1&&footprint.x2<=z.x2&&footprint.z1>=z.z1&&footprint.z2<=z.z2
    &&(ZONE_KINDS[z.kind]===null||ZONE_KINDS[z.kind]?.includes(shape)));
}
export const overlaps=(a,b)=>a.x1<=b.x2&&a.x2>=b.x1&&a.z1<=b.z2&&a.z2>=b.z1;

// --- Friendships and rivalries: an affinity score per pair, -10..10. ---
export const pairKey=(a,b)=>[a,b].sort().join('|');
export function adjustAffinity(affinity,a,b,delta){
  if(a===b)return affinity;
  const key=pairKey(a,b);affinity[key]=Math.max(-10,Math.min(10,Math.round(((affinity[key]??0)+delta)*10)/10));
  return affinity;
}
/** Friends (>= 3) and rivals (<= -3) of an agent, best first. */
export function relationsOf(affinity,id){
  const out={friends:[],rivals:[]};
  for(const [key,score] of Object.entries(affinity)){
    const [a,b]=key.split('|');if(a!==id&&b!==id)continue;const other=a===id?b:a;
    if(score>=3)out.friends.push({id:other,score});else if(score<=-3)out.rivals.push({id:other,score});
  }
  out.friends.sort((x,y)=>y.score-x.score);out.rivals.sort((x,y)=>x.score-y.score);
  return out;
}

// --- Seasons: a 28-day year of four 7-day seasons. ---
export const SEASONS=['spring','summer','autumn','winter'];
export const seasonOf=day=>SEASONS[Math.floor(Math.max(0,day-1)/7)%4];

// --- Moods: free-text moods from reflection, plus needs and events, map to a few visible states. ---
const MOOD_WORDS={happy:/happy|proud|cheer|content|joy|excit|grateful|delight|glad|pleased|hopeful|warm/i,
  grumpy:/grump|annoy|irritat|frustrat|cross|sour|impatien|resent|bitter|angry/i,
  scared:/scared|afraid|nervous|anxious|worr|fear|uneasy|shaken/i};
export function moodCategory(mood,{needs,resting,raid,festival,combat}={}){
  if(resting)return 'sleepy';
  if(combat)return 'alert';
  if(raid)return 'scared';
  if(festival)return 'festive';
  if(needs&&needs.hunger<6)return 'hungry';
  for(const [cat,re] of Object.entries(MOOD_WORDS))if(re.test(mood??''))return cat;
  return 'calm';
}
// Emotes shown before the name tag; Minecraft's font renders these BMP symbols (colour codes with §).
export const EMOTES={happy:'§d❤',grumpy:'§c✖',scared:'§b❗',sleepy:'§7Zz',hungry:'§6☕',festive:'§e♪',alert:'§4⚔',calm:''};

// --- Reputation of players with the town. ---
export function reputationTitle(score){
  return score>=40?'Hero of the town':score>=15?'Friend of the town':score>=-5?'Neighbour':score>=-20?'Troublemaker':'Outcast';
}

// --- Road network routing: walk along built roads for longer trips. ---
/** Centre-line nodes every `step` blocks for each built road, with edges along roads and where roads meet. */
export function roadGraph(roads,step=3){
  const nodes=[],edges=new Map();
  const link=(a,b)=>{const d=Math.hypot(nodes[a].x-nodes[b].x,nodes[a].z-nodes[b].z);(edges.get(a)??edges.set(a,[]).get(a)).push([b,d]);(edges.get(b)??edges.set(b,[]).get(b)).push([a,d]);};
  for(const r of roads){
    const off=(r.width-1)/2,pts=[];
    const sx=Math.sign(r.b.x-r.a.x),sz=Math.sign(r.b.z-r.a.z);
    for(let x=r.a.x;;x+=sx||1){pts.push({x:x+0.5,z:r.a.z+off+0.5});if(x===r.b.x||!sx)break;}
    for(let z=r.a.z;;z+=sz||1){pts.push({x:r.b.x+off+0.5,z:z+0.5});if(z===r.b.z||!sz)break;}
    const sampled=pts.filter((_,i)=>i%step===0||i===pts.length-1);
    let prev=null;
    for(const p of sampled){nodes.push(p);const i=nodes.length-1;if(prev!==null)link(prev,i);prev=i;}
  }
  // Join roads that meet or cross.
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)
    if(Math.hypot(nodes[i].x-nodes[j].x,nodes[i].z-nodes[j].z)<=3.5&&!(edges.get(i)??[]).some(([k])=>k===j))link(i,j);
  return {nodes,edges};
}
/** Waypoints along the road network from `from` to `to`, or null when walking straight is better. */
export function roadRoute(graph,from,to,{minTrip=18,maxAccess=12}={}){
  if(!graph.nodes.length||Math.hypot(to.x-from.x,to.z-from.z)<minTrip)return null;
  const nearest=p=>{let best=-1,bd=Infinity;graph.nodes.forEach((n,i)=>{const d=Math.hypot(n.x-p.x,n.z-p.z);if(d<bd){bd=d;best=i;}});return [best,bd];};
  const [s,ds]=nearest(from),[t,dt]=nearest(to);
  if(ds>maxAccess||dt>maxAccess||s===t)return null;
  const dist=new Map([[s,0]]),prev=new Map(),todo=new Set([s]);
  while(todo.size){
    let u=null;for(const n of todo)if(u===null||dist.get(n)<dist.get(u))u=n;todo.delete(u);
    if(u===t)break;
    for(const [v,w] of graph.edges.get(u)??[]){const nd=dist.get(u)+w;if(nd<(dist.get(v)??Infinity)){dist.set(v,nd);prev.set(v,u);todo.add(v);}}
  }
  if(!dist.has(t))return null;
  const path=[];for(let n=t;n!==undefined;n=prev.get(n))path.unshift(graph.nodes[n]);
  // Worth it only if the road trip is not much longer than walking straight.
  const direct=Math.hypot(to.x-from.x,to.z-from.z);
  if(ds+dist.get(t)+dt>direct*1.8)return null;
  return path.filter((_,i)=>i%3===0||i===path.length-1);
}

// --- Logistics: what to drop off, which chest to use, and courier errands. ---
export const FOOD_ITEMS=new Set(['BREAD','COOKED_COD','COOKED_SALMON','BAKED_POTATO','APPLE','SWEET_BERRIES','MUSHROOM_STEW','PUMPKIN_PIE','CARROT','POTATO',
  'BEETROOT','COOKED_BEEF','COOKED_PORKCHOP','COOKED_CHICKEN','COOKED_MUTTON','WHEAT','WHEAT_SEEDS','COD','SALMON','EGG','SUGAR','SUGAR_CANE','PUMPKIN','MELON_SLICE','HAY_BLOCK']);
const ORES=/^(RAW_IRON|RAW_COPPER|RAW_GOLD|COAL|REDSTONE|LAPIS_LAZULI|DIAMOND|EMERALD_ORE|QUARTZ|AMETHYST_SHARD|IRON_INGOT|COPPER_INGOT|GOLD_INGOT)$/;
/** Items over the carry limits (wheat>32, seeds>64, ore>16, logs>32, cobblestone>64, cooked food>16), as [item, amount to drop]. */
export function dropOffItems(inventory,role){
  const limit=k=>k==='WHEAT'?32:k==='WHEAT_SEEDS'?64:ORES.test(k)?(role==='merchant'&&k==='EMERALD'?999:16):/_LOG$/.test(k)?32:k==='COBBLESTONE'||k==='COBBLED_DEEPSLATE'?64
    :FOOD_ITEMS.has(k)&&!/SEEDS/.test(k)?16:null;
  // Keep a little of each for personal use: 8 food, 16 seeds for the farmer, tools are never dropped.
  const keep=k=>k==='WHEAT_SEEDS'&&role==='farmer'?32:FOOD_ITEMS.has(k)?8:0;
  return Object.entries(inventory??{}).filter(([k,n])=>limit(k)!==null&&n>limit(k)).map(([k,n])=>[k,n-keep(k)]);
}
/** Chest for a deposit (by role label, then any with room) or a withdrawal (the one holding the most). */
export function chooseChest(chests,item,mode){
  const food=FOOD_ITEMS.has(item),role=c=>/food/i.test(c.name??'')?'food':/suppl|tool/i.test(c.name??'')?'supplies':'general';
  const wanted=food?'food':'supplies';
  if(mode==='withdraw')return chests.filter(c=>(c.items?.[item]??0)>0).sort((a,b)=>(b.items[item]??0)-(a.items[item]??0))[0]??null;
  const rank=(a,b)=>(role(b)===wanted)-(role(a)===wanted)||b.free-a.free;
  return chests.filter(c=>c.free>0).sort(rank)[0]??chests.filter(c=>(c.items?.[item]??0)>0).sort(rank)[0]??null;
}
// Hunger points per item (the 0-20 hunger bar, like a player's food bar), most filling first. The one list of
// what citizens eat: the fisher's cooked fish and the forager's berries count as much as the farmer's bread.
export const FOOD_POINTS={COOKED_BEEF:8,COOKED_PORKCHOP:8,PUMPKIN_PIE:8,COOKED_SALMON:6,COOKED_MUTTON:6,COOKED_CHICKEN:6,MUSHROOM_STEW:6,BEETROOT_SOUP:6,
  GOLDEN_CARROT:6,BREAD:5,BAKED_POTATO:5,COOKED_COD:5,APPLE:4,CARROT:3,SWEET_BERRIES:2,MELON_SLICE:2,COOKIE:2,BEETROOT:1,POTATO:1};
export const EDIBLE_FOODS=Object.keys(FOOD_POINTS);
/**
 * A food the town has not eaten before (a new dish from the chef, a datapack's or a mod's): from now on citizens eat it
 * like any other, at its real nutrition. EDIBLE_FOODS stays ordered most filling first (it is shared by reference).
 */
export function registerFood(item,points){
  if(!item||!(points>0)||FOOD_POINTS[item])return false;
  FOOD_POINTS[item]=points;
  const at=EDIBLE_FOODS.findIndex(f=>(FOOD_POINTS[f]??0)<points);
  if(at<0)EDIBLE_FOODS.push(item);else EDIBLE_FOODS.splice(at,0,item);
  return true;
}
const EDIBLE=EDIBLE_FOODS;
export const edibleIn=inventory=>EDIBLE.find(f=>(inventory?.[f]??0)>0)??null;
/**
 * Courier's next errand: feed a starving agent (hunger < 8, no food on them) from the courier's own
 * food or the pantry, otherwise collect from a producer carrying a surplus, otherwise nothing.
 */
export function courierErrand(courier,agents,pantry,{allGoods=false}={}){
  const hungry=agents.filter(a=>a.id!==courier.id&&(a.hunger??20)<8&&!edibleIn(a.inventory)).sort((a,b)=>a.hunger-b.hunger)[0];
  if(hungry){
    const food=edibleIn(courier.inventory);
    if(food)return {kind:'feed',to:hungry.id,item:food};
    const inPantry=EDIBLE.find(f=>(pantry?.[f]??0)>=4);
    if(inPantry)return {kind:'fetch-food',item:inPantry,for:hungry.id};
  }
  const producer=agents.filter(a=>a.id!==courier.id&&a.role!=='lumberjack').map(a=>({a,load:dropOffItems(a.inventory,a.role).filter(([k])=>allGoods||FOOD_ITEMS.has(k))}))
    .filter(x=>x.load.length).sort((x,y)=>y.load.reduce((s,[,n])=>s+n,0)-x.load.reduce((s,[,n])=>s+n,0))[0];
  if(producer)return {kind:'collect',from:producer.a.id,items:producer.load};
  return null;
}

// --- Bridges: where a road crosses water it becomes a raised plank deck with railings. ---
/**
 * Bridge blocks for a road over water. heights: Map "x,z" -> top block y; water: Set of "x,z" whose top is liquid.
 * A step (one row across the road) is bridged when it touches water or lies at/below the water surface (an old
 * low deck, a beach). The deck stands one block above the water and ramps up one block per step towards higher
 * banks so it is always walkable. Railings (plank + fence) run along both sides and across open ends, with a
 * lantern on every 4th post; `avoid` holds road columns that must stay open (junctions). Every block carries
 * `stand`: a spot on the nearest bank from which the builder places it, so nobody wades into the lake.
 */
export function bridgePlan(road,heights,water,avoid=new Set()){
  const {a,b,width=2}=road,K=(x,z)=>`${x},${z}`;
  const sx=Math.sign(b.x-a.x),sz=Math.sign(b.z-a.z),steps=[];
  for(let x=a.x;;x+=sx||1){steps.push({cols:[...Array(width)].map((_,w)=>({x,z:a.z+w})),sides:[{x,z:a.z-1},{x,z:a.z+width}],dir:{x:sx||1,z:0}});if(x===b.x||!sx)break;}
  if(sz)for(let z=a.z;;z+=sz){steps.push({cols:[...Array(width)].map((_,w)=>({x:b.x+w,z})),sides:[{x:b.x-1,z},{x:b.x+width,z}],dir:{x:0,z:sz}});if(z===b.z)break;}
  const surface=Math.max(-Infinity,...[...water].map(k=>heights.get(k)).filter(Number.isFinite));
  if(!Number.isFinite(surface))return {blocks:[],deck:new Set()};
  const top=c=>heights.get(K(c.x,c.z));
  for(const s of steps){
    const tops=s.cols.map(top);
    s.known=tops.every(Number.isFinite);
    // Also a deck already built one above the water, with water beside it (so missing railings get added).
    s.bridge=s.known&&(s.cols.some(c=>water.has(K(c.x,c.z)))||tops.every(t=>t<=surface)||(tops.every(t=>t<=surface+1)&&s.sides.some(c=>water.has(K(c.x,c.z)))));
    s.low=s.known&&tops.every(t=>t<=surface+1);
  }
  // A finished deck (railings missing): low steps joined to a step that still touches the water count too.
  for(let changed=true;changed;){changed=false;steps.forEach((s,i)=>{if(!s.bridge&&s.low&&(steps[i-1]?.bridge||steps[i+1]?.bridge)){s.bridge=true;changed=true;}});}
  for(const s of steps)s.stand=s.known?(s.bridge?surface+2:Math.max(...s.cols.map(top))+1):null;
  // The ground just past each end of the road counts as a neighbour too (the bank the road runs onto).
  const beyond=(s,d)=>{const cs=s.cols.map(c=>({x:c.x+s.dir.x*d,z:c.z+s.dir.z*d})).filter(c=>!water.has(K(c.x,c.z))&&Number.isFinite(top(c)));return cs.length?{stand:Math.max(...cs.map(top))+1,cols:cs,known:true}:null;};
  const ends=[beyond(steps[0],-1),beyond(steps[steps.length-1],1)];
  // Ramp: a deck is never more than one block below its neighbours.
  for(let pass=0;pass<steps.length;pass++)for(let i=0;i<steps.length;i++){
    const s=steps[i];if(!s.bridge)continue;
    for(const n of [steps[i-1]??ends[0],steps[i+1]??ends[1]])if(n?.stand!=null)s.stand=Math.max(s.stand,n.stand-1);
  }
  const roadCols=new Set(steps.flatMap(s=>s.cols.map(c=>K(c.x,c.z))));
  const open=c=>!roadCols.has(K(c.x,c.z))&&!avoid.has(K(c.x,c.z))&&Number.isFinite(top(c));
  const blocks=[],deck=new Set(),seen=new Set();
  const add=(x,y,z,block,stand)=>{const k=`${x},${y},${z}`;if(!seen.has(k)){seen.add(k);blocks.push({x,y,z,block,stand});}};
  let posts=0;
  steps.forEach((s,i)=>{
    if(!s.bridge)return;
    // Stand on the nearest bank step (by road distance).
    const centre=st=>({x:st.cols.reduce((t,c)=>t+c.x,0)/st.cols.length+0.5,y:st.stand,z:st.cols.reduce((t,c)=>t+c.z,0)/st.cols.length+0.5});
    const here=centre({...s,stand:0});
    const banks=[...steps.filter(st=>!st.bridge&&st.known),...ends.filter(Boolean)].map(centre);
    const stand=banks.sort((p,q)=>Math.hypot(p.x-here.x,p.z-here.z)-Math.hypot(q.x-here.x,q.z-here.z))[0]??null;
    const y=s.stand-1;
    for(const c of s.cols)if(top(c)<y){add(c.x,y,c.z,'OAK_PLANKS',stand);deck.add(K(c.x,c.z));}
    const rails=[...s.sides];
    // Open ends facing the water get a railing across too.
    if(i===0||i===steps.length-1){const d=i===0?-1:1;for(const c of s.cols){const e={x:c.x+s.dir.x*d,z:c.z+s.dir.z*d};if(water.has(K(e.x,e.z)))rails.push(e);}}
    const lamp=posts++%4===0;
    for(const r of rails)if(open(r)&&top(r)<=y){if(top(r)<y)add(r.x,y,r.z,'OAK_PLANKS',stand);add(r.x,y+1,r.z,'OAK_FENCE',stand);if(lamp)add(r.x,y+2,r.z,'LANTERN',stand);}
  });
  return {blocks,deck};
}

// Diary text as the model sometimes returns it: raw JSON ({"diary_entry":"..."}), maybe in a code fence
// or cut off mid-string, and often with a redundant "Day 154." prefix. Returns the plain sentence(s).
const DIARY_KEYS=['diary_entry','entry','text','diary'];
export function cleanDiaryText(raw){
  let s=String(raw??'').trim().replace(/^```[a-z]*\s*/i,'').replace(/\s*```$/,'').trim();
  if(s.startsWith('{')||s.startsWith('"')){
    let v=null;
    try{const j=JSON.parse(s);v=typeof j==='string'?j:DIARY_KEYS.map(k=>j?.[k]).find(x=>typeof x==='string')??null;}catch{}
    if(v==null){const m=s.match(/"(?:diary_entry|entry|text|diary)"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if(m)v=m[1].replace(/\\+$/,'').replace(/\\n/g,' ').replace(/\\(["\\/])/g,'$1');}
    if(v!=null)s=v;
  }
  return s.replace(/\s+/g,' ').trim().replace(/^day\s*\d+\s*[.:,\-–—]\s*/i,'').trim();
}
