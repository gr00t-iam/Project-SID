// Settlement life on top of the agent runtime: economy and warehouse logistics, needs, skills,
// public works, roads, zones, quests, friendships, the daily schedule and festivals.
// main.mjs creates one instance and calls into it from the worker loop, the model loop and events.
import {createCommunityBoard} from './community.mjs';
import {lampPlan,lampSiteSafe} from './lighting.mjs';
import {requestDelivery,nextDelivery,recordDelivery} from './deliveries.mjs';
import {createCityBoard,restorationPlan,renovationPlan} from './city.mjs';
import {blueprint,SHAPE_LEVEL,courthouseLayout,infirmaryLayout,bakeryLayout} from './blueprints.mjs';
import {roomFor,capOf,surplusOf,loadOf,standingOrders} from './skills/supply.mjs';
import {RESTORATIVE} from './cuisine.mjs';
import {tilesOf,findPits,fillsFor} from './skills/terrain.mjs';
import {WarehouseMap,chestKey,slotsUsed,stackSize} from './skills/warehouse.mjs';
import {newProject} from './worker.mjs';
import {pantryPoints} from './roles/fisher.mjs';
import {footprintOf as blocksFootprint,spiral,scoreSite,planTerrain3D,validateEdits,scanPages,farmPlots} from './sites.mjs';
import {designOptions,voteDesign} from './designs.mjs';
import {supplyPlan,supplySteps,shortages,recipeFor,setServerRecipes} from './materials.mjs';
import {createReservations,MINED,requestPhase} from './reservations.mjs';
import {phaseOf} from './construction.mjs';
import {choose as chooseProposal,voteOf as voteProposal,remember as rememberProposal} from './skills/proposals.mjs';
import {dietStats} from './cuisine.mjs';
import {AWARD_ACTIVITY} from './skills/economy.mjs';
import {needsOf,mealDecision} from './skills/needs.mjs';
import {NEEDS_START,updateNeeds,needsFood,paceOf,wellbeing,XP,levelOf,TITLES,batchFor,dayPhase,isMarketDay,MILESTONES,newlyUnlocked,
  chooseProduction,roadColumns,lanternSpots,questReward,zoneFor,overlaps,adjustAffinity,relationsOf,seasonOf,PRODUCTION,
  dropOffItems,chooseChest,courierErrand,edibleIn,FOOD_ITEMS,FOOD_POINTS,EDIBLE_FOODS,bridgePlan,cleanDiaryText} from './town.mjs';
import {marketPrices,payoutFor,tradeValues,scarceFood,PRICE_BOOK,growthRate,rollDrought,readiness,nearestShelter,ALERT_EXEMPT,MASTER_PLANS,stageOf,openStages,
  planProgress,wallColumns,councilVote,councilDue,emergencyPlan,nextPatrolStop} from './plans.mjs';
const COUNCIL_EVERY=Number(process.env.COUNCIL_EVERY_DAYS||7);

// Surveyed sites (north-west corners). All lie inside the adopted founding zones below.
export const SITES={
  // Workshops (2026-10-06): three bare 7x7 house frames by the shrine, finished for the citizens who worked outdoors.
  herb_shed:{shape:'house',x:257,z:143,door:'north',spec:{width:7,depth:7,height:4,material:'OAK_PLANKS',trim:'OAK_LOG',floor:'OAK_PLANKS',roof:'SPRUCE_PLANKS',windows:true}},
  carpenter:{shape:'house',x:249,z:143,door:'north',spec:{width:7,depth:7,height:4,material:'SPRUCE_PLANKS',trim:'OAK_LOG',floor:'OAK_PLANKS',roof:'SPRUCE_PLANKS',windows:true}},
  fishmonger:{shape:'house',x:233,z:139,door:'north',spec:{width:7,depth:7,height:4,material:'COBBLESTONE',trim:'OAK_LOG',floor:'OAK_PLANKS',roof:'SPRUCE_PLANKS',windows:true}},
  warehouse:{shape:'warehouse',x:282,z:104,door:'west',free:true},
  well:{shape:'well',x:281,z:92},
  town_hall:{shape:'hall',x:263,z:62,door:'south'},
  market_hall:{shape:'pavilion',x:267,z:102},
  watchtower:{shape:'tower',x:278,z:59,door:'south'},
  forge:{shape:'forge',x:235,z:87,door:'east'},
  library:{shape:'library',x:246,z:70,door:'east'},
  // The mayor's (player's) house, by the library.
  // The Hearthlight shrine (requested by Sister Maren when she arrives; the town votes on its design).
  shrine:{shape:'pavilion',x:266,z:88,spec:{width:5,depth:5}},
  // The jail (requested once the sheriff arrives): cells along the north wall, see skills/justice.mjs.
  jail:{shape:'jail',x:254,z:100,door:'south'},
  // The bank (requested once the Banker arrives): vault chests behind grates, see skills/banking.mjs.
  bank:{shape:'bank',x:290,z:80,door:'south'},
  // The courthouse (requested once the Judge arrives): bench, stands, gallery and two holding cells, see roles/judge.mjs.
  courthouse:{shape:'courthouse',x:247,z:90,door:'north'},
  // The infirmary (requested once the town has a medic - Rosa): four beds and the medicine corner, see skills/healthcare.mjs.
  infirmary:{shape:'infirmary',x:231,z:97,door:'south'},
  // Chef Antoine's bakery (requested once the town has a chef): he cooks there, not in the warehouse (roles/chef.mjs).
  // The planned spot is south of the warehouse; the builder surveys nearby open ground if it is taken.
  bakery:{shape:'bakery',x:283,z:124,door:'east'},
  // The tavern: the evening gathering place (skills/needs.mjs DUSK_SOCIAL).
  tavern:{shape:'tavern',x:283,z:114,door:'south'},
  mayor_house:{shape:'house',x:237,z:77,door:'east',spec:{width:7,depth:7,height:4,material:'STONE_BRICKS',trim:'STRIPPED_OAK_LOG',roof:'BRICKS',floor:'SPRUCE_PLANKS',bed:'RED_BED'}},
};
// Road network: axis-aligned segments between the town's places (width, surface).
export const ROADS=[
  {name:'square to village street',a:{x:291,z:93},b:{x:299,z:93},width:2,block:'GRAVEL'},
  {name:'village street',a:{x:300,z:78},b:{x:300,z:116},width:3,block:'GRAVEL'},
  {name:'market street',a:{x:278,z:101},b:{x:278,z:111},width:3,block:'GRAVEL'},
  {name:'north road',a:{x:283,z:86},b:{x:283,z:70},width:2,block:'GRAVEL'},
  {name:'town hall lane',a:{x:268,z:72},b:{x:282,z:72},width:2,block:'DIRT_PATH'},
  {name:'watchtower lane',a:{x:280,z:71},b:{x:280,z:65},width:2,block:'DIRT_PATH'},
  {name:'west road',a:{x:250,z:86},b:{x:275,z:86},width:2,block:'GRAVEL'},
  {name:'library lane',a:{x:256,z:74},b:{x:256,z:85},width:2,block:'DIRT_PATH'},
  {name:'forge lane',a:{x:242,z:86},b:{x:242,z:90},width:2,block:'DIRT_PATH'},
  {name:'mine road',a:{x:262,z:88},b:{x:262,z:110},width:2,block:'DIRT_PATH'},
  // Added with the new house lots (skills/property.mjs NEW_LOTS): always append, the builder counts roads by index.
  {name:'village street south',a:{x:300,z:117},b:{x:300,z:140},width:3,block:'GRAVEL'},
];
// Founding plan, adopted when the settlement was laid out. New zones go through the governor.
const FOUNDING_ZONES=[
  {id:'z1',name:'Village street',kind:'houses',x1:290,z1:62,x2:312,z2:118},
  {id:'z2',name:'Town centre',kind:'public',x1:262,z1:86,x2:292,z2:111},
  {id:'z3',name:'Farm fields',kind:'farms',x1:264,z1:86,x2:280,z2:101},
  {id:'z4',name:'North district',kind:'public',x1:258,z1:54,x2:296,z2:74},
  {id:'z5',name:'West quarter',kind:'public',x1:230,z1:66,x2:258,z2:100},
  {id:'z6',name:'Mine',kind:'industry',x1:236,z1:108,x2:265,z2:116},
];
// Civic zones added after the founding (registered once, on start): the courthouse grounds.
const CIVIC_ZONES=[{id:'z7',name:'Courthouse',kind:'civic',x1:239,z1:82,x2:261,z2:106},   // west of the mine road and the farm fields
  {id:'z8',name:'Infirmary',kind:'civic',x1:226,z1:95,x2:238,z2:107}];
const SQUARE={x:283.5,z:93.5},MARKET={x:278.5,z:105.5};
// Everything a citizen can eat, most filling first (town.mjs; includes the fisher's fish and the forager's berries).
const FOODS=EDIBLE_FOODS;
const KEEP=/(_SWORD|_PICKAXE|_AXE|_SHOVEL|_HOE|_HELMET|_CHESTPLATE|_LEGGINGS|_BOOTS|^SHIELD$)/;

export function createCivic(d){
  const {configs,memory,act,say,walk,clampMove,dispatch,log,ledger,conversation,playerByName,homeOf,homeBuilt,getSnapshot,lm}=d;
  // The intelligence stack (work orders, trust matrix, spatial memory) replaces the old quests and friendship scores.
  const intel=()=>d.intel?.();
  const town=memory.data.town??={};
  town.day??=1;town.zones??=FOUNDING_ZONES.map(z=>({...z,status:'adopted',by:'founders'}));
  for(const z of CIVIC_ZONES)if(!town.zones.some(x=>x.id===z.id))town.zones.push({...z,status:'adopted',by:'charter'});
  town.unlocked??=[];town.built??={};town.roadsDone??=0;town.quests??=[];town.questNext??=1;town.affinity??={};   // kept for the one-time migration into the database
  // Material reservations for construction phases; kept and broken supply promises become lasting impressions.
  const reservations=createReservations(town.reservations??={},{log,onPromise:(builder,p)=>{
    const s=intel()?.social,what=`${p.count>1&&p.item!=='*reserved'?p.count+' ':''}${p.item==='*reserved'?'the reserved materials':String(p.item).toLowerCase().replace(/_/g,' ')}`;
    if(!s||!builder||builder===p.who)return;
    if(p.state==='kept')s.mark(builder,p.who,'favor',`brought ${what} on time`,0.15);
    else if(p.state==='late')s.remember(builder,p.who,'favor',`brought ${what}, late`,0.05);
    else if(p.state==='broken')s.mark(builder,p.who,'grudge',`promised ${what} and did not bring it`,0.2);
  }});
  town.conflicts??=[];for(const x of town.conflicts)if(!x.resolved&&/haul/.test(x.topic)){x.resolved=true;x.resolution='hauling is the courier job';}town.chronicle??=[];town.today??={harvested:0,kills:0};town.festival??=null;town.kills??=0;
  town.stock??={items:{},chests:[],time:0};
  // Market (live prices, what the merchant owes producers), master plans, council, climate, alerts, tool orders.
  town.owed??={};town.plan??={funded:[],done:[],attempts:{}};town.council??={last:null,history:[],next:null};
  town.climate??={season:null,drought:null,growth:100};town.alert??=null;town.toolOrders??={};town.lastThreat??=0;
  // A config's role, falling back to its id (the builder and scout have no explicit role).
  const roleOf=c=>c.role??c.id;
  const ids=configs.map(c=>c.id),byRole=role=>configs.find(c=>roleOf(c)===role);
  const stateOf=id=>memory.data.agents[id];
  // One-time cleanup: older diary entries were stored as the model's raw JSON or with a "Day N." prefix.
  for(const a of Object.values(memory.data.agents??{}))for(const e of a?.diary??[])if(typeof e?.text==='string')e.text=cleanDiaryText(e.text).slice(0,300);
  // The elected governor (if any) runs meetings; otherwise the governor by role.
  const governorOf=()=>configs.find(c=>c.id===town.governor)??byRole('governor');
  const sound=(id,key,volume=1)=>act(id,{type:'sound',x:0,y:0,z:0,target:key,count:volume}).catch(()=>{});
  const travel=d.travel??((id,self,dest)=>walk(id,clampMove({type:'pathfind',x:dest.x,y:dest.y,z:dest.z},self)));
  const tasks=[];                       // model tasks for the main loop (diaries, speeches, chronicle)
  let lastTick=Date.now(),lastStock=0,lastPhase=null,tick=0,raid={active:false,warned:0};
  const cooldown=new Map();
  const ready=(key,ms)=>{const t=cooldown.get(key)??0;if(Date.now()-t<ms)return false;cooldown.set(key,Date.now());return true;};
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const warehouse=()=>{if(!town.built.warehouse)return null;const r=town.warehouseRoom;return r?{x:(r.x1+r.x2+1)/2,z:(r.z1+r.z2+1)/2}:{x:SITES.warehouse.x+4.5,z:SITES.warehouse.z+3.5};};
  /** A spot just outside the warehouse's west door when `self` is inside it (9 x 7 blocks), else null. */
  function warehouseExit(self){
    if(!town.built.warehouse||!self||!insideWarehouse(self))return null;
    const d=ROOM().door,[ox,oz]=outward();
    return {x:d.x+0.5+ox*3.5+(ox?0:(Math.random()-0.5)*4),z:d.z+0.5+oz*3.5+(oz?0:(Math.random()-0.5)*4)};
  }

  // ---------- skills ----------
  function award(id,kind,amount=1){
    const s=stateOf(id);if(!s)return;
    if(AWARD_ACTIVITY[kind])d.economy?.()?.labor(id,AWARD_ACTIVITY[kind],amount);
    const before=levelOf(s.xp??0);s.xp=Math.round(((s.xp??0)+(XP[kind]??0)*amount)*10)/10;
    const after=levelOf(s.xp);
    if(after>before){const title=`${TITLES[after-1]} ${configs.find(c=>c.id===id)?.role??id}`;
      ledger(id,`became a ${title}`);log('level_up',{agent:id,level:after});say(id,`I've become a ${title}!`);sound(id,'entity.player.levelup');}
  }
  const levelFor=id=>levelOf(stateOf(id)?.xp??0);

  // ---------- friendships ----------
  // Shared experiences move trust both ways (old -10..10 steps, 4 trust points each).
  const EFFECTS_BUMP={trust:-0.5,reliability:0};
  function befriend(a,b,delta){if(ids.includes(a)&&ids.includes(b))intel()?.social.adjustPair(a,b,{trust:delta*4},delta>=0?'friendly_interaction':'friction');}
  const relations=id=>intel()?.social.relationsOf(id)??{friends:[],rivals:[]};

  // ---------- warehouse stock ----------
  async function refreshStock(){
    const snap=getSnapshot();const any=snap?.agents?.[0];if(!any||!town.built.warehouse)return;
    try{
      // Chests already standing in the warehouse (from earlier builds) become pantry chests, once.
      if(!town.chestsAdopted){const n=await act(any.id,{type:'adoptchests',x:SITES.warehouse.x,y:0,z:SITES.warehouse.z,width:9,depth:7}).catch(()=>null);if(n){town.chestsAdopted=true;if(n.adopted)log('chests_adopted',n);}}
      const r=await act(any.id,{type:'stock',x:0,y:0,z:0}),w=SITES.warehouse;
      // Only chests inside the warehouse are the town pantry; chests in homes stay personal.
      const wb=town.warehouseRoom?.walls,box=wb?{x1:wb.x1-1,z1:wb.z1-1,x2:wb.x2+1,z2:wb.z2+1}:{x1:w.x,z1:w.z,x2:w.x+8,z2:w.z+6};   // the chests in the walls (and the outer wall layer) belong to it too
      const chests=r.chests.filter(c=>c.x>=box.x1&&c.x<=box.x2&&c.z>=box.z1&&c.z<=box.z2),items={};
      for(const c of chests)for(const [k,v] of Object.entries(c.items??{}))items[k]=(items[k]??0)+v;
      town.stock={items,chests,time:Date.now()};
      wmap.assign(chests);   // categories for any new chest (skills/warehouse.mjs)
      intel()?.onChests(any.id,chests);
    }catch{}
  }
  // ---------- the warehouse map (skills/warehouse.mjs): categories, locks, the location index ----------
  const wmap=new WarehouseMap(town.warehouseMap??={});
  const slotsOf=slotsUsed;   // beds, tools and potions take a slot each (skills/warehouse.mjs)
  /** Book a change to one chest (the clerk's moves, deposits, withdrawals): its items, free slots and the totals. */
  function noteChest(at,item,delta){
    if(!delta)return;const c=town.stock.chests.find(x=>chestKey(x)===chestKey(at));if(!c)return;
    c.items[item]=Math.max(0,(c.items[item]??0)+delta);if(!c.items[item])delete c.items[item];
    c.free=Math.max(0,(c.size??54)-slotsOf(c.items));
    town.stock.items[item]=Math.max(0,(town.stock.items[item]??0)+delta);
  }
  /**
   * Survey the (expanded) warehouse: scan the area around it for chests and the walls around them. Records every chest
   * with its block neighbours (so wall chests can be told from free-standing floor chests) in town.warehouseSurvey.
   */
  async function surveyWarehouse(by){
    const W=SITES.warehouse,floor=(town.warehouseFloor??70)-1,box={x1:W.x-14,z1:W.z-12,x2:W.x+22,z2:W.z+18},cells=new Map();
    const id=by??anyOnline();if(!id)throw Error('nobody online to survey');
    for(let x=box.x1;x<=box.x2;x+=8)for(let z=box.z1;z<=box.z2;z+=8){
      const r=await act(id,{type:'scan',x,y:floor,z,width:8,height:6,depth:8}).catch(e=>({error:e.message}));
      for(const [cx,cy,cz,type,solid,natural] of r?.cells??[])cells.set(`${cx},${cy},${cz}`,{type,solid,natural});
    }
    const at=(x,y,z)=>cells.get(`${x},${y},${z}`)??null;
    const chests=[...cells.entries()].filter(([,c])=>/CHEST$|^BARREL$/.test(c.type)&&c.type!=='ENDER_CHEST').map(([k,c])=>{const [x,y,z]=k.split(',').map(Number);
      const around=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>at(x+dx,y,z+dz)?.type??'AIR');
      return {x,y,z,type:c.type,around,above:at(x,y+1,z)?.type??'AIR'};});
    town.warehouseSurvey={time:Date.now(),box,floor:floor+1,chests};
    log('warehouse_survey',{by:id,chests:chests.length,box});
    // The walls: rows of chests along x (north and south walls) and columns along z (east/west walls) near the old site.
    const near=chests.filter(c=>c.type==='CHEST'&&Math.hypot(c.x-(W.x+4),c.z-(W.z+3))<=12);
    const rows={},cols={};for(const c of near){(rows[c.z]??=new Set()).add(c.x);(cols[c.x]??=new Set()).add(c.z);}
    const rowZ=Object.keys(rows).map(Number).filter(z=>rows[z].size>=4),colX=Object.keys(cols).map(Number).filter(x=>cols[x].size>=4);
    if(rowZ.length<2&&colX.length<2)return town.warehouseSurvey;   // no walls of chests: leave the room as it is
    const zs=rowZ.length?rowZ:[W.z,W.z+6],xs=[...rowZ.flatMap(z=>[...rows[z]]),...colX];
    const walls={x1:Math.min(W.x,...xs),z1:Math.min(...zs,...colX.flatMap(x=>[...cols[x]]))-0,x2:Math.max(...xs),z2:Math.max(...zs)};
    walls.z1=Math.min(...zs);walls.z2=Math.max(...zs);
    // The door: an opening in the wall without chests (two blocks of air in that wall line), nearest its middle.
    // The door: a two-high opening (air or a door) in the wall that is also open on BOTH sides - a recess open only
    // to the inside is an alcove, not a way in (the rebuilt warehouse has alcoves beside its double door). A double
    // door is one doorway: door = {x, z} of its middle, with its extent (z1..z2 or x1..x2) for the lane.
    const pass=(x,z)=>{const t=at(x,floor+1,z)?.type??'AIR',u=at(x,floor+2,z)?.type??'AIR';return /(_DOOR$|^AIR$)/.test(t)&&/(_DOOR$|^AIR$)/.test(u);};
    const cands=[];
    for(let z=walls.z1+1;z<walls.z2;z++)for(const [x,o] of [[walls.x1,-1],[walls.x2,1]])
      if(pass(x,z)&&pass(x+o,z)&&pass(x-o,z))cands.push({x,z,axis:'z'});
    for(let x=walls.x1+1;x<walls.x2;x++)for(const [z,o] of [[walls.z1,-1],[walls.z2,1]])
      if(!rowZ.includes(z)&&pass(x,z)&&pass(x,z+o)&&pass(x,z-o))cands.push({x,z,axis:'x'});
    const mid={x:(walls.x1+walls.x2)/2,z:(walls.z1+walls.z2)/2};
    const first=cands.sort((a,b)=>Math.hypot(a.x-mid.x,a.z-mid.z)-Math.hypot(b.x-mid.x,b.z-mid.z))[0];
    let door={x:walls.x1,z:Math.round(mid.z)};
    if(first){const run=cands.filter(c=>c.axis===first.axis&&(first.axis==='z'?c.x===first.x&&Math.abs(c.z-first.z)<=2:c.z===first.z&&Math.abs(c.x-first.x)<=2));
      const vs=run.map(c=>first.axis==='z'?c.z:c.x),lo=Math.min(...vs),hi=Math.max(...vs);
      door=first.axis==='z'?{x:first.x,z:(lo+hi)/2,z1:lo,z2:hi}:{x:(lo+hi)/2,z:first.z,x1:lo,x2:hi};}
    town.warehouseRoom={x1:walls.x1+1,z1:walls.z1+1,x2:walls.x2-1,z2:walls.z2-1,door,walls};
    // In the wall by the door (the outer layer included): a copper chest is the citizens' drop box, and the crafting table.
    const byDoor=c=>c.x>=walls.x1-1&&c.x<=walls.x2+1&&c.z>=walls.z1-1&&c.z<=walls.z2+1&&Math.hypot(c.x-door.x,c.z-door.z)<=5;
    const copper=chests.filter(c=>/COPPER_CHEST$/.test(c.type)&&byDoor(c));
    const table=[...cells.entries()].filter(([,c])=>c.type==='CRAFTING_TABLE').map(([k])=>{const [x,y,z]=k.split(',').map(Number);return {x,y,z};}).filter(byDoor)[0]??null;
    town.warehouseRoom.dropBox=copper.map(c=>({x:c.x,y:c.y,z:c.z}));town.warehouseRoom.craftingTable=table;
    // Every chest in the walls becomes a town chest (both halves of a double; the plugin lists it once). The plugin
    // adopts chests within 3 blocks of the adopter's height: he stands inside on the floor first (all three rows).
    const inside=()=>{const s=getSnapshot()?.agents.find(a=>a.id===id);return s&&insideWarehouse(s)&&Math.abs(s.y-(floor+1))<=1;};
    if(!inside()){const r=town.warehouseRoom;await walk(id,{type:'pathfind',x:(r.x1+r.x2+1)/2,y:floor+1,z:(r.z1+r.z2+1)/2}).catch(()=>{});
      for(let i=0;i<40&&!inside();i++)await new Promise(res=>setTimeout(res,500));}
    const adopted=await act(id,{type:'adoptchests',x:walls.x1-1,y:0,z:walls.z1-1,width:Math.min(16,walls.x2-walls.x1+3),depth:Math.min(16,walls.z2-walls.z1+3)}).catch(e=>({error:e.message}));
    // The layout: north wall west half building blocks, east half ores and metals; the east wall food; the south wall
    // tools, redstone, valuables, then the drop box (bottom) and overflow (above) at its east end. Floor chests retire.
    const inWall=c=>c.z===walls.z1||c.z===walls.z2||c.x===walls.x1||c.x===walls.x2;
    // Sections split along the chest rows themselves (not the wall), so a boundary never cuts a double chest in two.
    const rowX=z=>near.filter(c=>c.z===z).map(c=>c.x),lo=z=>Math.min(...rowX(z)),hi=z=>Math.max(...rowX(z));
    const span=(a,l,h)=>(a-l+0.5)/Math.max(1,h-l+1);
    const plan={};
    for(const c of near){
      const k=`${c.x},${c.y},${c.z}`;
      if(!inWall(c)){plan[k]='RETIRED';continue;}
      if(c.z===walls.z1)plan[k]=span(c.x,lo(c.z),hi(c.z))<0.5?'BUILDING_BLOCKS':'ORES_AND_METALS';
      else if(c.z!==walls.z2)plan[k]='FOOD_AND_AGRICULTURE';   // the east (or west) wall
      else{const f=span(c.x,lo(c.z),hi(c.z));plan[k]=f<0.25?'TOOLS_AND_EQUIPMENT':f<0.5?'REDSTONE_AND_COMPONENTS':f<0.75?'MISC_AND_VALUABLES':c.y<=floor+1&&!copper.length?'INPUT_DROP_BOX':'OVERFLOW';}
    }
    for(const c of copper)plan[`${c.x},${c.y},${c.z}`]='INPUT_DROP_BOX';
    wmap.state.assign=plan;wmap.state.overflow={};town.warehouseDirectory=directory();if(town.clerk)town.clerk.floorEmptyAnnounced=false;
    log('warehouse_room',{room:town.warehouseRoom,adopted:adopted?.adopted??adopted?.error,wall:Object.values(plan).filter(v=>v!=='RETIRED').length,retired:Object.values(plan).filter(v=>v==='RETIRED').length});
    lastStock=0;await refreshStock();
    return town.warehouseSurvey;
  }
  /**
   * Where everything is, in words citizens (and players) can use: each category and the wall and blocks it occupies.
   */
  function directory(){
    const r=town.warehouseRoom;if(!r)return null;
    const name={BUILDING_BLOCKS:'building blocks',ORES_AND_METALS:'ores and metals',FOOD_AND_AGRICULTURE:'food and farm goods',TOOLS_AND_EQUIPMENT:'tools and equipment',
      REDSTONE_AND_COMPONENTS:'redstone, torches and rails',MISC_AND_VALUABLES:'valuables and everything else',INPUT_DROP_BOX:'the drop box for unsorted hauls',OVERFLOW:'overflow'};
    const wallOf=(x,z)=>z===r.walls.z1?'north':z===r.walls.z2?'south':x===r.walls.x2?'east':'west';
    const groups={};for(const [k,cat] of Object.entries(wmap.state.assign)){if(cat==='RETIRED')continue;const [x,y,z]=k.split(',').map(Number);const wall=wallOf(x,z);const g=groups[`${cat}|${wall}`]??={cat,wall,xs:[],zs:[],ys:[]};g.xs.push(x);g.zs.push(z);g.ys.push(y);}
    const extras=[];
    if(r.dropBox?.length)extras.push(`the drop box for everything you bring in: the copper chest just inside the door, on the left as you enter (${r.dropBox[0].x},${r.dropBox[0].y},${r.dropBox[0].z})`);
    if(r.craftingTable)extras.push(`the crafting table: beside it (${r.craftingTable.x},${r.craftingTable.y},${r.craftingTable.z})`);
    return [...extras,...Object.values(groups).filter(g=>!(g.cat==='INPUT_DROP_BOX'&&r.dropBox?.length)).map(g=>{const cat=g.cat;const along=g.wall==='north'||g.wall==='south'?`x ${Math.min(...g.xs)}-${Math.max(...g.xs)}`:`z ${Math.min(...g.zs)}-${Math.max(...g.zs)}`;
      return `${name[cat]??cat.toLowerCase()}: ${g.wall} wall, ${along}${cat==='INPUT_DROP_BOX'?' (bottom row)':cat==='OVERFLOW'?' (upper rows)':''}`;})].join('; ');
  }
  /** Where a material is in the warehouse (getMaterialLocation): [{x,y,z,count,category}], most first. */
  function getMaterialLocation(item,{by=null}={}){
    const at=wmap.locationOf(item,town.stock.chests??[]);
    if(by&&ready(`where:${by}:${item}`,300000))log('material_query',{by,item,found:at.slice(0,3)});
    return at;
  }
  const chestWith=(item,need=1)=>town.stock.chests.find(c=>(c.items?.[item]??0)>=need)??town.stock.chests.find(c=>(c.items?.[item]??0)>0);
  const freeChest=()=>town.stock.chests.find(c=>c.free>0);
  // ---------- warehouse spots ----------
  // Everyone used to aim at the warehouse centre and count as arrived within 3.5 blocks - which is the doorway. The
  // whole town stood in and around the door (it never closed) and shoved each other in circles. Now each citizen gets
  // a free floor cell inside, within reach of every chest and clear of the door lane; when all are taken they queue
  // outside beside the wall, not in front of the door.
  // The room inside the warehouse walls: from the last survey (surveyWarehouse, after a player rebuilt it), else the
  // original 9 x 7 building. walls = the outer box (chests in the walls count as the warehouse's), door = the doorway.
  const W=()=>SITES.warehouse;
  const ROOM=()=>town.warehouseRoom??{x1:W().x+1,z1:W().z+1,x2:W().x+7,z2:W().z+5,door:{x:W().x,z:W().z+3},walls:{x1:W().x,z1:W().z,x2:W().x+8,z2:W().z+6}};
  /** The way out through the door: [dx,dz] pointing outside. */
  const outward=()=>{const r=ROOM(),d=r.door;return d.x<=r.walls.x1?[-1,0]:d.x>=r.walls.x2?[1,0]:d.z<=r.walls.z1?[0,-1]:[0,1];};
  const doorLane=(x,z)=>{const d=ROOM().door,[ox]=outward();
    // Two blocks in, three out (the approach outside a thick wall too), and one cell either side of the doorway.
    const io=v=>{const [ox2,oz2]=outward(),out=(ox2||oz2)*(v)>0;return out?Math.abs(v)<=3:Math.abs(v)<=2;};
    return ox?z>=(d.z1??d.z)-1&&z<=(d.z2??d.z)+1&&io(x-d.x):x>=(d.x1??d.x)-1&&x<=(d.x2??d.x)+1&&io(z-d.z);};
  const insideWarehouse=p=>{const r=ROOM();return p.x>=r.x1&&p.x<r.x2+1&&p.z>=r.z1&&p.z<r.z2+1;};
  // In the original small room every chest was in reach from the right spot; in a rebuilt one citizens walk to the chest.
  const chestReach=(x,z)=>!!town.warehouseRoom||(town.stock?.chests??[]).every(c=>Math.hypot(c.x+0.5-x,c.z+0.5-z)<=4.3);
  const slotOf=new Map();
  function warehouseCells(){
    const r=ROOM(),chests=new Set((town.stock?.chests??[]).map(c=>`${c.x},${c.z}`)),cells=[];
    for(let x=r.x1;x<=r.x2;x++)for(let z=r.z1;z<=r.z2;z++)
      if(!chests.has(`${x},${z}`)&&!doorLane(x,z)&&chestReach(x+0.5,z+0.5))cells.push({x:x+0.5,z:z+0.5});
    return cells;
  }
  /** To the warehouse crafting table (when there is one): crafting for the town's builds is done there. */
  const atCraftingTable=id=>town.warehouseRoom?.craftingTable?reachChest(id,town.warehouseRoom.craftingTable):Promise.resolve(true);
  /**
   * Walk to within reach of one chest (a rebuilt warehouse is bigger than an arm's reach): to the floor cell in front
   * of it, waiting up to 8 s. True once in reach.
   */
  async function reachChest(id,chest){
    const me=()=>getSnapshot()?.agents.find(a=>a.id===id),gap=s=>Math.hypot(chest.x+0.5-s.x,(chest.y??70)+0.5-(s.y+1),chest.z+0.5-s.z);
    let s=me();if(!s)return false;if(gap(s)<=4.5)return true;
    const r=ROOM();let fx=Math.min(r.x2,Math.max(r.x1,chest.x)),fz=Math.min(r.z2,Math.max(r.z1,chest.z));
    if(doorLane(fx,fz)){const [ox,oz]=outward();fx-=ox*3;fz-=oz*3;}   // not in the doorway: a step further in
    await walk(id,{type:'pathfind',x:fx+0.5,y:town.warehouseFloor??Math.round(s.y),z:fz+0.5}).catch(()=>{});
    for(let i=0;i<16;i++){await new Promise(res=>setTimeout(res,500));s=me();if(s&&gap(s)<=4.5)return true;}
    return false;
  }
  function warehouseSlot(id){
    const others=(getSnapshot()?.agents??[]).filter(a=>a.id!==id),taken=c=>others.some(a=>Math.hypot(a.x-c.x,a.z-c.z)<0.9)
      ||[...slotOf].some(([o,s])=>o!==id&&s.x===c.x&&s.z===c.z&&others.some(a=>a.id===o&&Math.hypot(a.x-s.x,a.z-s.z)<8));
    const mine=slotOf.get(id);if(mine&&!taken(mine))return mine;
    const free=warehouseCells().filter(c=>!taken(c)).sort((a,b)=>b.x-a.x);   // deepest first: the door end fills last
    if(!free.length){slotOf.delete(id);return null;}
    slotOf.set(id,free[0]);return free[0];
  }
  /** Where to queue outside while the warehouse is full: along the west wall, two blocks either side of the door. */
  const queueSpot=id=>{let h=0;for(const ch of id)h=(h*31+ch.charCodeAt(0))>>>0;const side=h%2?1:-1;
    // 3-4 blocks out: past a thick wall and the step up to the door (the rebuilt warehouse has both).
    // >>> (unsigned): a big hash made h>>1 negative and pulled some citizens' spots into the door lane itself.
    const d=ROOM().door,[ox,oz]=outward(),half=ox?((d.z2??d.z)-(d.z1??d.z))/2:((d.x2??d.x)-(d.x1??d.x))/2;
    let out=3+(h>>>1)%2;const along=side*(3+half+(h>>>2)%2);
    let q={x:d.x+0.5+ox*out+(ox?0:along),z:d.z+0.5+oz*out+(oz?0:along)};
    while(doorLane(Math.floor(q.x),Math.floor(q.z))&&out<8){out++;q={x:d.x+0.5+ox*out+(ox?0:along),z:d.z+0.5+oz*out+(oz?0:along)};}   // never in the lane
    return q;};
  /** Standing still in the warehouse door lane (inside or out) for 5 s: the spot to step aside to, else null. */
  const laneSince=new Map();
  function doorwayExit(id,self){
    if(!town.built.warehouse||!self||self.pathing)return null;
    const x=Math.floor(self.x),z=Math.floor(self.z),inLane=doorLane(x,z);
    if(!inLane){laneSince.delete(id);return null;}
    // At their own counter or warehouse spot (the cell beside the door can be one): waiting there is not loitering - the
    // miner was moved off the counter every 30 s and never handed in his load.
    const own=counterOf.get(id)??slotOf.get(id);
    if(own&&Math.hypot(self.x-own.x,self.z-own.z)<=1.2){laneSince.delete(id);return null;}
    const since=laneSince.get(id)??Date.now();laneSince.set(id,since);
    if(Date.now()-since<5000)return null;
    laneSince.delete(id);
    // Inside: to a free spot (or out to the queue if none); outside: to the queue spot beside the wall.
    // Inside, or standing in the door itself (on the way in): a spot further in; only outside: the queue beside the wall.
    const [ox2,oz2]=outward(),d2=ROOM().door,inDoor=ox2?x===d2.x:z===d2.z;
    // On the way in (a spot inside is already theirs from goToWarehouse) or standing in the door: help them in.
    const headingIn=slotOf.has(id)||counterOf.has(id);
    const slot=insideWarehouse({x:x+0.5,z:z+0.5})||inDoor||headingIn?warehouseSlot(id):null;
    return slot??queueSpot(id);
  }
  async function goToWarehouse(id,self){
    const w=warehouse();if(!w)return false;
    // Jasper on duty: everyone else comes no further than the counter (by the drop box, just inside the door).
    if(clerkOn()&&!isClerk(id)){
      const spot=counterSlot(id);
      if(spot){
        if(Math.hypot(self.x-spot.x,self.z-spot.z)<=1.6)return true;
        if(self.pathing)return false;
        const y=town.warehouseFloor??Math.round(self.y);
        if(Math.hypot(self.x-spot.x,self.z-spot.z)<=12)await walk(id,{type:'pathfind',x:spot.x,y,z:spot.z}).catch(()=>{});
        else await travel(id,self,{x:spot.x,y,z:spot.z}).catch(()=>{});
        return false;
      }
    }
    // Arrived: inside, off the door lane, every chest within reach.
    if(insideWarehouse(self)&&!doorLane(Math.floor(self.x),Math.floor(self.z))&&chestReach(self.x,self.z))return true;
    if(self.pathing)return false;
    const slot=warehouseSlot(id);
    const y=town.warehouseFloor??Math.round(self.y);
    if(!slot){
      const q=queueSpot(id);
      if(Math.hypot(self.x-q.x,self.z-q.z)>1.5)await travel(id,self,{x:q.x,y,z:q.z}).catch(()=>{});
      if(ready(`wh-queue:${id}`,120000))log('warehouse_queue',{agent:id,reason:'every spot inside is taken'});
      return false;
    }
    if(Math.hypot(self.x-slot.x,self.z-slot.z)<=12){await walk(id,{type:'pathfind',x:slot.x,y,z:slot.z}).catch(()=>{});return false;}
    if(!self.pathing){
      // Survey the ground just outside the west wall: at the centre the highest block is the roof.
      // The floor is one block above the ground, so stand at ground + 2.
      town.warehouseFloor??=await act(id,{type:'survey',x:SITES.warehouse.x-2,y:0,z:SITES.warehouse.z+3,width:1,depth:1}).then(r=>Number.isFinite(r?.heights?.[0])?r.heights[0]+2:undefined).catch(()=>undefined);
      const y=town.warehouseFloor??Math.round(self.y);
      await travel(id,self,{x:slot.x,y,z:slot.z}).catch(()=>{});
    }
    return false;
  }
  /**
   * Getting goods, in order: the warehouse; when it is out, Marlo's market (they walk over and buy it); when the
   * market has none either, a work order to whoever makes it (the crafter, the smith, the miner, the farmer...).
   * The clerk and the trader themselves only use the warehouse.
   */
  async function withdraw(id,item,count,opts={}){
    const got=await withdrawWarehouse(id,item,count,opts);
    const pending=(town.deliveries??[]).find(r=>r.to===id&&r.item===item);
    const inTransit=pending&&Object.values(memory.data.agents??{}).some(s=>s.errand?.requestId===pending.id&&s.errand.loaded);
    if(pending&&((town.stock.items[item]??0)>0||inTransit))return got;
    if(got>=count||opts.procure===false||['clerk','merchant','chef'].includes(roleOf(id)))return got;
    const bought=await marketBuy(id,item,count-got).catch(e=>{log('market_buy_error',{agent:id,item,message:e.message});return 0;});
    if(got+bought<count)askProducer(id,item,count-got-bought);
    return got+bought;
  }
  /** Who makes an item (the work order goes to them first). */
  function producerOf(item){
    const role=/_LOG$|_WOOD$|_SAPLING$/.test(item)&&!/^STRIPPED_/.test(item)?'lumberjack'
      :/^(COD|SALMON|TROPICAL_FISH|PUFFERFISH|INK_SAC|NAUTILUS_SHELL)$/.test(item)?'fisher'
      :/(SEEDS$|^WHEAT$|^CARROT$|^POTATO$|^BEETROOT$|^SWEET_BERRIES$|^PUMPKIN$|^MELON|^SUGAR_CANE$|^EGG$|^HAY_BLOCK$)/.test(item)?'farmer'
      :/(^BREAD$|^COOKED_|^BAKED_POTATO$|_STEW$|_SOUP$|^CAKE$|^PUMPKIN_PIE$|^COOKIE$)/.test(item)?'chef'
      :/POTION/.test(item)?'herbalist'
      :/^(IRON|GOLDEN|DIAMOND|NETHERITE|CHAINMAIL)_(SWORD|AXE|PICKAXE|SHOVEL|HOE|HELMET|CHESTPLATE|LEGGINGS|BOOTS)$|_INGOT$|_NUGGET$|^ANVIL$|^IRON_BARS$|BUCKET$|^SHEARS$|^IRON_DOOR$|^CAULDRON$/.test(item)?'smith'
      :MINED.has?.(item)||/^RAW_|_ORE$|^COAL$|^DIAMOND$|^EMERALD$|^REDSTONE$|^LAPIS_LAZULI$|^FLINT$|^CLAY_BALL$|^COBBLESTONE$|^COBBLED_DEEPSLATE$|^STONE$|^GRAVEL$|^SAND$/.test(item)?'miner'
      :recipeFor(item)?'crafter':'crafter';
    return byRole(role)??byRole('crafter');
  }
  /** Nobody has it: ask the maker (a work order offered to them first; once per item per 20 minutes). */
  function askProducer(id,item,n){
    if(!ready(`procure:${item}`,1200000))return;
    const maker=producerOf(item);if(!maker||maker.id===id)return;
    log('procure_order',{agent:id,item,count:n,maker:maker.id,why:'not in the warehouse or the market'});
    postQuest(id,item,n,`not in the warehouse or the shops - ${nameOf(maker.id)}, can you make some?`,{preferred:maker.id}).catch(()=>{});
  }
  /**
   * A citizen buys from a shop when the warehouse is out: food at Antoine's bakery first, anything at Marlo's market.
   * They walk there, take it from the shelves and pay at the market price (to the town, whose surplus it is).
   */
  async function marketBuy(id,item,count){
    let got=0;
    for(const shop of ((FOOD_POINTS[item]??0)>0?['chef','merchant']:['merchant'])){
      if(got>=count)break;
      const st=shopState(shop),spot=shopSpot(shop);
      if(!spot||!st.setup?.done||!((st.stock?.items?.[item]??0)>0)||roleOf(id)===shop)continue;
      const me=()=>getSnapshot()?.agents.find(a=>a.id===id);
      let there=false;
      for(let i=0;i<120;i++){
        const s=me();if(!s)break;
        if(Math.hypot(s.x-spot.x,s.z-spot.z)<=3){there=true;break;}
        if(!s.pathing&&i%5===0)await travel(id,s,{x:spot.x,y:spot.y,z:spot.z}).catch(()=>{});
        await new Promise(r=>setTimeout(r,1000));
      }
      if(!there)continue;
      let here=0;
      for(const ch of (st.stock.chests??[]).filter(c=>(c.items?.[item]??0)>0)){
        if(got+here>=count)break;
        const r=await act(id,{type:'withdraw',x:ch.x,y:ch.y,z:ch.z,target:item,count:Math.min(count-got-here,ch.items[item])}).catch(()=>null);
        if(r?.withdrew){here+=r.withdrew;ch.items[item]-=r.withdrew;}
      }
      if(!here)continue;
      got+=here;st.stock.items[item]=Math.max(0,(st.stock.items[item]??0)-here);
      const cost=(prices()[item]?.value??1)*here/40,where=SHOPS[shop].name;
      const what=`${here} ${item.toLowerCase().replace(/_/g,' ')}`;
      d.economy?.()?.charge(id,cost,`${what} from ${where}`).catch(()=>{});
      log('shop_bought',{agent:id,shop,item,count:here,cost:Math.round(cost*100)/100});
      ledger(id,`bought ${what} at ${where} (the warehouse was out)`);
      const k=byRole(shop);if(k&&ready(`shop-thanks:${shop}:${id}`,300000))say(k.id,shop==='chef'?`Bon appétit, ${nameOf(id)}!`:`Pleasure doing business, ${nameOf(id)}!`).catch(()=>{});
    }
    return got;
  }
  async function withdrawWarehouse(id,item,count,{onBehalf=null,direct=false}={}){
    // Never into what is reserved for someone else's construction phase (Jasper fetching for a builder: the builder's).
    count=Math.min(count,reservations.availableFor(onBehalf??id,item,town.stock.items));
    if(count<1)return 0;
    // While Jasper is on duty, nobody but him takes from the chests: they ask him at the counter.
    const runner=byRole('courier');
    if(runner&&!direct&&!isClerk(id)&&id!==runner.id){
      const queue=town.deliveries??=[];
      const already=queue.some(r=>r.to===id&&r.item===item);
      requestDelivery(queue,id,item,count);
      if(!already&&ready(`runner-request:${id}:${item}`,180000))say(id,`${nameOf(runner.id)}, please bring me ${count} ${item.toLowerCase().replace(/_/g,' ')} from the warehouse.`).catch(()=>{});
      return 0;
    }
    if(!direct&&!runner&&clerkOn()&&!isClerk(id))return askClerk(id,item,count);
    let got=0;
    while(got<count){
      // The clerk's index: the chest holding most of it that nobody is working right now.
      const loc=getMaterialLocation(item,{by:id}).find(l=>!l.locked);
      const chest=loc?town.stock.chests.find(c=>chestKey(c)===chestKey(loc)):chooseChest(town.stock.chests,item,'withdraw');if(!chest)break;
      if(!await reachChest(id,chest))break;   // a rebuilt warehouse: walk to that chest first
      const r=await act(id,{type:'withdraw',x:chest.x,y:chest.y,z:chest.z,target:item,count:count-got}).catch(()=>null);
      if(!r)break;got+=r.withdrew;noteChest(chest,item,-r.withdrew);
    }
    return got;
  }
  // ---------- Jasper's counter: citizens ask him for what they need; he fetches it from the chests ----------
  const clerkOn=()=>!!d.clerkAvailable?.()&&!!town.warehouseRoom;
  const isClerk=id=>configs.find(x=>x.id===id)?.role==='clerk';
  town.counter={requests:[],served:town.counter?.served??0};   // requests do not outlive a restart (their askers are gone)
  /** The counter: floor cells just inside the door beside the drop box (or north of the doorway), never in the lane. */
  function counterCells(){
    const r=ROOM(),box=r.dropBox?.[0],chests=new Set((town.stock?.chests??[]).map(c=>`${c.x},${c.z}`)),cells=[];
    const zc=box?box.z:(r.door.z1??r.door.z)-3;
    for(let x=r.x1;x<=r.x1+1;x++)for(let z=zc-1;z<=zc+1;z++)
      if(insideWarehouse({x:x+0.5,z:z+0.5})&&!chests.has(`${x},${z}`)&&!doorLane(x,z))cells.push({x:x+0.5,z:z+0.5});
    return cells;
  }
  const counterOf=new Map();
  function counterSlot(id){
    const others=(getSnapshot()?.agents??[]).filter(a=>a.id!==id),taken=c=>others.some(a=>Math.hypot(a.x-c.x,a.z-c.z)<0.9);
    const mine=counterOf.get(id);if(mine&&!taken(mine))return mine;
    const free=counterCells().filter(c=>!taken(c)&&![...counterOf].some(([o,s])=>o!==id&&s.x===c.x&&s.z===c.z));
    if(!free.length){counterOf.delete(id);return null;}
    counterOf.set(id,free[0]);return free[0];
  }
  /** Ask Jasper: the request waits at the counter until he hands the goods over (up to 90 s, then self-service). */
  async function askClerk(id,item,count){
    // To the counter first (up to a minute's walk): Jasper hands goods over across it and does not leave the warehouse.
    const me=()=>getSnapshot()?.agents.find(a=>a.id===id);
    for(let i=0;i<60;i++){const s=me();if(!s)break;if(await goToWarehouse(id,s))break;await new Promise(r=>setTimeout(r,1000));}
    const C=town.counter,req={key:`${id}:${item}:${Date.now()}`,who:id,item,count,at:Date.now(),status:'open',given:0,taken:false};
    C.requests.push(req);log('counter_request',{who:id,item,count});
    const clerk=byRole('clerk');
    if(clerk&&ready(`ask-say:${id}`,180000))say(id,`${nameOf(clerk.id)}, could you fetch me ${count} ${item.toLowerCase().replace(/_/g,' ')}?`).catch(()=>{});
    for(let i=0;i<180&&req.status==='open';i++){await new Promise(r=>setTimeout(r,500));if(!clerkOn()&&!req.taken)break;}
    C.requests=C.requests.filter(r=>r!==req);
    if(req.status==='done')return req.given;
    if(req.taken){req.status='abandoned';return req.given;}
    // Jasper went off duty or could not get to it: help yourself, as after hours.
    log('counter_selfserve',{who:id,item,why:clerkOn()?'no answer in 90 s':'the clerk is off duty'});
    req.status='cancelled';
    return withdrawDirect(id,item,count);
  }
  async function withdrawDirect(id,item,count){
    let got=0;
    while(got<count){
      const loc=getMaterialLocation(item,{by:id}).find(l=>!l.locked);
      const chest=loc?town.stock.chests.find(c=>chestKey(c)===chestKey(loc)):chooseChest(town.stock.chests,item,'withdraw');if(!chest)break;
      if(!await reachChest(id,chest))break;
      const r=await act(id,{type:'withdraw',x:chest.x,y:chest.y,z:chest.z,target:item,count:count-got}).catch(()=>null);
      if(!r)break;got+=r.withdrew;noteChest(chest,item,-r.withdrew);
    }
    return got;
  }
  async function deposit(id,item,count,producer=id,{strict=false}={}){
    // Storage caps (skills/supply.mjs): what is over an item's cap stays with whoever carries it.
    const room=roomFor(item,count,town.stock.items[item]??0);
    if(room<count&&ready(`capped:${id}:${item}`,600000))log('deposit_capped',{agent:id,item,offered:count,taken:room,cap:capOf(item)});
    count=room;if(count<1)return 0;
    // The courier's loads go into the input drop box for the clerk to file; everyone else's straight into the item's
    // category chest (or its overflow). Before the map exists: the old food / supplies rule.
    // Everyone's deliveries go into the citizens' drop box (the copper chest by the door) for Jasper to file; he files his own.
    const box=configs.find(x=>x.id===id)?.role!=='clerk'&&byRole('clerk')?wmap.dropBox(town.stock.chests):null;
    // Never into another category's chest (the old "any chest" fallback): with its own full, it waits for the market.
    const mapped=Object.keys(wmap.state.assign).length>0;
    const chest=(box&&box.free>0&&!wmap.locked(box,id)?box:null)??wmap.targetFor(item,town.stock.chests,{agent:id,count})??(mapped?null:chooseChest(town.stock.chests,item,"deposit")??town.stock.chests[0]);if(!chest)return 0;
    if(!await reachChest(id,chest))return 0;   // a rebuilt warehouse: walk to that chest first (they keep the goods meanwhile)
    const r=await act(id,{type:'deposit',x:chest.x,y:chest.y,z:chest.z,target:item,count}).catch(error=>{if(strict)throw error;return null;});
    if(r)for(const req of Object.values(town.reservations?.list??{}))if(req.promises.some(p=>p.state==='open'&&p.who===producer&&p.item===item))reservations.delivered(req.key,item,r.deposited,producer);
    if(r){noteChest(chest,item,r.deposited);award(id,'deposit',r.deposited/8);
      buyFrom(producer,item,r.deposited,id);}
    return r?.deposited??0;
  }

  // ---------- market: supply and demand ----------
  const prices=()=>town.prices??=marketPrices(town.stock.items,{emergency:emergencyActive()});
  const emergencyActive=()=>!!town.emergency&&town.emergency.until>=town.day;
  /** The merchant buys goods delivered to the warehouse at the live price; emeralds are paid once a whole one is owed. */
  function buyFrom(producer,item,n,hauler=producer){
    const eco=d.economy?.();
    if(eco){if(ids.includes(producer)&&item!=='EMERALD')eco.sale(producer,item,n,{price:PRICE_BOOK[item]?payoutFor({[item]:1},prices()):null,hauler});return;}
    const merchant=byRole('merchant');
    if(!merchant||producer===merchant.id||!PRICE_BOOK[item]||!ids.includes(producer))return;
    town.owed[producer]=Math.round(((town.owed[producer]??0)+payoutFor({[item]:n},prices()))*100)/100;
    const whole=Math.floor(town.owed[producer]);
    const fee=Math.floor(whole*(town.policy?.marketFee??0));
    if(fee>=1){town.owed[producer]-=fee;act(merchant.id,{type:'pay',x:0,y:0,z:0,target:'EMERALD',count:fee}).then(()=>log('market_fee',{from:producer,emeralds:fee})).catch(()=>{});}
    if(whole-fee>=1)act(merchant.id,{type:'wage',x:0,y:0,z:0,to:producer,target:'EMERALD',count:whole-fee}).then(()=>{
      town.owed[producer]=Math.round((town.owed[producer]-(whole-fee))*100)/100;
      log('market_paid',{to:producer,emeralds:whole-fee,item});
    }).catch(()=>{});
  }
  /** Recompute prices from the pantry, publish them to the trade window, and announce big moves. */
  async function updatePrices(){
    const before=town.prices;town.prices=marketPrices(town.stock.items,{emergency:emergencyActive()});
    const merchant=byRole('merchant');if(!merchant)return;
    await act(merchant.id,{type:'prices',x:0,y:0,z:0,spec:tradeValues(town.prices)}).catch(()=>{});
    const scarce=scarceFood(town.prices),was=before?scarceFood(before):[];
    const fresh=scarce.filter(k=>!was.includes(k));
    if(fresh.length&&ready('price-news',600000)){
      const k=fresh[0],p=town.prices[k],per16=Math.round(payoutFor({[k]:16},town.prices)*10)/10;
      ledger(merchant.id,`raised the price of ${k.toLowerCase().replace(/_/g,' ')} to ${p.factor}x (${per16} emeralds per 16 delivered)`);
      await say(merchant.id,`${k[0]+k.slice(1).toLowerCase().replace(/_/g,' ')} is scarce: I'm paying ${per16} emeralds for every 16 brought to the warehouse!`);
    }
  }

  // ---------- quests ----------
    /** Estimated emerald reward for delivering n of an item (a little above its value). */
  function rewardFor(item,n){const v=town.prices?.[item]?.value??1;return questReward(v*n);}
  /** Posts a work order on the board (replaces the old quest board; players can fill orders too). */
  async function postQuest(by,item,count,note,opts={}){
    const value=await act(by,{type:'appraise',x:0,y:0,z:0,target:item}).then(r=>r.value).catch(()=>1);
    return intel()?.postOrder(by,item,count,{note,reward:questReward(value*count),...opts});
  }
  async function deliver(agent,player,item,count){
    if(await intel()?.deliverFromPlayer(agent,player,item,count)){award(agent,'quest');sound(agent,'ui.toast.challenge_complete');}
  }
  // Items a contractor left in the warehouse for someone who was out of reach: they fetch them.
  function leavePickup(agent,item,count){(town.pickups??={})[agent]=[...(town.pickups[agent]??[]),{item,count}].slice(-6);}
  /** BUILD milestones: start a planned site (builders), or report it built / busy / unknown. */
  function buildSite(id,site){
    const key=String(site).toLowerCase().replace(/\s+/g,'_');
    if(!SITES[key])return 'unknown';
    if(town.built[key])return 'built';
    if(!town.plan.funded.includes(`site:${key}`)&&!town.plan.done.includes(`site:${key}`))town.plan.funded.push(`site:${key}`);
    return 'waiting';
  }

  // ---------- zones ----------
  function footprintOf(action){
    const shape=String(action.spec.shape).toLowerCase();
    if(shape==='path')return {x1:Math.min(action.x,action.spec.x2??action.x),z1:Math.min(action.z,action.spec.z2??action.z),x2:Math.max(action.x,action.spec.x2??action.x)+1,z2:Math.max(action.z,action.spec.z2??action.z)+1};
    const b=blueprint(action.spec,action.x,action.y,action.z);
    return {x1:Math.min(...b.map(p=>p.x)),z1:Math.min(...b.map(p=>p.z)),x2:Math.max(...b.map(p=>p.x)),z2:Math.max(...b.map(p=>p.z))};
  }
  /** Model-chosen builds must sit inside an adopted zone that allows them, and within the builder's skill. */
  function checkBlueprint(id,action){
    const shape=String(action.spec.shape).toLowerCase();if(shape==='cancel')return;
    const need=SHAPE_LEVEL[shape]??1;
    if(levelFor(id)<need)throw Error(`A ${shape} needs a level ${need} builder; you are level ${levelFor(id)}`);
    if(!zoneFor(footprintOf(action),shape,town.zones))throw Error('That spot is not in an adopted zone that allows it; build inside the plan or ask the governor to propose a zone');
  }
  function checkFarm(action){
    const w=Math.min(10,Math.max(1,Number(action.spec.width)||6)),dd=Math.min(10,Math.max(1,Number(action.spec.depth)||6));
    const f={x1:Math.floor(action.x-w/2),z1:Math.floor(action.z-dd/2),x2:Math.floor(action.x+w/2),z2:Math.floor(action.z+dd/2)};
    if(!town.zones.some(z=>z.status==='adopted'&&z.kind==='farms'&&f.x1>=z.x1&&f.x2<=z.x2&&f.z1>=z.z1&&f.z2<=z.z2))
      throw Error('New farms go in an adopted farm zone; ask the governor to propose one');
  }
  function proposeZone(id,action,charter){
    const zone={id:`z${town.zones.length+1}`,name:String(action.spec.name||action.text||'New district').slice(0,40),kind:String(action.spec.kind||'houses').toLowerCase(),
      x1:Math.floor(Math.min(action.x,action.spec.x2??action.x)),z1:Math.floor(Math.min(action.z,action.spec.z2??action.z)),
      x2:Math.floor(Math.max(action.x,action.spec.x2??action.x)),z2:Math.floor(Math.max(action.z,action.spec.z2??action.z)),status:'proposed',by:id};
    if(!['houses','public','park','workshops','farms','industry'].includes(zone.kind))throw Error('Zone kind must be houses, public, park, workshops, farms or industry');
    if(zone.x2-zone.x1<4||zone.z2-zone.z1<4||zone.x2-zone.x1>40||zone.z2-zone.z1>40)throw Error('Zones are 5 to 40 blocks on each side');
    const clash=town.zones.find(z=>z.status==='adopted'&&z.kind!=='public'&&z.kind!==zone.kind&&overlaps(z,zone));
    if(clash)throw Error(`Overlaps the ${clash.name} (${clash.kind}) zone`);
    town.zones.push(zone);
    return {zone,text:`Zone ${zone.id}: ${zone.name} (${zone.kind}) at ${zone.x1},${zone.z1} to ${zone.x2},${zone.z2}`};
  }
  function onProposalResolved(p,adopted){
    if(p.generated)proposalResolved(p,adopted).catch(error=>log('proposal_error',{message:error.message}));
    if(p.zone){const zone=town.zones.find(z=>z.id===p.zone);if(zone)zone.status=adopted?'adopted':'rejected';}
    // Voting with or against a proposer shifts how agents feel about each other.
    for(const [voter,vote] of Object.entries(p.votes??{}))if(voter!==p.by){befriend(voter,p.by,vote==='yes'?0.4:-0.6);
      if(ids.includes(p.by))d.onVote?.(p.by,voter,vote,p);}
  }

  // ---------- needs ----------
  function updateAllNeeds(){
    const now=Date.now(),dt=(now-lastTick)/1000;lastTick=now;
    for(const c of configs){
      const s=stateOf(c.id);if(!s)continue;
      const working=s.project||s.dig?'heavy':!!(s.farm||s.producing);
      // The guardian recovers between fights on calm days (it patrols at night instead of sleeping).
      const calmGuard=roleOf(c)==='guardian'&&!raid.active&&!d.inCombat?.(c.id)&&dayPhase(getSnapshot()?.worldTime)==='day';
      // A daytime nap (the motivation engine, for an exhausted citizen) restores energy like a night at home.
      s.needs=updateNeeds(s.needs??NEEDS_START,dt,{working,resting:!!s.resting||calmGuard||!!s.motivation?.nap||!!s.holyRest});   // holyRest: keeping the Holy Day at the shrine
    }
  }
  const bestFood=inventory=>FOODS.find(f=>(inventory?.[f]??0)>0);
  /** Eats from the pockets until nearly full (at most 4 items a sitting). Returns how many were eaten. */
  async function eatFrom(c,s,inventory){
    const left={...inventory};let eaten=0;
    while(eaten<4&&s.needs.hunger<16){
      const food=bestFood(left);if(!food)break;
      const r=await act(c.id,{type:'eat',x:0,y:0,z:0,target:food}).catch(error=>{log('eat_failed',{agent:c.id,food,message:error.message});return null;});if(!r)break;
      left[food]--;eaten++;
      // Hunger uses the food's real value (the plugin's number is for health and does not know fish).
      s.needs.hunger=Math.min(20,s.needs.hunger+(FOOD_POINTS[food]??r.value??2));
      // A restorative broth (cuisine.mjs) also lifts a tired citizen.
      const broth=RESTORATIVE.has(food);if(broth)s.needs.energy=Math.min(100,(s.needs.energy??100)+15);
      log('ate',{agent:c.id,food,hunger:Math.round(s.needs.hunger*10)/10,...(broth?{restorative:true,energy:Math.round(s.needs.energy)}:{})});
    }
    return eaten;
  }
  async function eatJob(c,s,self){
    if(bestFood(self.inventory)){await eatFrom(c,s,self.inventory);return;}
    // No meal on hand but raw wheat in the pockets (the farmer's harvest): bake bread on the spot.
    if((self.inventory?.WHEAT??0)>=3){
      const times=Math.min(4,Math.floor(self.inventory.WHEAT/3));
      if(await act(c.id,{type:'craft',x:0,y:0,z:0,target:'BREAD',count:times}).then(()=>true).catch(()=>false)){
        log('baked',{agent:c.id,bread:times});
        await eatFrom(c,s,{BREAD:times});
        return;
      }
    }
    const inStock=FOODS.find(f=>(town.stock.items[f]??0)>0);
    // On the way to the warehouse counter: the meal goes on next tick (urgentJob keeps the trip going).
    if(inStock&&!await goToWarehouse(c.id,self))return 'walking';
    if(inStock){
      const got=await withdraw(c.id,inStock,8);
      // The meal is paid for at the market price (on the citizen's tab, settled from the account in whole emeralds;
      // someone who cannot pay still eats). Without a bank, the old emerald from the pocket.
      const eco=d.economy?.();
      if(got&&eco)eco.charge(c.id,(prices()[inStock]?.value??1)*got*1.5/40,`${got} ${inStock.toLowerCase().replace(/_/g,' ')} from the warehouse`).catch(()=>{});
      else if(got&&(self.inventory?.EMERALD??0)>0)await act(c.id,{type:'pay',x:0,y:0,z:0,target:'EMERALD',count:1}).catch(()=>{});
      // Eat right there instead of waiting for the next hungry check.
      if(got)await eatFrom(c,s,{[inStock]:got});
      return;
    }
    if(!inStock&&ready(`hungry:${c.id}`,300000)){
      // A plea for food: an emergency order, the farmer asked first (ignoring it costs trust).
      const farmer=byRole('farmer');if(farmer&&farmer.id!==c.id)await say(c.id,`@${farmer.id}: I'm hungry and the warehouse has no food. Could you bring some?`);
      await postQuest(c.id,'BREAD',4,'I am starving',{priority:'EMERGENCY',preferred:farmer&&farmer.id!==c.id?farmer.id:null,targetLocation:'agent'});
    }
  }

  // ---------- builder: public works queue ----------
  // ---------- sites: open ground, site preparation, retries ----------
  const RETRY_MS=20*60000;
  /** Three failures in a row pause a site, but only for 20 minutes (conditions change: ground cleared, materials in). */
  const canTry=(tries,at,key)=>(tries?.[key]??0)<3||Date.now()-(at?.[key]??0)>RETRY_MS;
  const siteSpec=st=>({shape:st.shape,door:st.door,...(st.spec??{})});
  const siteFootprint=(st,x=st.x,z=st.z)=>blocksFootprint(blueprint(siteSpec(st),x,64,z));
  // Chosen spots are remembered (and reused after a restart).
  for(const [k,v] of Object.entries(town.sites??{}))if(SITES[k]){SITES[k].x=v.x;SITES[k].z=v.z;}
  for(const [k,v] of Object.entries(town.designs??{}))if(SITES[k]&&v.spec)SITES[k].spec={...(SITES[k].spec??{}),...v.spec};
  /**
   * The citizens vote on a public building's design before it starts (once per building). The governor calls the
   * vote and announces the result; the winning materials and size go into the site's blueprint.
   */
  async function ensureDesign(siteId,name){
    if(town.designs?.[siteId]||['warehouse','mayor_house','jail','bank','tavern','courthouse','infirmary','bakery'].includes(siteId))return town.designs?.[siteId]??null;   // the mayor's house keeps the mayor's own design
    const st=SITES[siteId],options=designOptions(st.shape,d.buildMaterials?.()??[]);if(options.length<2)return null;
    const online=new Set((getSnapshot()?.agents??[]).map(a=>a.id));
    const voters=configs.filter(c=>online.has(c.id)&&roleOf(c)!=='visitor').map(c=>({id:c.id,values:d.valuesOf?.(c.id)}));if(!voters.length)return null;
    const r=voteDesign(options,voters,{stock:town.stock.items,builder:byRole('builder')?.id});
    const gov=governorOf()?.id??byRole('builder')?.id??voters[0].id;
    await say(gov,`Town vote on the ${name}: ${options.map((o,i)=>`${i+1}) ${o.label} - ${o.about}`).join('; ')}.`.slice(0,240)).catch(()=>{});
    const counts=options.map(o=>`${o.label} ${r.tally[o.id]}`).join(', ');
    await say(gov,`The citizens have decided: the ${name} will be ${r.winner.label} (${counts}). Bram, it's yours to build!`.slice(0,240)).catch(()=>{});
    (town.designs??={})[siteId]={option:r.winner.id,about:r.winner.about,spec:r.winner.spec,tally:r.tally,ballots:r.ballots,day:town.day,at:Date.now()};
    st.spec={...(st.spec??{}),...r.winner.spec};
    ledger(gov,`the town voted on the ${name}'s design: ${r.winner.label} (${counts})`);log('design_vote',{site:siteId,winner:r.winner.id,tally:r.tally});
    return town.designs[siteId];
  }
  /** Why a footprint cannot be used (a road, another site, a farm plot), or null. */
  function reservedBy(fp,siteId){
    if(siteId.startsWith('city_')){
      for(const z of town.zones)if(['farms','industry'].includes(z.kind)&&z.status==='adopted'&&overlaps(fp,z))return 'reserved farmland or industrial ground';
      for(let x=fp.x1;x<=fp.x2;x++)for(let z=fp.z1;z<=fp.z2;z++)if(T.playerEdits?.[`${x},${z}`]&&Date.now()-T.playerEdits[`${x},${z}`]<86400000)return 'recent player changes';
      for(const cfg of configs){const h=homeOf(cfg.id);if(h&&overlaps(fp,{x1:h.x-1,x2:h.x+5,z1:h.z-1,z2:h.z+5}))return 'a citizen home';}
    }
    for(let x=fp.x1;x<=fp.x2;x++)for(let z=fp.z1;z<=fp.z2;z++)if(ROAD_COLS.has(`${x},${z}`))return 'a road';
    // Only buildings that stand (or whose ground is already chosen) hold their spot; unbuilt plans do not block each other.
    for(const [k,st] of Object.entries(SITES))if(k!==siteId&&(town.built[k]||town.sites?.[k])&&overlaps(fp,siteFootprint(st)))return `the ${k.replace(/_/g,' ')}`;
    for(const p of town.farmPlots??[])if(overlaps(fp,p))return 'a farm plot';
    for(const z of town.zones)if(z.kind==='park'&&z.status==='adopted'&&overlaps(fp,z))return 'the park';
    return null;
  }
  /**
   * The builder surveys the planned spot and nearby alternatives (a spiral, 4 blocks apart) and picks the flattest
   * open, natural ground in a zone that allows the building. Returns {x,z,y} (y = floor) or null with the reasons.
   */
  async function chooseSite(c,self,siteId){
    const st=SITES[siteId],fp0=siteFootprint(st),offx=fp0.x1-st.x,offz=fp0.z1-st.z,w=fp0.x2-fp0.x1+1,dd=fp0.z2-fp0.z1+1;
    const zoneRule=!!zoneFor(fp0,st.shape,town.zones);   // keep to the zoning when the planned spot follows it
    let best=null,surveyed=0;const why=new Map();
    // Candidates: the planned spot and its surroundings, plus a 3-block grid over every zone that allows the
    // building, nearest to the planned spot first. At most 60 are surveyed.
    const cands=new Map(spiral(st.x,st.z,4,2).map(p=>[p.join(','),p]));
    for(const zn of town.zones.filter(z=>z.status==='adopted'))for(let x=zn.x1-offx;x+offx+w-1<=zn.x2;x+=3)for(let z=zn.z1-offz;z+offz+dd-1<=zn.z2;z+=3)cands.set(`${x},${z}`,[x,z]);
    // Beyond the zones: open ground farther out (rings 4 blocks apart, up to 48 blocks from the planned spot).
    for(const p of spiral(st.x,st.z,4,12))cands.set(p.join(','),p);
    const byDistance=list=>[...list].sort((a,b)=>Math.hypot(a[0]-st.x,a[1]-st.z)-Math.hypot(b[0]-st.x,b[1]-st.z));
    const ordered=byDistance(cands.values());
    // Last resort: a wider search (rings 8 blocks apart, up to 128 blocks out) - the citizens may build anywhere.
    const far=byDistance(spiral(st.x,st.z,8,16).filter(p=>!cands.has(p.join(','))&&Math.hypot(p[0]-st.x,p[1]-st.z)>48));
    // Two passes: inside a zone that allows the building first; if nothing fits there, any open ground.
    for(const pass of zoneRule?['zoned','open','far']:['open','far']){
    if(best)break;surveyed=0;
    for(const [x,z] of pass==='far'?far:ordered){
      if(surveyed>=60)break;
      const fp={x1:x+offx,z1:z+offz,x2:x+offx+w-1,z2:z+offz+dd-1};
      if(pass==='zoned'&&!zoneFor(fp,st.shape,town.zones)){why.set('outside its zone',(why.get('outside its zone')??0)+1);continue;}
      const clash=reservedBy(fp,siteId);if(clash){why.set(`on ${clash}`,(why.get(`on ${clash}`)??0)+1);continue;}
      surveyed++;const sv=await act(c.id,{type:'survey',x:fp.x1-1,y:0,z:fp.z1-1,width:Math.min(16,w+2),depth:Math.min(16,dd+2)}).catch(()=>null);if(!sv)continue;
      const r=scoreSite(sv,fp,{allowReclamation:true});if(!r.ok){why.set(r.reason.replace(/ \(.*/,''),(why.get(r.reason.replace(/ \(.*/,''))??0)+1);continue;}
      const score=r.score+Math.hypot(x-st.x,z-st.z)*0.5;
      if(!best||score<best.score)best={x,z,y:r.floor+1,score,cut:r.cut,fill:r.fill};
      if(best.score===0)break;
    }
    }
    if(!best){log('site_unsuitable',{site:siteId,surveyed,reasons:Object.fromEntries(why)});return null;}
    const moved=best.x!==st.x||best.z!==st.z;
    st.x=best.x;st.z=best.z;(town.sites??={})[siteId]={x:best.x,z:best.z,y:best.y,cut:best.cut,fill:best.fill,at:Date.now()};
    log('site_chosen',{site:siteId,x:best.x,z:best.z,y:best.y,moved,cut:best.cut,fill:best.fill});
    return best;
  }
  /**
   * Terraforms the site before building: a 3D scan of the footprint (plus a walkway ring) from 12 blocks below the
   * floor to the top of the hill or the roof, then natural ground in the way is dug out (top down) and every column
   * under the floor is filled solid. Every planned edit is checked against the site box before it is queued.
   */
  async function prepareProject(c,s){
    if(s.project.prepared&&!s.project.terrainPending)return true;
    const p=s.project;p.buildingExpected??=structuredClone(p.expected??p.queue);const fp=blocksFootprint(p.buildingExpected),floorY=fp.y1-1;
    const sv=await act(c.id,{type:'survey',x:fp.x1-1,y:0,z:fp.z1-1,width:Math.min(16,fp.x2-fp.x1+3),depth:Math.min(16,fp.z2-fp.z1+3)}).catch(()=>null);
    const hill=Math.max(fp.y2+1,...((sv?.heights??[]).filter(Number.isFinite)));
    const box={x1:fp.x1-1,x2:fp.x2+1,z1:fp.z1-1,z2:fp.z2+1,y1:floorY-12,y2:Math.min(hill,floorY+48)};
    const cells=[];
    for(const page of scanPages(box)){
      const r=await act(c.id,{type:'scan',...page}).catch(error=>{log('scan_error',{agent:c.id,message:error.message});return null;});
      if(!r){p.prepared={failed:'scan'};p.terrainPending=true;p.terrainRetryAt=Date.now()+60000;return false;}
      cells.push(...(r.cells??[]));
    }
    const allowed=new Set(d.buildMaterials?.()??[]);
    const plan=planTerrain3D(cells,fp,floorY,box.y2,{deep:allowed.has('DIRT')?'DIRT':'COBBLESTONE'});
    const {ok,rejected}=validateEdits([...plan.clear,...plan.fill],box);
    if(plan.blocked||plan.unsupported||rejected.length){p.prepared={blocked:plan.blocked,unsupported:plan.unsupported,rejected:rejected.length};p.terrainPending=true;p.terrainRetryAt=Date.now()+600000;return false;}
    if(rejected.length)log('terraform_rejected',{agent:c.id,project:p.name,count:rejected.length,example:rejected[0]});
    p.queue.push(...ok.map(b=>({...b,tries:0})));p.total+=ok.length;
    p.expected.push(...plan.fill);p.terrainPending=false;
    p.prepared={cleared:plan.clear.length,foundation:plan.fill.length,blocked:plan.blocked,unsupported:plan.unsupported};
    if(ok.length)log('site_prepared',{agent:c.id,project:p.name,...p.prepared});return true;
  }
  /** Starts a building; public works first pick open ground and get site preparation. Returns false on failure. */
  async function startBuilding(c,s,site,name,extra={}){
    const siteId=extra.publicWork,self=getSnapshot()?.agents.find(a=>a.id===c.id);
    const prepare=!!(siteId&&SITES[siteId]&&siteId!=='warehouse'&&self);
    try{
      let spot=null;
      if(prepare)await ensureDesign(siteId,name);
      if(prepare){spot=await chooseSite(c,self,siteId);if(!spot)throw Error(`no open, level ground for the ${name} near ${site.x},${site.z}`);}
      const at=prepare?SITES[siteId]:site;
      await dispatch(c.id,{type:'blueprint',x:at.x,y:spot?spot.y:0,z:at.z,target:'',text:'',to:'',blocks:[],count:1,spec:{...siteSpec(at),...(spot?{ground:false}:{})}},s);
      Object.assign(s.project,{name,...extra,free:!!site.free});
      if(spot)await prepareProject(c,s);
    }catch(error){
      if(!siteId)throw error;
      town.attempts??={};town.attempts[siteId]=(town.attempts[siteId]??0)+1;(town.attemptAt??={})[siteId]=Date.now();
      if(extra.planStage){town.plan.attempts[extra.planStage]=(town.plan.attempts[extra.planStage]??0)+1;(town.plan.attemptAt??={})[extra.planStage]=Date.now();}
      log('build_start_failed',{agent:c.id,site:siteId,message:error.message});
      if(ready(`cannot-build:${siteId}`,600000))await say(c.id,`I can't start the ${name} yet: ${error.message}.`).catch(()=>{});
      return false;
    }
    ledger(c.id,`started building the ${name}`);await say(c.id,`Starting the ${name}!`);
    return true;
  }
  // ---------- requests: a player asks for a building ----------
  const SITE_WORDS={town_hall:/town ?hall/,market_hall:/market ?hall/,library:/library/,forge:/\bforge\b|smithy/,watchtower:/watch ?tower|\btower\b/,
    well:/\b(a|the) well\b/,mayor_house:/mayor'?s? house|house for (the )?mayor/};
  const siteName=id=>SITES[id]?.name??MILESTONES.find(m=>m.id===id)?.name.toLowerCase()??id.replace(/_/g,' ');
  /** Puts a building at the front of the builder's queue (and gives it a fresh set of tries). */
  async function requestBuild(siteId,by){
    const builder=byRole('builder');
    if(town.built[siteId]){if(builder)await say(builder.id,`@${by}: the ${siteName(siteId)} is already built.`).catch(()=>{});return 'built';}
    town.requests=[siteId,...(town.requests??[]).filter(x=>x!==siteId)];
    if(town.attempts)delete town.attempts[siteId];if(town.attemptAt)delete town.attemptAt[siteId];
    for(const k of Object.keys(town.plan.attempts??{}))if(k==='site:'+siteId)delete town.plan.attempts[k];
    log('build_requested',{site:siteId,by});ledger(builder?.id??'town',`${by} asked for the ${siteName(siteId)}; it is next in the building queue`);
    if(builder)await say(builder.id,`@${by}: understood - the ${siteName(siteId)} is next. I'll find level ground and clear it first.`).catch(()=>{});
    return 'queued';
  }
  /** A player's chat line asking for a building ("please build a town hall"). */
  function onPlayerChat(player,text){
    const t=String(text).toLowerCase();
    if(!/\b(build|construct|raise|erect|put up|make us|make a|make the)\b/.test(t))return false;
    const site=Object.keys(SITE_WORDS).find(k=>SITE_WORDS[k].test(t)&&SITES[k]);
    if(!site)return false;
    requestBuild(site,player).catch(error=>log('request_error',{message:error.message}));
    return true;
  }
  // ---------- farm plots (made by players for the villagers) ----------
  const plotClaims=new Map();
  /** Finds farmland in town, groups it into plots and adopts the crops (so tending harvests and replants them). */
  async function scanFarms(agent){
    const r=await act(agent,{type:'farmscan',x:SQUARE.x,y:0,z:SQUARE.z,radius:64}).catch(error=>{log('farm_scan_error',{message:error.message});return null;});
    if(!r?.cells)return null;
    const ignore=new Set(town.farmIgnore??[]);
    const plots=farmPlots(r.cells.filter(c=>!ignore.has(`${c[0]},${c[2]}`)));
    const adopt=r.cells.filter(c=>!c[4]&&!ignore.has(`${c[0]},${c[2]}`)).map(c=>[c[0],c[2]]);
    let adopted=0;
    for(let i=0;i<adopt.length;i+=400)adopted+=(await act(agent,{type:'adoptfarm',x:0,y:0,z:0,cells:adopt.slice(i,i+400)}).catch(()=>null))?.adopted??0;
    const last=new Map((town.farmPlots??[]).flatMap(p=>p.tiles.map(t=>[`${t.x1},${t.z1}`,t.last??0])));
    const before=(town.farmPlots??[]).length;
    town.farmPlots=plots.map(({cellList,...p})=>({...p,tiles:p.tiles.map(t=>({...t,last:last.get(`${t.x1},${t.z1}`)??0}))}));
    if(adopted||town.farmPlots.length!==before)log('farm_plots',{plots:town.farmPlots.length,cells:plots.reduce((n,p)=>n+p.cells,0),adopted});
    return {plots:town.farmPlots,cells:plots.flatMap(p=>p.cellList)};
  }
  /** Tending a farm plot tile: the farmer every 4 minutes per tile, a free citizen helps when one is 15 minutes overdue. */
  function plotJob(c,s,self,{night=false,free=false}={}){
    if(night||!town.farmPlots?.length)return null;
    const role=roleOf(c),due=role==='farmer'?240000:900000;
    if(role!=='farmer'&&(!free||role==='guardian'))return null;
    const now=Date.now(),key=t=>`${t.x1},${t.z1}`;
    const pick=town.farmPlots.flatMap(p=>p.tiles).filter(t=>now-(t.last??0)>due&&!(plotClaims.get(key(t))?.id!==c.id&&(plotClaims.get(key(t))?.until??0)>now))
      .sort((a,b)=>(a.last??0)-(b.last??0)||Math.hypot(a.cx-self.x,a.cz-self.z)-Math.hypot(b.cx-self.x,b.cz-self.z))[0];
    if(!pick)return null;
    plotClaims.set(key(pick),{id:c.id,until:now+180000});
    return async()=>{
      if(Math.hypot(self.x-(pick.cx+0.5),self.z-(pick.cz+0.5))>3){if(!self.pathing)await travel(c.id,self,{x:pick.cx+0.5,y:pick.y+1,z:pick.cz+0.5}).catch(()=>{});return;}
      pick.last=Date.now();
      const r=await act(c.id,{type:'tend',x:pick.cx,y:Math.floor(self.y),z:pick.cz,width:pick.w,depth:pick.d,target:pick.seed}).catch(error=>{log('farm_error',{agent:c.id,plot:key(pick),message:error.message});return null;});
      plotClaims.delete(key(pick));
      if(r&&(r.harvested||r.planted||r.tilled)){
        award(c.id,'tend');if(r.harvested){town.today.harvested+=r.harvested;award(c.id,'harvest',r.harvested);}
        log('plot_tended',{agent:c.id,plot:key(pick),crop:pick.crop,tilled:r.tilled,planted:r.planted,harvested:r.harvested});
        if(r.harvested)ledger(c.id,`harvested ${r.harvested} ${pick.crop.toLowerCase()} on the farm plot at ${pick.x1},${pick.z1}`);
      }
    };
  }
  const plotAt=(x,z)=>(town.farmPlots??[]).find(p=>x>=p.x1-1&&x<=p.x2+1&&z>=p.z1-1&&z<=p.z2+1);
  // Columns of every road: bridge railings never block a junction.
  const ROAD_COLS=new Set(ROADS.flatMap(r=>roadColumns(r.a,r.b,r.width).map(p=>`${p.x},${p.z}`)));
  // Upgrade saved road jobs as well as newly planned roads; retain all surface/bridge work.
  for(const p of [...Object.values(memory.data.agents??{}).map(s=>s.project),...(town.parkedProjects??[])]){
    if(!p||!(p.road||/^road:/.test(p.name??'')||ROADS.some(r=>r.name===p.name)))continue;
    const before=p.queue?.length??0;p.queue=(p.queue??[]).filter(b=>b.block!=='LANTERN');
    if(p.expected)p.expected=p.expected.filter(b=>b.block!=='LANTERN');
    p.total=Math.max(p.placed??0,(p.total??before)-(before-p.queue.length));
  }

  async function roadProject(c,s,road,planStage,{bridgeOnly=false,fix=null}={}){
    const cols=roadColumns(road.a,road.b,road.width),lamps=lanternSpots(road.a,road.b,road.width);
    // One block of margin all round: bridge railings sit just outside the road.
    const all=[...cols,...lamps],minX=Math.min(...all.map(p=>p.x))-1,minZ=Math.min(...all.map(p=>p.z))-1,maxX=Math.max(...all.map(p=>p.x))+1,maxZ=Math.max(...all.map(p=>p.z))+1;
    const heights=new Map(),water=new Set();
    for(let x=minX;x<=maxX;x+=16)for(let z=minZ;z<=maxZ;z+=16){
      const r=await act(c.id,{type:'survey',x,y:0,z,width:Math.min(16,maxX-x+1),depth:Math.min(16,maxZ-z+1)}).catch(()=>null);
      r?.heights?.forEach((h,i)=>{const k=`${x+i%r.width},${z+Math.floor(i/r.width)}`;if(h!==null)heights.set(k,h);if(r.liquid?.[i])water.add(k);});
    }
    // Over water the road becomes a raised plank bridge with railings (built from the bank); no lanterns on the water.
    const own=new Set(cols.map(p=>`${p.x},${p.z}`)),avoid=new Set([...ROAD_COLS].filter(k=>!own.has(k)));
    const bridge=bridgePlan(road,heights,water,avoid),wet=k=>water.has(k)||bridge.deck.has(k);
    // Every road block says where to stand: the nearest other dry road column (never out over the water).
    const dry=cols.filter(p=>heights.has(`${p.x},${p.z}`)&&!wet(`${p.x},${p.z}`));
    const standFor=p=>{const q=dry.filter(o=>o!==p).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];return q&&{x:q.x+0.5,y:heights.get(`${q.x},${q.z}`)+1,z:q.z+0.5};};
    const land=bridgeOnly?[]:[...dry.map(p=>({x:p.x,y:heights.get(`${p.x},${p.z}`),z:p.z,block:road.block,stand:standFor(p)})),
      // Street lighting is handled by spaced, supported lamp posts.
      ...[]];
    const blocks=[...land,...bridge.blocks];
    if(!blocks.length)throw Error(bridgeOnly?'No bridge needed':'Road survey failed');
    s.project=fix?{...newProject(`bridge on the ${road.name}`,blocks.sort((a,b)=>a.y-b.y)),bridgeFix:fix}
      :planStage?{...newProject(road.name,blocks.sort((a,b)=>a.y-b.y)),planStage}:{...newProject(`road: ${road.name}`,blocks.sort((a,b)=>a.y-b.y)),road:road.name};
    ledger(c.id,`started the road: ${road.name}`);log('project_started',{agent:c.id,name:s.project.name,blocks:blocks.length});
  }
  /** Builder's next job when idle in daylight: warehouse, homes, roads, then unlocked public buildings. */
  const LARGE_CHESTS=[{label:'Food Storage',x:286,z:106,facing:'SOUTH'},{label:'Supplies & Tools',x:285,z:108,facing:'NORTH'}];
  /** Two large, labelled chests in the middle of the warehouse (a town upgrade, so the chests are free). */
  async function largeChestJob(c,self){
    if(!(await goToWarehouse(c.id,self)))return true;
    const y=town.warehouseFloor??70;
    for(const chest of LARGE_CHESTS.filter(ch=>!(town.largeChests??[]).includes(ch.label))){
      const spots=[[chest.x,chest.z],[chest.x+1,chest.z],[chest.x-1,chest.z]];
      let done=false;
      for(const [x,z] of spots){
        if(await act(c.id,{type:'largechest',x,y,z,target:chest.facing,text:chest.label,free:true}).then(()=>true).catch(e=>{log('chest_error',{label:chest.label,x,z,message:e.message});return false;})){done=true;break;}
      }
      town.largeChestTries??={};
      if(done||(town.largeChestTries[chest.label]=(town.largeChestTries[chest.label]??0)+1)>=3)(town.largeChests??=[]).push(chest.label);
      if(done)ledger(c.id,`added a large "${chest.label}" chest to the warehouse`);
    }
    if((town.largeChests?.length??0)>=LARGE_CHESTS.length)await say(c.id,'The warehouse has two big new chests: one for food, one for supplies and tools.');
    refreshStock();
    return true;
  }
  // ---------- master plans (funded by the town council) ----------
  const CENTER={x:272.5,z:96.5};
  /** One quarter of the perimeter wall: cobblestone topped with a stone-brick wall, lanterns on top, gates left open. */
  async function wallProject(c,s,stage){
    const radius=(town.area?.radius??48)-3,cols=wallColumns(CENTER,radius,stage.arc);
    const minX=Math.min(...cols.map(p=>p.x)),maxX=Math.max(...cols.map(p=>p.x)),minZ=Math.min(...cols.map(p=>p.z)),maxZ=Math.max(...cols.map(p=>p.z));
    const heights=new Map(),water=new Set();
    for(let x=minX;x<=maxX;x+=16)for(let z=minZ;z<=maxZ;z+=16){
      const r=await act(c.id,{type:'survey',x,y:0,z,width:Math.min(16,maxX-x+1),depth:Math.min(16,maxZ-z+1)}).catch(()=>null);
      r?.heights?.forEach((h,i)=>{const k=`${x+i%r.width},${z+Math.floor(i/r.width)}`;if(h!==null)heights.set(k,h);if(r.liquid?.[i])water.add(k);});
    }
    const ground=cols.map(p=>heights.get(`${p.x},${p.z}`)).filter(Number.isFinite).sort((a,b)=>a-b),median=ground[Math.floor(ground.length/2)];
    // Skip water and columns much higher than the ground around them (buildings, trees): the wall goes around them.
    const ok=p=>{const k=`${p.x},${p.z}`,h=heights.get(k);return Number.isFinite(h)&&!water.has(k)&&h<=median+3;};
    const blocks=cols.filter(ok).flatMap(p=>{const h=heights.get(`${p.x},${p.z}`);return [{x:p.x,y:h+1,z:p.z,block:'COBBLESTONE'},{x:p.x,y:h+2,z:p.z,block:'STONE_BRICK_WALL'},...(p.lamp?[{x:p.x,y:h+3,z:p.z,block:'LANTERN'}]:[])];});
    if(!blocks.length)throw Error('Wall survey failed');
    s.project={...newProject(stage.name,blocks.sort((a,b)=>a.y-b.y)),planStage:stage.id};
    ledger(c.id,`started the ${stage.name} (${blocks.length} blocks)`);log('project_started',{agent:c.id,name:stage.name,blocks:blocks.length});
  }
  /** Build the next council-funded plan stage. */
  async function planWork(c,s){
    // Buildings the council funded come before walls and walkways.
    const isBuilding=x=>x.startsWith('site:')||!!stageOf(x)?.stage.site;
    const id=town.plan.funded.filter(x=>!town.plan.done.includes(x)&&canTry(town.plan.attempts,town.plan.attemptAt,x)).sort((a,b)=>isBuilding(b)-isBuilding(a))[0];if(!id)return false;
    if(id.startsWith('site:')){
      const site=id.slice(5);
      if(town.built[site]||!SITES[site]){town.plan.done.push(id);return false;}
      return await startBuilding(c,s,SITES[site],MILESTONES.find(m=>m.id===site)?.name.toLowerCase()??site.replace(/_/g,' '),{publicWork:site,planStage:id});
    }
    const found=stageOf(id);if(!found){town.plan.funded=town.plan.funded.filter(x=>x!==id);return false;}
    const {plan,stage}=found;
    try{
      if(plan.kind==='wall')await wallProject(c,s,stage);
      else if(plan.kind==='roads')await roadProject(c,s,{...stage.road,name:stage.name},stage.id);
      else if(stage.site){
        if(town.built[stage.site]){town.plan.done.push(id);return false;}
        if(!await startBuilding(c,s,SITES[stage.site],stage.name,{publicWork:stage.site,planStage:id}))return false;
      }
      await say(c.id,`The council funded the ${stage.name} - starting now!`);
      return true;
    }catch(error){town.plan.attempts[id]=(town.plan.attempts[id]??0)+1;log('plan_error',{stage:id,message:error.message});return false;}
  }
  async function builderWork(c,s,nextHome){
    // Finish one construction job before opening another, including projects paused for supplies.
    const recovering=(town.priorityBuilds??[]).some(k=>k.startsWith('complete:'));
    if(!recovering)for(const p of town.parkedProjects??[])if(p.afterRecovery){delete p.afterRecovery;p.nextCheck=Date.now();}
    if((town.parkedProjects??[]).some(p=>!p.afterRecovery)){d.construction?.()?.resumeParked(c,s);return true;}
    // One-time: two library plans were parked side by side (591 and 706 blocks, from a design change); the newer
    // duplicate is dropped - the 591-block one is nearly done.
    if(!town.libraryDedupV1){town.libraryDedupV1=true;const before=(town.parkedProjects??[]).length;
      town.parkedProjects=(town.parkedProjects??[]).filter(x=>!(x.project?.publicWork==='library'&&x.project.total===706));
      if((town.parkedProjects??[]).length<before)log('parked_dropped',{project:'library (706-block duplicate)',why:'duplicate plan'});}
    // A parked project whose materials are now all here (in stock or in his pack - the mayor brought them, the crafter
    // made them, the courier never came) is taken up again before anything new (the forge sat parked with its anvil
    // handed over; the bakery and jail sat "waiting for the courier" with every block in the warehouse).
    {const self=getSnapshot()?.agents.find(a=>a.id===c.id),inv=self?.inventory??{};
      // (something really was missing and is in now - not an empty list, e.g. 'the courier is bringing it' - and not
      // re-tried within 10 minutes: the tavern and a blocked repair were resumed and parked again every few seconds)
      const ready=(town.parkedProjects??[]).find(x=>x.builder===c.id&&x.project?.blocker?.kind==='materials'&&Date.now()-(x.readyAt??0)>600000
        &&Object.keys(x.project.blocker.missing??{}).length>0
        &&Object.entries(x.project.blocker.missing??{}).every(([k,n])=>(town.stock.items[k]??0)+(inv[k]??0)>=n));
      if(ready){ready.readyAt=Date.now();ready.nextCheck=Date.now();if(d.construction?.()?.resumeParked(c,s)){log('project_ready',{agent:c.id,project:s.project?.name,why:'its materials are here'});return true;}}
      // A pack cluttered with leftovers (36 kinds is full - a new kind handed to him would not fit): everything the
      // parked projects do not need goes to the warehouse between projects.
      const kinds=Object.entries(inv).filter(([,n])=>n>0);
      if(kinds.length>20&&ready===undefined&&Date.now()-(s.declutterAt??0)>600000){
        const want=new Set(['DIRT','COBBLESTONE']);for(const x of town.parkedProjects??[])for(const b of [...(x.project?.queue??[]),...(x.project?.deferred??[])])if(b.block)want.add(b.block);
        const keep=k=>want.has(k)||/_PICKAXE$|_AXE$|_SHOVEL$|_HOE$|_SWORD$|^SHEARS$/.test(k)||FOODS.includes(k);
        const drop=kinds.filter(([k])=>!keep(k));
        if(drop.length){if(!await goToWarehouse(c.id,self))return true;s.declutterAt=Date.now();
          let n=0;for(const [k,v] of drop){const put=await deposit(c.id,k,v).catch(()=>0);n+=put;}
          log('builder_declutter',{agent:c.id,kinds:drop.length,items:n});return true;}
      }
    }
    // What the mayor asked for first comes before resuming parked projects (a parked library kept coming due,
    // pausing again within seconds, and the jail, courthouse, bakery and infirmary never got a turn).
    if((town.priorityBuilds??[]).length){await priorityWork(c,s);return true;}
    if(d.construction?.()?.resumeParked(c,s))return true;
    if(town.built.warehouse&&(town.largeChests?.length??0)<LARGE_CHESTS.length){await largeChestJob(c,getSnapshot()?.agents.find(a=>a.id===c.id));return true;}
    if(!town.built.warehouse&&(town.attempts?.warehouse??0)<3){await startBuilding(c,s,SITES.warehouse,'warehouse',{publicWork:'warehouse'});return true;}
    // One-time: the old rule gave up on a building for good after 3 failures; give everything a fresh start.
    if(!town.buildRetryV1){town.buildRetryV1=true;town.attempts={};town.attemptAt={};town.plan.attempts={};town.plan.attemptAt={};log('build_retry_reset',{});}
    // Again after site selection learned to terraform and to look beyond the zones.
    if(!town.buildRetryV2){town.buildRetryV2=true;town.attempts={};town.attemptAt={};town.plan.attempts={};town.plan.attemptAt={};log('build_retry_reset',{version:2});}
    // What the mayor asked for to be done first (town.priorityBuilds): "finish:<site>" completes a building in place,
    // a plain site id is built as usual. Then a home for every citizen who has none (then other requests).
    if(await priorityWork(c,s))return true;
    if(await nextHome(c,s))return true;
    const asked=(town.requests??[]).find(id=>!town.built[id]&&SITES[id]&&canTry(town.attempts,town.attemptAt,id));
    if(asked){if(await startBuilding(c,s,SITES[asked],siteName(asked),{publicWork:asked,requested:true}))return true;}
    town.requests=(town.requests??[]).filter(id=>!town.built[id]);
    if(town.repairs?.length){
      const blocks=town.repairs.splice(0,32).map(b=>({...b}));
      s.project={...newProject('repairs',blocks),free:false};ledger(c.id,`is repairing ${blocks.length} damaged blocks`);return true;
    }
    if(await city.work(c,s))return true;
    // Rebuild bridges that were laid at water level (a trench nobody could climb out of).
    // v2: the first pass left the railings unfinished; add them (and bridge the town hall lane the same way).
    if(!town.bridgeFixV2){town.bridgeFixV2=true;town.bridgeFix=['north road'];town.bridgeFixTries={};town.roadRedo=['town hall lane','watchtower lane'];}
    // v3: railings on the north bridge (the survey now reaches the water beside it); the town hall lane again.
    if(!town.bridgeFixV5){town.bridgeFixV5=true;town.bridgeFixV4=true;town.bridgeFixV3=true;town.bridgeFix=['north road'];town.bridgeFixTries={};if(!(town.roadRedo??[]).includes('watchtower lane'))(town.roadRedo??=[]).push('watchtower lane');}
    if(!town.bridgeFixV3){town.bridgeFixV3=true;town.bridgeFix=['north road'];town.bridgeFixTries={};if(!(town.roadRedo??[]).includes('town hall lane'))(town.roadRedo??=[]).push('town hall lane');}
    town.bridgeFix??=['north road'];
    const fixName=town.bridgeFix.find(n=>(town.bridgeFixTries?.[n]??0)<3);
    if(fixName){const road=ROADS.find(r=>r.name===fixName);
      try{await roadProject(c,s,road,null,{bridgeOnly:true,fix:fixName});ledger(c.id,`is rebuilding the bridge on the ${fixName} with railings`);await say(c.id,`I'm raising the bridge on the ${fixName} and giving it railings, so nobody ends up in the lake again.`);return true;}
      catch(error){town.bridgeFix=town.bridgeFix.filter(n=>n!==fixName);log('bridge_fix',{road:fixName,message:error.message});}}
    // Roads abandoned earlier (they crossed the lake before bridges worked): build them again once.
    const redo=(town.roadRedo??[])[0];
    if(redo){town.roadRedo.shift();const road=ROADS.find(r=>r.name===redo);if(road){try{await roadProject(c,s,road,null,{fix:`redo:${redo}`});s.project.name=`road: ${redo}`;return true;}catch(error){log('road_redo',{road:redo,message:error.message});}}}
    if(await nextHome(c,s))return true;
    if(town.mayor&&!town.built.mayor_house&&canTry(town.attempts,town.attemptAt,'mayor_house')&&await startBuilding(c,s,SITES.mayor_house,`house for Mayor ${town.mayor}`,{publicWork:'mayor_house'}))return true;
    // Projects the council voted for come before the standing road and building queue.
    if(await planWork(c,s))return true;
    if(town.roadsDone<ROADS.length){await roadProject(c,s,ROADS[town.roadsDone]);return true;}
    const next=town.unlocked.find(id=>!town.built[id]&&SITES[id]&&canTry(town.attempts,town.attemptAt,id));
    if(next&&await startBuilding(c,s,SITES[next],MILESTONES.find(m=>m.id===next)?.name.toLowerCase()??next,{publicWork:next}))return true;
    return false;
  }
  /**
   * Taking down a mistaken build. "fisher-upper": the second storey Bram raised on the fisher's roof from a plan that
   * read the roof as the ground (a whole house at y75). Its blocks that are not part of the fisher's own house come
   * down (plugin "demolish": only blocks the citizens placed), then any gap in the fisher's oak roof is patched.
   */
  async function demolishWork(c,what,now=false){
    // "roof:<lotX>,<lotZ>,<upperY>,<lowerY>,<door>": a house planned on the roof of the home already on its lot - its
    // blocks that are not part of the real house come down; the real roof is patched afterwards.
    if(what.startsWith('roof:')){
      const [lx,lz,uy,ly,door]=what.slice(5).split(',');const X=+lx,Z=+lz;
      const spec={shape:'house',width:5,depth:5,height:3,door,bed:true,chest:true,windows:true};
      const key=b=>`${b.x},${b.y},${b.z}`,lower=blueprint(spec,X,+ly,Z),own=new Set(lower.map(key));
      const upper=blueprint(spec,X,+uy,Z).filter(b=>!own.has(key(b))).sort((a,b)=>b.y-a.y);
      const r=await act(c.id,{type:'demolish',x:0,y:0,z:0,blocks:upper.map(b=>[b.x,b.y,b.z])});
      log('demolished',{agent:c.id,what,removed:r?.removed,items:r?.items});
      const lotRoof=Object.values({...(memory.data.village?.extraHomes??{})}).find(l=>l.x===X&&l.z===Z)?.roof??'SPRUCE_PLANKS';
      for(const b of lower.filter(b=>b.y>=+ly+4))requestFurnish({x:b.x,y:b.y,z:b.z,block:lotRoof,for:`roof patch ${X},${Z}`,quiet:true});
      ledger(c.id,`took down the house he had started on the roof of the home at ${X},${Z} (${r?.removed??0} blocks)`);
      return 'done';
    }
    if(/^abandoned/.test(what)){   // abandoned, abandoned2 (the early town hall and pavilion frames north of the forge)
      // Abandoned attempts at buildings later built elsewhere (old mayor's-house, shrine, town hall, forge, library sites;
      // homes started on roofs): their citizen-placed blocks come down, minus anything belonging to a current building
      // (tools/build-audit.mjs made the list), and the materials go to the builder.
      const list=JSON.parse(await (await import('node:fs/promises')).readFile(new URL(`../config/${what}-demolish.json`,import.meta.url),'utf8'));
      const blocks=list.sort((a,b)=>b[1]-a[1]);
      let removed=0;const items={};
      for(let i=0;i<blocks.length;i+=400){const r=await act(c.id,{type:'demolish',x:0,y:0,z:0,blocks:blocks.slice(i,i+400)});removed+=r?.removed??0;for(const [k,n] of Object.entries(r?.items??{}))items[k]=(items[k]??0)+n;}
      log('demolished',{agent:c.id,what,removed,of:blocks.length,items});
      ledger(c.id,`cleared away ${removed} blocks of old, abandoned building attempts around town and kept the materials`);
      await say(c.id,"I've cleared away the half-built leftovers from old building sites - the bricks and planks go into the real buildings.").catch(()=>{});
      return 'done';
    }
    if(what==='library-b'){
      // The second, half-built library at 290,67,174 (a duplicate plan): its blocks come down and their materials go
      // to the builder for the town's other buildings; the levelled ground stays. The block list was saved from its plan.
      const list=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/library-b-demolish.json',import.meta.url),'utf8'));
      const blocks=list.sort((a,b)=>b[1]-a[1]).map(([x,y,z])=>[x,y,z]);
      let removed=0;const items={};
      for(let i=0;i<blocks.length;i+=400){const r=await act(c.id,{type:'demolish',x:0,y:0,z:0,blocks:blocks.slice(i,i+400)});removed+=r?.removed??0;for(const [k,n] of Object.entries(r?.items??{}))items[k]=(items[k]??0)+n;}
      log('demolished',{agent:c.id,what,removed,items});
      ledger(c.id,`took down the second, half-built library (${removed} blocks) and kept its materials for the town's other buildings`);
      await say(c.id,"Two libraries was one too many - I've taken the unfinished one down and kept its bricks and planks for the courthouse, bakery and infirmary.").catch(()=>{});
      return 'done';
    }
    if(what!=='fisher-upper')return 'skip';
    const self=getSnapshot()?.agents.find(a=>a.id===c.id);if(!self)return 'walking';
    const spec={shape:'house',width:5,depth:5,height:3,door:'east',bed:true,chest:true,windows:true};
    const lower=blueprint(spec,294,69,107),key=b=>`${b.x},${b.y},${b.z}`,own=new Set(lower.map(key));
    const upper=blueprint(spec,294,75,107).filter(b=>!own.has(key(b))).sort((a,b)=>b.y-a.y);
    const spot={x:300.5,z:109.5};   // the street in front of the fisher's door
    if(!now&&Math.hypot(self.x-spot.x,self.z-spot.z)>4){if(!self.pathing)await travel(c.id,self,{x:spot.x,y:70,z:spot.z}).catch(()=>{});return 'walking';}
    const r=await act(c.id,{type:'demolish',x:0,y:0,z:0,blocks:upper.map(b=>[b.x,b.y,b.z])});
    log('demolished',{agent:c.id,what,removed:r?.removed,skipped:r?.skipped,items:r?.items});
    ledger(c.id,`took down the second storey he had built by mistake on the fisher's roof (${r?.removed??0} blocks)`);
    await say(c.id,"That second storey on the fisher's house was my mistake - it's coming down, and I'll patch the roof.").catch(()=>{});
    for(const b of lower.filter(b=>b.y>=73))requestFurnish({x:b.x,y:b.y,z:b.z,block:'OAK_PLANKS',for:'fisher roof',quiet:true});
    return 'done';
  }
  /**
   * Completing a building that stands with gaps (missing walls, roof, furnishings): its plan (config/complete-plans.json,
   * from tools/build-audit.mjs) is compared with the world and only EMPTY spots are filled - nothing standing is ever
   * cleared or replaced, so a building someone changed keeps its changes.
   */
  const completeNames=[];(async()=>{try{for(const p of JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/complete-plans.json',import.meta.url),'utf8')))completeNames.push(p.name);}catch{}})();
  function installCompletionDefinition(site,definition){
    if(!definition)return;
    SITES[site]={...definition};town.sites[site]={...definition};
    (town.city??={}).recoveredSites??={};town.city.recoveredSites[site]={...definition};
    delete (town.signsPosted??{})[site];delete (town.entrances??{})[site];
    town.damage.furnish=(town.damage.furnish??[]).filter(f=>![`sign:${site}`,`door:${site}`,`bars:${site}`].includes(f.for));
    if(site==='jail')town.jailBarsV1=true;
  }
  async function completePlan(c,s,i){
    const plans=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/complete-plans.json',import.meta.url),'utf8'));
    const p=plans[i];if(!p)return false;
    if(p.renovation&&(town.justice?.jail??[]).some(r=>!r.cell?.facility||r.cell.facility==='jail')){(town.priorityBuilds??=[]).push('complete:'+i);return false;}
    const blocks=p.blocks??blueprint(p.spec,p.x,p.y,p.z),xs=blocks.map(b=>b.x),zs=blocks.map(b=>b.z),ys=blocks.map(b=>b.y);
    const bodyBox={x1:Math.min(...xs),x2:Math.max(...xs),z1:Math.min(...zs),z2:Math.max(...zs),y1:Math.min(...ys),y2:Math.max(...ys)},box=p.cleanupBounds?{x1:Math.min(bodyBox.x1,p.cleanupBounds.x1),x2:Math.max(bodyBox.x2,p.cleanupBounds.x2),z1:Math.min(bodyBox.z1,p.cleanupBounds.z1),z2:Math.max(bodyBox.z2,p.cleanupBounds.z2),y1:Math.min(bodyBox.y1,p.cleanupBounds.y1),y2:Math.max(bodyBox.y2,p.cleanupBounds.y2)}:bodyBox;
    const cells=new Map(),scanned=[];
    for(const page of scanPages(p.renovation?{...box,y1:p.y-13}:box)){
      const r=await act(c.id,{type:'scan',...page}).catch(()=>null);
      if(!r){(town.priorityBuilds??=[]).push('complete:'+i);return false;}
      scanned.push(...(r.cells??[]));
      for(const [x,y,z,type] of r.cells??[])cells.set(`${x},${y},${z}`,type);
    }
    const restoration=p.renovation?renovationPlan(blocks,scanned,box):restorationPlan(blocks,scanned);
    if(p.renovation){const terrain=planTerrain3D(scanned,bodyBox,p.y-1,p.y-1,{ring:0});if(terrain.unsupported){(town.priorityBuilds??=[]).push('complete:'+i);log('renovation_unsupported',{site:p.site,count:terrain.unsupported});return false;}restoration.queue.push(...terrain.fill);restoration.expected.push(...terrain.fill);}
    const places=restoration.queue;
    if(p.renovation&&(town.justice?.jail??[]).some(r=>!r.cell?.facility||r.cell.facility==='jail')){(town.priorityBuilds??=[]).push('complete:'+i);return false;}
    if(!places.length){(town.completionInspections??={})[i]={at:Date.now(),missing:0,verified:true};if(p.site){installCompletionDefinition(p.site,p.definition);town.built[p.site]=true;(town.finishedSites??={})[p.site]=Date.now();}log('complete_done',{what:p.name,why:'nothing missing'});return false;}
    s.project={...newProject(`completing the ${p.name}`,places.sort((a,b)=>a.y-b.y)),completing:p.name,completionPlan:i,completionSite:p.site,homeFor:p.homeFor,renovation:!!p.renovation,completionDefinition:p.definition};
    s.project.expected=restoration.expected;
    s.project.baseY=p.y;
    if(p.renovation&&p.site)town.built[p.site]=false;
    log('complete_started',{agent:c.id,what:p.name,missing:places.length,of:blocks.length});
    ledger(c.id,`is completing the ${p.name} (${places.length} missing blocks: walls, roof and fittings)`);
    await say(c.id,`Next I'm completing the ${p.name} - ${places.length} blocks missing from its walls and roof.`).catch(()=>{});
    return true;
  }
  // ---------- what each unfinished building is waiting for (dashboard "Building needs"; Bram tells the mayor) ----------
  const label2=k=>String(k).toLowerCase().replace(/_/g,' ');
  function buildNeedsTick(){
    const b=byRole('builder');if(!b)return;
    const active=stateOf(b.id)?.project,list=[];
    const add=(p,status)=>{if(!p||p.name==='repairs')return;
      // What it still waits for, against the stock now (a parked project's own list is from when it was parked).
      const now0=getSnapshot()?.agents.find(x=>x.id===b.id)?.inventory??{};
      const missing=Object.fromEntries(Object.entries(p.materials?.missing??p.blocker?.missing??{}).map(([k,n])=>[k,n-(town.stock.items[k]??0)-(now0[k]??0)]).filter(([,n])=>n>0));
      const waitingForMaterials=Object.keys(missing).length>0&&(p.waiting||p.blocker?.kind==='materials'||status==='parked');
      // The whole bill of materials still to place (the queue and what was set aside to retry), with what the warehouse holds.
      const remaining={};for(const blk of [...(p.queue??[]),...(p.deferred??[])])if(!blk.clear&&blk.block&&blk.block!=='CLEAR'){const k=blk.block==='REDSTONE_WIRE'?'REDSTONE':blk.block;remaining[k]=(remaining[k]??0)+1;}
      // In stock = the warehouse plus what the builder carries now (the live snapshot: gifts show at once).
      const carried=getSnapshot()?.agents.find(x=>x.id===b.id)?.inventory??{};
      const have=Object.fromEntries(Object.keys(remaining).map(k=>[k,(town.stock.items[k]??0)+(carried[k]??0)]));
      list.push({name:p.name,placed:p.placed??0,total:p.total??0,status,remaining,have,missing:waitingForMaterials?missing:{},assigned:p.materials?.assigned??null,
        blocker:p.blocker?.text??null,blockerKind:p.blocker?.kind??null,since:p.blocker?.since??null});};
    if(active)add(active,active.waiting?'waiting':'building');
    for(const x of town.parkedProjects??[])add(x.project,'parked');
    town.buildNeeds=list;
    // A project stays owned by Bram until its full inspection passes; blocked work is retained and retried.
    // Set-asides for projects that are no longer under way (finished, cancelled) are released for the others.
    const live=new Set([...(active?[`${b.id}:${active.name}`]:[]),...(town.parkedProjects??[]).map(x=>`${x.builder}:${x.project.name}`)]);
    for(const k of Object.keys(town.reservations?.list??{}))if(!live.has(k)){reservations.close(k);log('reservation_released',{key:k});}
    // Tell the mayor: once when a building starts waiting for materials (or the list changes), again every 30 min while
    // it waits, and when it has them. A building is never left waiting in silence.
    const told=town.needsTold??={},mayor=town.mayor??getSnapshot()?.players?.[0]?.name??null;
    for(const n of list){
      const items=Object.entries(n.missing).sort((a,b)=>b[1]-a[1]);
      const sig=items.map(([k,v])=>k+':'+v).join(',');
      if(items.length){
        const t=told[n.name];
        if(!t||t.sig!==sig&&Date.now()-t.at>120000||Date.now()-t.at>1800000){
          told[n.name]={sig,at:Date.now()};
          const what=items.slice(0,6).map(([k,v])=>`${v} ${label2(k)}`).join(', ')+(items.length>6?` and ${items.length-6} more`:'');
          const who=n.assigned&&Object.keys(n.assigned).filter(r=>['crafter','miner','courier'].includes(r)).length?' The others are on it, but anything you can spare helps.':'';
          say(b.id,`${mayor?'@'+mayor+' ':''}The ${n.name.replace(/^finishing |^completing /,'')} is waiting for: ${what}. Put them in the warehouse drop box and I'll carry on.${who}`.slice(0,250)).catch(()=>{});
          log('build_needs_told',{project:n.name,missing:n.missing});
        }
      }else if(told[n.name]&&n.status!=='parked'){
        delete told[n.name];
        say(b.id,`The ${n.name.replace(/^finishing |^completing /,'')} has what it needs again - back to building.`).catch(()=>{});
      }
    }
    for(const k of Object.keys(told))if(!list.some(n=>n.name===k))delete told[k];
  }
  setInterval(()=>{try{buildNeedsTick();}catch(error){log('needs_error',{message:error.message});}},30000).unref?.();
  async function priorityWork(c,s){
    const list=town.priorityBuilds??=[];
    let remaining=list.length;while(list.length&&remaining-->0){
      const pri=list[0];
      log('priority_step',{agent:c.id,item:pri,rest:list.slice(1)});
      if(pri.startsWith('complete:')){
        list.shift();let ok=false;try{ok=await completePlan(c,s,Number(pri.slice(9)));}catch(error){list.push(pri);log('complete_error',{item:pri,message:error.message});}
        if(ok)return true;continue;
      }
      if(pri.startsWith('demolish:')){
        let r;try{r=await demolishWork(c,pri.slice(9));}catch(error){log('demolish_error',{what:pri,message:error.message});list.push(list.shift());return false;}
        if(r==='walking')return true;
        list.shift();if(r==='done')return true;continue;
      }
      if(pri.startsWith('finish:')){list.shift();let ok=false;try{ok=await finishBuilding(c,s,pri.slice(7));}catch(error){log('finish_error',{site:pri.slice(7),message:error.message,stack:String(error.stack??'').split(String.fromCharCode(10)).slice(1,3).join(' | ')});list.push(pri);return false;}if(ok)return true;continue;}
      if(town.built[pri]||!SITES[pri]){list.shift();continue;}
      if(!canTry(town.attempts,town.attemptAt,pri))return false;
      if(await startBuilding(c,s,SITES[pri],siteName(pri),{publicWork:pri,requested:true})){list.shift();return true;}
      return false;
    }
    return false;
  }
  /**
   * Completes a building where it stands (a half-built or damaged one marked built): the site is scanned, blocks that
   * already match the plan are left alone, anything else in a planned spot is cleared first, the rest is placed.
   * (A fresh start would pick new open ground and leave the old shell behind.)
   */
  async function finishBuilding(c,s,siteId){
    const at=town.sites?.[siteId],st=SITES[siteId];if(!at||!st){log('finish_skipped',{site:siteId,why:'no site'});return false;}
    const blocks=blueprint(siteSpec(st),at.x,at.y,at.z),xs=blocks.map(b=>b.x),zs=blocks.map(b=>b.z),ys=blocks.map(b=>b.y);
    const box={x1:Math.min(...xs),x2:Math.max(...xs),z1:Math.min(...zs),z2:Math.max(...zs),y1:Math.min(...ys),y2:Math.max(...ys)};
    const cells=new Map(),scanned=[];
    for(const page of scanPages(box)){
      const r=await act(c.id,{type:'scan',...page}).catch(error=>{log('scan_error',{agent:c.id,message:error.message});return null;});
      if(!r){log('finish_skipped',{site:siteId,why:'scan failed'});(town.priorityBuilds??=[]).unshift('finish:'+siteId);return false;}
      scanned.push(...(r.cells??[]));
      for(const [x,y,z,type] of r.cells??[])cells.set(`${x},${y},${z}`,type);
    }
    const restoration=restorationPlan(blocks,scanned);
    const places=restoration.queue,clears=[];
    if(!places.length){town.built[siteId]=true;(town.finishedSites??={})[siteId]=Date.now();log('finish_done',{site:siteId,why:'nothing missing'});return false;}
    s.project={...newProject(`finishing the ${siteName(siteId)}`,places.sort((a,b)=>a.y-b.y)),publicWork:siteId,finishing:true};
    s.project.expected=restoration.expected;
    s.project.baseY=at.y;
    (town.finishing??={})[siteId]=Date.now();
    log('finish_started',{agent:c.id,site:siteId,missing:places.length,clear:clears.length,present:blocks.length-places.length});
    ledger(c.id,`is finishing the ${siteName(siteId)} (${places.length} blocks to go)`);
    await say(c.id,`Back to the ${siteName(siteId)} - ${places.length} blocks still to place, walls and roof. I'll have it finished.`).catch(()=>{});
    return true;
  }
  // ---------- name signs over the public buildings' doors (plugin "sign"; hung by the repair crew) ----------
  function signSpots(id){
    const at=town.sites?.[id];if(!at||!town.built[id])return [];
    if(id==='town_hall')return [{x:at.x-1,y:at.y+3,z:at.z+7,facing:'WEST',text:'|TOWN||'},{x:at.x-1,y:at.y+3,z:at.z+8,facing:'WEST',text:'|HALL||'}];   // over the double door in the west wall (as built)
    if(id==='jail')return [{x:at.x+4,y:at.y+3,z:at.z+7,facing:'SOUTH',text:"|JAIL|Sheriff's Office|"}];
    if(id==='courthouse')return [{x:at.x+6,y:at.y+3,z:at.z-1,facing:'NORTH',text:'|COURT HOUSE|Hall of Justice|'}];
    return [];
  }
  function postSigns(){
    const done=town.signsPosted??={};
    // One-time: the first town hall sign was dropped by the bed-replacement rule; post both again (one is re-hung as is).
    if(!town.signFixV1){town.signFixV1=true;delete done.town_hall;}
    // One-time: the jail sign was requested on the unfinished shell (no wall to hang on, then marked unreachable).
    if(!town.signFixV2){town.signFixV2=true;delete done.jail;town.damage.furnish=(town.damage.furnish??[]).filter(f=>f.for!=='sign:jail');delete (town.damage.skip??{})['266,123'];}
    for(const id of ['town_hall','courthouse']){   // the jail's sign: postAllSigns (over its door)
      if(done[id]||!town.built[id]||(town.finishing??{})[id]||(town.priorityBuilds??[]).includes('finish:'+id))continue;
      if(id==='jail'&&!(town.finishedSites??{}).jail)continue;   // the jail was marked built as a shell: its sign waits until it is finished
      const spots=signSpots(id);if(!spots.length)continue;
      for(const p of spots)requestFurnish({...p,block:'SPRUCE_WALL_SIGN',sign:true,for:'sign:'+id,quiet:true});
      done[id]=Date.now();log('signs_requested',{site:id,signs:spots.length});
    }
  }
  // ---------- a name sign on every building and every home (found by scanning the outside walls) ----------
  // The hand-placed signs above cover the hall, the jail and the courthouse; everything else gets one on the wall that
  // faces the town square, at about head height (3 above the floor), hung by the repair crew like the others.
  const SIGN_TEXT={warehouse:['WAREHOUSE','Jasper, Clerk'],market_hall:["MARLO'S MARKET",'Market Hall'],watchtower:['WATCHTOWER',''],shrine:['SHRINE',''],
    mayor_house:["MAYOR'S HOUSE",''],forge:['FORGE','Smithy'],tavern:['TAVERN',''],bank:['BANK',''],library:['LIBRARY',''],infirmary:['INFIRMARY','Healer'],
    bakery:["ANTOINE'S",'BAKERY'],well:['WELL',''],jail:['JAIL',"Sheriff's Office"],
    herb_shed:["ROSA'S",'HERB SHED'],carpenter:["TINK'S",'CARPENTRY'],fishmonger:["FINLEY'S",'FISHMONGER']};
  /** The building's walls as planned: the footprint of its blocks 1-3 above the floor (no roof overhang). */
  function wallBox(id,at){
    const spec={...siteSpec(SITES[id]??{}),...(town.designs?.[id]?.spec??{})};
    let blocks=[];try{blocks=blueprint(spec,at.x,64,at.z).filter(b=>b.y>=65&&b.y<=67);}catch{}
    if(!blocks.length)return null;
    const f=blocksFootprint(blocks);return {x:f.x1,z:f.z1,w:f.x2-f.x1+1,d:f.z2-f.z1+1,y:at.y};
  }
  /**
   * Where the name sign goes: over the door. The outer wall is scanned for a door (or an open doorway - two free
   * blocks with floor below and wall above) and the sign hangs on the outside of the wall block right above it. Only
   * a building with no doorway found gets one on the wall facing `toward` (the first signs went there and ended up
   * over windows and on side walls).
   */
  async function signSpot(id,box,toward){
    const cells=new Map(),x0=box.x-1,z0=box.z-1,x1=box.x+box.w,z1=box.z+box.d,y0=box.y-2,H=9;
    for(let x=x0;x<=x1;x+=8)for(let z=z0;z<=z1;z+=8){
      const r=await act(id,{type:'scan',x,y:y0,z,width:Math.min(8,x1-x+1),height:H,depth:Math.min(8,z1-z+1)}).catch(()=>null);
      if(!r)return null;
      for(const [cx,cy,cz,type,solid] of r.cells??[])cells.set(`${cx},${cy},${cz}`,{type,solid});
    }
    const at=(x,y,z)=>cells.get(`${x},${y},${z}`);
    const isDoor=c=>!!c&&/_DOOR$/.test(c.type);
    const open=c=>!c||isDoor(c)||!c.solid;            // air, a door, or something you walk through
    const wall=c=>!!c&&c.solid&&!isDoor(c)&&!/GLASS|PANE|LEAVES|FENCE|SLAB|STAIRS/.test(c.type);
    const inside=(x,z)=>x>=box.x&&x<box.x+box.w&&z>=box.z&&z<box.z+box.d;
    const cx=box.x+box.w/2,cz=box.z+box.d/2,tl=Math.hypot(toward.x-cx,toward.z-cz)||1,tx=(toward.x-cx)/tl,tz=(toward.z-cz)/tl;
    const FACES=[['NORTH',0,-1],['SOUTH',0,1],['WEST',-1,0],['EAST',1,0]];
    let best=null;const ways=[];
    // 1. Over a door or doorway in the outer wall.
    for(let x=box.x;x<box.x+box.w;x++)for(let z=box.z;z<box.z+box.d;z++){
      if(x!==box.x&&x!==box.x+box.w-1&&z!==box.z&&z!==box.z+box.d-1)continue;   // the outer ring only
      for(let y=y0+1;y<=y0+H-3;y++){
        if(!open(at(x,y,z))||!open(at(x,y+1,z))||!(at(x,y-1,z)?.solid))continue;
        if(Math.abs(y-(box.y+1))>1)continue;                             // at floor level (not a tall window)
        const door=isDoor(at(x,y,z))||isDoor(at(x,y+1,z));
        for(const [face,dx,dz] of FACES){
          const ox=x+dx,oz=z+dz;if(inside(ox,oz))continue;
          if(!open(at(ox,y+1,oz)))continue;                              // a doorway you can walk out of (head room)
          // The lintel: the wall right above the door, or (a porch, the warehouse) one block out.
          const lintel=wall(at(x,y+2,z))?{x:ox,z:oz}:wall(at(ox,y+2,oz))?{x:ox+dx,z:oz+dz}:null;
          if(!lintel)continue;
          ways.push({x,y,z,face,dx,dz,door,ground:at(ox,y-1,oz)??null,below:at(ox,y-2,oz)??null,feet:at(ox,y,oz)??null});
          if(at(lintel.x,y+2,lintel.z))continue;                         // the sign's own cell must be free
          const score=(door?40:20)-Math.abs(y-(box.y+1))*4+(dx*tx+dz*tz)*2;
          if(!best||score>best.score)best={x:lintel.x,y:y+2,z:lintel.z,facing:face,score,over:door?'door':'doorway'};
        }
      }
    }
    if(best)return {...best,ways};
    // 2. No doorway found: the wall facing the square, near the middle, at head height.
    for(const [k,c] of cells){
      if(!wall(c))continue;
      const [x,y,z]=k.split(',').map(Number);if(!inside(x,z))continue;
      for(const [face,dx,dz] of FACES){
        const ox=x+dx,oz=z+dz;if(inside(ox,oz)||cells.has(`${ox},${y},${oz}`))continue;
        const mid=Math.hypot(x+0.5-(cx+dx*box.w/2),z+0.5-(cz+dz*box.d/2));
        const score=(dx*tx+dz*tz)*10-Math.abs(y-(box.y+3))*3-mid*0.4;
        if(!best||score>best.score)best={x:ox,y,z:oz,facing:face,score,over:'wall'};
      }
    }
    return best?{...best,ways}:(ways.length?{none:true,ways}:null);
  }
  let signsBusy=false;
  async function postAllSigns(){
    if(signsBusy)return;signsBusy=true;
    try{
      const done=town.signsPosted??={},id=anyOnline();if(!id)return;
      if(!town.signFixV3){town.signFixV3=true;delete done.warehouse;}   // first try found no spot on its crowded walls
      // One-time (v4): the first signs went on the wall facing the square (over windows, on side walls); they were
      // taken down and every building and home gets its sign again, over its door. Pending ones are dropped.
      // One-time (v6): the market hall is an open pavilion; its sign on the east pillar at head height kept failing
      // (the pillar's top block): hung one lower on the same pillar.
      if(!town.signFixV6){town.signFixV6=true;
        town.damage.furnish=(town.damage.furnish??[]).filter(f=>f.for!=='sign:market_hall');
        const m=town.sites?.market_hall;if(m&&town.built.market_hall){const w=({...siteSpec(SITES.market_hall),...(town.designs?.market_hall?.spec??{})}).width??9;
          requestFurnish({x:m.x+w,y:m.y+2,z:m.z+4,facing:'EAST',text:"|MARLO'S MARKET|Market Hall|",block:'SPRUCE_WALL_SIGN',sign:true,for:'sign:market_hall',quiet:true});done.market_hall={at:Date.now(),x:m.x+w,y:m.y+2,z:m.z+4,over:'pillar'};}}
      if(!town.signFixV5){town.signFixV5=true;delete done.warehouse;delete done.market_hall;delete done.shrine;}
      if(!town.signFixV4){town.signFixV4=true;
        for(const k of Object.keys(done))if(k!=='town_hall'&&k!=='courthouse')delete done[k];
        town.damage.furnish=(town.damage.furnish??[]).filter(f=>!/^sign:/.test(f.for??'')||/^sign:(town_hall|courthouse)$/.test(f.for));}
      // Every building and every home: its name sign over the door, and its entrances made usable - a spruce door
      // where there is none, and a spruce stair in front where the ground outside is a step lower than the doorway.
      const ent=town.entrances??={};
      if(!town.entranceFixV1){town.entranceFixV1=true;for(const k of Object.keys(ent))delete ent[k];}
      // (v2) homes whose "doorways" were holes in an unfinished wall: their door requests dropped, checked again.
      // The warehouse has its double door; its other west openings are the drop-box hatch (the counter), left open.
      ent.warehouse={at:Date.now(),ways:0,fixes:0,note:'double door; the hatch by the drop box stays open'};
      town.damage.furnish=(town.damage.furnish??[]).filter(f=>!/^(door|wall):warehouse$/.test(f.for??''));
      if(!town.entranceFixV2){town.entranceFixV2=true;for(const k of Object.keys(ent))if((ent[k]?.ways??0)>=3){delete ent[k];town.damage.furnish=(town.damage.furnish??[]).filter(f=>f.for!=='door:'+k);}}
      const pending=k=>!done[k]||!ent[k];
      const jobs=[];
      for(const site of new Set([...Object.keys(SIGN_TEXT),...Object.keys(SITES),'town_hall','courthouse'])){
        if(!pending(site)||!town.built[site]||(town.finishing??{})[site]||(town.priorityBuilds??[]).includes('finish:'+site))continue;
        let box=null;
        if(site==='warehouse'&&town.warehouseRoom?.walls&&town.warehouseFloor){const w=town.warehouseRoom.walls;box={x:w.x1,z:w.z1,w:w.x2-w.x1+1,d:w.z2-w.z1+1,y:town.warehouseFloor-1};}
        else{const at=town.sites?.[site];if(at&&Number.isFinite(at.y))box=wallBox(site,at);}
        if(box)jobs.push({key:site,box,text:SIGN_TEXT[site]?`|${SIGN_TEXT[site][0]}|${SIGN_TEXT[site][1]}|`:`|${siteName(site).toUpperCase()}|Community building|`});
      }
      // Homes (5x5 from the lot's north-west corner): the ground is surveyed just outside the door side.
      for(const h of d.homeLots?.()??[]){
        const key='home:'+h.id;if(!pending(key))continue;
        const [dx,dz]={east:[1,0],west:[-1,0],north:[0,-1],south:[0,1]}[h.door??'south']??[0,1];
        const toward={x:h.x+2.5+dx*10,z:h.z+2.5+dz*10};
        jobs.push({key,home:true,material:h.material,box:{x:h.x,z:h.z,w:5,d:5,y:null},toward,out:{x:Math.floor(h.x+2.5+dx*4),z:Math.floor(h.z+2.5+dz*4)},text:`|${h.name.toUpperCase()}'S|HOME|`});
      }
      for(const j of jobs.slice(0,6)){   // a few each round (the scans are cheap, the crew does the work one by one)
        if(j.box.y===null){
          const g=await act(id,{type:'survey',x:j.out.x,y:0,z:j.out.z,width:1,depth:1}).then(r=>r?.heights?.[0]).catch(()=>null);
          if(!Number.isFinite(g))continue;j.box.y=g;
        }
        let spot=await signSpot(id,j.box,j.toward??SQUARE);
        if(!spot){done[j.key]??=Date.now();ent[j.key]=Date.now();log('sign_no_spot',{for:j.key,box:j.box});continue;}
        // Entrances: a door in every doorway, a step up to it where the ground falls away.
        if(!ent[j.key]){
          const fixes=[];
          // Three or more openings side by side are a hole in an unfinished wall, not a doorway: the wall is closed with
          // the building's material and one door goes in the middle (Wade's home had three doors queued in a gap).
          const ways=spot.ways??[],runOf=w=>ways.filter(o=>o.face===w.face&&o.y===w.y&&(w.dx?o.x===w.x&&Math.abs(o.z-w.z)<=2:o.z===w.z&&Math.abs(o.x-w.x)<=2));
          const fill=j.material&&/PLANKS|LOG|BRICKS|COBBLE|STONE/.test(j.material)?j.material:'SPRUCE_PLANKS';
          const keep=new Set();
          for(const w of ways){const run=runOf(w);if(run.length<3)continue;
            const along=o=>w.dx?o.z:o.x,mid=[...run].sort((a,b)=>along(a)-along(b))[Math.floor(run.length/2)];
            if(w!==mid){for(const y of [w.y,w.y+1])requestFurnish({x:w.x,y,z:w.z,block:fill,for:'wall:'+j.key,quiet:true});fixes.push({wall:[w.x,w.y,w.z]});keep.add(w);}}
          for(const w of ways){
            if(keep.has(w))continue;
            if(!w.door){requestFurnish({x:w.x,y:w.y,z:w.z,block:'SPRUCE_DOOR',facing:w.face,for:'door:'+j.key,quiet:true});fixes.push({door:[w.x,w.y,w.z]});}
            const gx=w.x+w.dx,gz=w.z+w.dz;
            if(!(w.ground?.solid)&&w.below?.solid&&!(w.feet?.solid)){
              const up={NORTH:'SOUTH',SOUTH:'NORTH',EAST:'WEST',WEST:'EAST'}[w.face];   // the stair climbs toward the door
              requestFurnish({x:gx,y:w.y-1,z:gz,block:'SPRUCE_STAIRS',facing:up,for:'step:'+j.key,quiet:true});fixes.push({step:[gx,w.y-1,gz]});
            }
          }
          ent[j.key]={at:Date.now(),ways:(spot.ways??[]).length,fixes:fixes.length};
          if(fixes.length)log('entrance_fixes',{for:j.key,fixes});
        }
        if(!done[j.key]&&j.text&&!spot.none){
          if(j.key==='jail'&&!town.built.jail){continue;}
          done[j.key]={at:Date.now(),x:spot.x,y:spot.y,z:spot.z,over:spot.over};
          requestFurnish({x:spot.x,y:spot.y,z:spot.z,facing:spot.facing,text:j.text,block:'SPRUCE_WALL_SIGN',sign:true,for:'sign:'+j.key,quiet:true});
          log('signs_requested',{site:j.key,at:{x:spot.x,y:spot.y,z:spot.z,facing:spot.facing},over:spot.over});
        }else done[j.key]??=Date.now();
      }
    }finally{signsBusy=false;}
  }

  // ---------- the shops: Marlo's market (the market hall) and Antoine's bakery ----------
  // Each shop is its keeper's alone (plugin 2.29.0 "market" with to=keeper): stock chests apart from the warehouse,
  // sold to players through a trade window (right-click the keeper) and to citizens who come in to buy. The warehouse's
  // overflow goes onto the shelves: food to the bakery, everything else to the market.
  const SHOPS={
    merchant:{site:'market_hall',name:"Marlo's market",sign:"MARLO'S MARKET"},
    chef:{site:'bakery',name:"Antoine's bakery",sign:"ANTOINE'S BAKERY"},
  };
  const shopState=shop=>((town.shops??={})[shop]??={setup:null,stock:null});
  // One-time: Marlo's market as first written (town.marketSetup / marketStock) moves under town.shops.
  if(town.marketSetup&&!town.shops?.merchant?.setup){shopState('merchant').setup=town.marketSetup;shopState('merchant').stock=town.marketStock??null;}
  delete town.marketSetup;delete town.marketStock;
  /** Where the keeper stands and which chests are the stock (null before the building is up). */
  function shopLayout(shop){
    const S=SHOPS[shop],at=town.sites?.[S?.site];if(!S||!at||!town.built[S.site]||!Number.isFinite(at.y))return null;
    if(shop==='chef'){
      // The bakery (bakeryLayout): the stove on the north wall, the pantry on the west; the stock along the south wall.
      const b=bakeryLayout(at),y=at.y+1,z=at.z+5;
      return {spot:{x:b.chef.x,y,z:b.chef.z},chests:[[at.x+2,y,z,'NORTH','LEFT'],[at.x+3,y,z,'NORTH','RIGHT'],[at.x+4,y,z,'NORTH','LEFT'],[at.x+5,y,z,'NORTH','RIGHT']]};
    }
    // The market hall (an open pavilion): two double chests on each side of the stalls, Marlo in the middle.
    const spec={...siteSpec(SITES.market_hall),...(town.designs?.market_hall?.spec??{})},w=spec.width??9,dd=spec.depth??9;
    const y=at.y+1,a=at.z+1,b=at.z+dd-2,l=at.x+1,r=at.x+w-3;
    return {spot:{x:at.x+w/2,y,z:at.z+dd/2},chests:[[l,y,a,'SOUTH','RIGHT'],[l+1,y,a,'SOUTH','LEFT'],[r,y,a,'SOUTH','RIGHT'],[r+1,y,a,'SOUTH','LEFT'],
      [l,y,b,'NORTH','LEFT'],[l+1,y,b,'NORTH','RIGHT'],[r,y,b,'NORTH','LEFT'],[r+1,y,b,'NORTH','RIGHT']]};
  }
  const shopSpot=shop=>shopLayout(shop)?.spot??null;
  // One-time (jail bars v1): the cells' fronts were oak fences; they are iron bars now (the blueprint too). The fences
  // were taken out by hand; the repair crew sets the bars (16 in the warehouse).
  if(!town.jailBarsV1&&town.built.jail&&town.sites?.jail){town.jailBarsV1=true;
    const at=town.sites.jail;
    setTimeout(()=>{try{if(!town.built.jail||town.sites?.jail?.layoutVersion===2||stateOf('builder')?.project?.renovation)return;for(const i of [1,2,4,5,7])for(const lv of [1,2])requestFurnish({x:at.x+i,y:at.y+lv,z:at.z+3,block:'IRON_BARS',for:'bars:jail',quiet:true});log('jail_bars_requested',{cells:5});}catch(e){log('jail_bars_error',{message:e.message});}},30000).unref?.();}
  // One-time (infirmary v1): the builder checks the infirmary against its plan (placing anything missing), and the
  // open doorway in its south wall gets a door - Rosa's clinic as a finished building, not a shell.
  if(!town.infirmaryFinishV1&&town.built.infirmary&&town.sites?.infirmary){town.infirmaryFinishV1=true;
    if(!(town.priorityBuilds??[]).includes('finish:infirmary'))(town.priorityBuilds??=[]).push('finish:infirmary');
    const at=town.sites.infirmary;
    setTimeout(()=>{try{requestFurnish({x:at.x+4,y:at.y+1,z:at.z+6,block:'SPRUCE_DOOR',facing:'SOUTH',for:'door:infirmary',quiet:true});}catch(e){log('infirmary_door_error',{message:e.message});}},30000).unref?.();}
  const shopReady=shop=>!!shopState(shop).setup?.done&&!!shopSpot(shop)&&!!byRole(shop);
  const marketSpot=()=>shopSpot('merchant');
  /** Which shop takes an item: food the bakery (when open), everything else the market. */
  const shopFor=item=>(FOOD_POINTS[item]??0)>0&&shopReady('chef')?'chef':shopReady('merchant')?'merchant':null;
  /** Once per shop: its stock chests stood in (taken from the warehouse) and registered as the keeper's. */
  async function setupShop(shop){
    const L=shopLayout(shop),keeper=byRole(shop),st=shopState(shop);if(!L||!keeper||st.setup?.done)return;
    const res=await act(keeper.id,{type:'market',text:'setup',to:shop,x:0,y:0,z:0,spec:{chests:L.chests}}).catch(e=>({error:e.message}));
    log('shop_setup',{shop,...res});
    if(res&&!res.error&&(res.chests??0)>=L.chests.length){st.setup={done:true,at:Date.now(),chests:res.chests};
      ledger(keeper.id,`opened ${SHOPS[shop].name}: ${L.chests.length/2} double chests of goods for sale to all comers`);
      say(keeper.id,shop==='chef'?"My bakery is open! Bread, meals and the town's spare food - come to the bakery.":"My market is open at the market hall! The town's surplus, fair prices - come and see.").catch(()=>{});}
  }
  /** What a shop's chests hold (refreshed every few minutes), and the labels on them. */
  async function refreshShop(shop){
    const keeper=byRole(shop),st=shopState(shop);if(!keeper||!st.setup?.done)return;
    const r=await act(keeper.id,{type:'market',text:'stock',to:shop,x:0,y:0,z:0}).catch(()=>null);
    if(!r?.items)return;
    st.stock={items:r.items,chests:r.chests,at:Date.now()};
    const seen=st.labels??={},out=[];
    for(const ch of r.chests??[]){const top=Object.entries(ch.items??{}).sort((x,y)=>y[1]-x[1]).slice(0,2).map(([k])=>k.toLowerCase().replace(/_/g,' '));
      const t=`${SHOPS[shop].sign}|${top.length?top.join(', '):'(empty)'}`,k=`${ch.x},${ch.y},${ch.z}`;if(seen[k]!==t){out.push([ch.x,ch.y,ch.z,t]);seen[k]=t;}}
    if(out.length)await act(keeper.id,{type:'labels',x:0,y:0,z:0,spec:{labels:out}}).catch(()=>{for(const [x,y,z] of out)delete seen[`${x},${y},${z}`];});
  }
  async function shopsTick(){for(const shop of Object.keys(SHOPS)){await setupShop(shop);await refreshShop(shop);}workshopsTick();}
  /** A finished workshop: its workstations go in along the back wall, and its citizen works from there. */
  function workshopSpot(id){const at=town.sites?.[id];return at&&town.built[id]?{x:at.x+3.5,y:at.y+1,z:at.z+2.5}:null;}
  function workshopsTick(){
    for(const [id,w] of Object.entries(WORKSHOPS)){
      const at=town.sites?.[id];if(!at||!town.built[id])continue;
      const done=town.workshopsFurnished??={};
      if(!done[id]){done[id]=Date.now();
        w.stations.forEach((block,i)=>requestFurnish({x:at.x+2+i*2,y:at.y+1,z:at.z+5,block,facing:'NORTH',for:'station:'+id,quiet:true}));
        log('workshop_furnish',{id,stations:w.stations});
        const who=byRole(w.role);if(who)ledger(who.id,`moved into the ${siteName(id)} (${w.stations.map(b=>b.toLowerCase().replace(/_/g,' ')).join(', ')})`);}
      // The crafter and the fisher work from their shop (their idle spot); Rosa brews in the shed (roles/specialists.mjs).
      const who=byRole(w.role),spot=workshopSpot(id);
      if(who&&spot&&w.role!=='herbalist'){const p=[Math.floor(spot.x),Math.floor(spot.z)];if(who.post?.[0]!==p[0]||who.post?.[1]!==p[1])who.post=p;}
    }
  }
  /**
   * Goods onto a shop's shelves: whoever carries them walks there and puts them in its chests (null: still on the way).
   * A citizen selling (not the clerk with the warehouse's overflow) is paid at the market price, as at the warehouse.
   */
  async function stockMarket(id,self,load,{sale=false,shop=null}={}){
    shop??=shopFor(load[0]?.item);if(!shop||!shopReady(shop))return null;
    const spot=shopSpot(shop);
    if(Math.hypot(self.x-spot.x,self.z-spot.z)>4){if(!self.pathing)await travel(id,self,{x:spot.x,y:spot.y,z:spot.z}).catch(()=>{});return null;}
    const put={},sold={},st=shopState(shop);
    for(const {item,count} of load){
      // Shelf room: SHELF_CAP of each item (27 of things that do not stack, four stacks of the rest).
      const room=Math.max(0,SHELF_CAP(item)-(st.stock?.items?.[item]??0)),n=Math.min(count,room);
      if(n>0){
        const r=await act(id,{type:'market',text:'stockup',to:shop,x:0,y:0,z:0,target:item,count:n}).catch(e=>({error:e.message}));
        if(r?.stocked){put[item]=r.stocked;(st.stock??={items:{},chests:[]}).items[item]=(st.stock.items[item]??0)+r.stocked;if(sale)buyFrom(id,item,r.stocked,id);}
      }
      // The town's own surplus beyond the shelves (Jasper's loads, Marlo's pack): sold on to a passing caravan.
      const over=count-(put[item]??0);
      if(over>0&&!sale){const r=await act(id,{type:'caravan',x:0,y:0,z:0,target:item,count:over}).catch(()=>null);if(r?.sold)sold[item]=r.sold;}
    }
    if(Object.keys(put).length){log('shop_stocked',{agent:id,shop,items:put,sale});refreshShop(shop).catch(()=>{});}
    if(Object.keys(sold).length){log('caravan_sold',{agent:id,shop,items:sold});
      ledger(id,`sold ${Object.entries(sold).map(([k,v])=>`${v} ${k.toLowerCase().replace(/_/g,' ')}`).join(', ')} to a passing caravan (more than ${SHOPS[shop].name} can shelve)`);}
    return put;
  }
  /** How many of an item a shop keeps on its shelves. */
  const SHELF_CAP=item=>stackSize(item)===1?27:256;
  /** Shelves over their cap (the first days' 200 bows): taken down and sold to a caravan by the keeper. */
  async function trimShelves(shop,id){
    const st=shopState(shop);let n=0;
    for(const ch of st.stock?.chests??[])for(const [item,c] of Object.entries(ch.items??{})){
      const over=(st.stock.items[item]??0)-SHELF_CAP(item);if(over<=0||n>=3)continue;
      const r=await act(id,{type:'withdraw',x:ch.x,y:ch.y,z:ch.z,target:item,count:Math.min(over,c,256)}).catch(()=>null);
      if(!r?.withdrew)continue;n++;
      st.stock.items[item]-=r.withdrew;ch.items[item]-=r.withdrew;
      const sold=await act(id,{type:'caravan',x:0,y:0,z:0,target:item,count:r.withdrew}).catch(()=>null);
      if(sold?.sold){log('caravan_sold',{agent:id,shop,items:{[item]:sold.sold},from:'shelves'});ledger(id,`sold ${sold.sold} ${item.toLowerCase().replace(/_/g,' ')} off the overfull shelves to a passing caravan`);}
    }
    if(n)refreshShop(shop).catch(()=>{});
    return n;
  }
  /**
   * A shopkeeper's day (Marlo at the market hall, Antoine keeps his own kitchen routine in roles/chef.mjs): at the
   * stall, shelving what he carries. Night: home to sleep like everyone else.
   */
  function traderJob(c,s,self,night){
    if(roleOf(c)!=='merchant'||night)return null;
    const spot=shopSpot('merchant');if(!spot)return null;
    return async()=>{
      if(!shopState('merchant').setup?.done&&ready('market-setup',300000))await setupShop('merchant');
      if(Math.hypot(self.x-spot.x,self.z-spot.z)>2){if(!self.pathing)await travel(c.id,self,{x:spot.x,y:spot.y,z:spot.z}).catch(()=>{});return;}
      // His pack onto the shelves (emeralds and a little food kept), a few kinds at a time.
      const keep={EMERALD:1e9,BREAD:8,APPLE:4,COOKED_COD:4,BAKED_POTATO:4};
      const load=Object.entries(self.inventory??{}).map(([item,n])=>({item,count:n-(keep[item]??0)})).filter(l=>l.count>0).slice(0,6);
      if(load.length&&shopReady('merchant')&&ready(`stock-shelves:${c.id}`,30000)){await stockMarket(c.id,self,load,{shop:'merchant'});return;}
      if(shopReady('merchant')&&ready(`trim-shelves:${c.id}`,60000)&&await trimShelves('merchant',c.id))return;
      if(ready('market-refresh',180000))await refreshShop('merchant');
    };
  }
  // ---------- Wren the Scout: expeditions beyond the town ----------
  // Twice a day he sets out 140-220 blocks from the square, a different compass point each time, looks over the land
  // there (ore showing, timber, clay, cane, wild crops, animals), records every find in the town's spatial memory (the
  // dashboard's known resources) and comes back to report. He had no such job: in six hours not one walk left town.
  const SCOUT_DIRS=[['north',0,-1],['north-east',0.7,-0.7],['east',1,0],['south-east',0.7,0.7],['south',0,1],['south-west',-0.7,0.7],['west',-1,0],['north-west',-0.7,-0.7]];
  const SCOUT_LOOK=[['IRON_ORE','ore'],['COAL_ORE','ore'],['COPPER_ORE','ore'],['GOLD_ORE','ore'],['OAK_LOG','tree'],['BIRCH_LOG','tree'],['SPRUCE_LOG','tree'],['DARK_OAK_LOG','tree'],['JUNGLE_LOG','tree'],['CLAY','clay'],['SUGAR_CANE','plant'],['PUMPKIN','plant'],['MELON','plant'],['SWEET_BERRY_BUSH','plant'],['COW','animal'],['SHEEP','animal'],['PIG','animal'],['CHICKEN','animal'],['HORSE','animal']];
  function scoutJob(c,s,self,night){
    if((roleOf(c)!=='scout'&&c.id!=='scout')||night||s.resting)return null;   // Wren's role is 'citizen'; his id is scout
    const S=town.scouting??={n:0,day:null,today:0,trips:[]};
    if(S.day!==town.day){S.day=town.day;S.today=0;}
    const phase=dayPhase(getSnapshot()?.worldTime);
    let e=s.expedition;
    // A trip left unfinished overnight (dusk called him home) is dropped, not 'surveyed' from the town square next day.
    if(e&&Date.now()-e.started>30*60000){log('scout_abandoned',{agent:c.id,dir:e.dir,phase:e.phase});s.expedition=e=null;}
    if(!e){
      if(S.today>=2||!['dawn','day'].includes(phase)||!ready(`scout-start:${c.id}`,120000))return null;
      const [name,dx,dz]=SCOUT_DIRS[S.n%SCOUT_DIRS.length],dist=140+40*(Math.floor(S.n/SCOUT_DIRS.length)%3);
      e=s.expedition={dir:name,target:{x:Math.round(SQUARE.x+dx*dist),z:Math.round(SQUARE.z+dz*dist)},phase:'out',started:Date.now(),finds:{}};
      S.n++;S.today++;log('scout_departed',{agent:c.id,dir:name,to:e.target});
      ledger(c.id,`set out to scout the ${name} (${e.target.x}, ${e.target.z})`);
      say(c.id,`Heading out ${name} to see what's past the town. Back by evening!`).catch(()=>{});
    }
    return async()=>{
      const late=['evening','dusk'].includes(dayPhase(getSnapshot()?.worldTime));
      if(e.phase==='out'){
        const far=Math.hypot(self.x-e.target.x,self.z-e.target.z);
        // Not even close after 8 minutes (the north lake): that way is blocked - reported, and the trip ends.
        if(Date.now()-e.started>8*60000&&far>60){S.blocked=[...(S.blocked??[]),e.dir].slice(-8);log('scout_blocked',{agent:c.id,dir:e.dir,at:{x:Math.round(self.x),z:Math.round(self.z)},far:Math.round(far)});
          ledger(c.id,`could not get through to the ${e.dir} (water or cliffs in the way, ${Math.round(far)} blocks short)`);say(c.id,`No way through to the ${e.dir} today - too much water. I'll try another direction.`).catch(()=>{});s.expedition=null;return;}
        if(far<=12||Date.now()-e.started>8*60000||late){e.phase='survey';return;}   // there (or as far as he got today)
        if(!self.pathing)await travel(c.id,self,{x:e.target.x+0.5,y:Math.round(self.y),z:e.target.z+0.5}).catch(()=>{});
        return;
      }
      if(e.phase==='survey'){
        for(const [what,category] of SCOUT_LOOK){
          const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:what,count:24}).catch(()=>[]);
          if(!Array.isArray(found)||!found.length)continue;
          e.finds[what]=found.length;const f=found[0];
          if(Number.isFinite(f.x))d.intel?.()?.spatial?.record?.({observed_by:c.id,x:Math.floor(f.x),y:Math.floor(f.y??self.y),z:Math.floor(f.z),category,item:what,details:{scouted:true,count:found.length,dir:e.dir}});
        }
        e.at={x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)};e.phase='back';
        log('scout_surveyed',{agent:c.id,dir:e.dir,at:e.at,finds:e.finds});return;
      }
      // Home to the square, and the report.
      if(Math.hypot(self.x-SQUARE.x,self.z-SQUARE.z)>10){if(!self.pathing)await travel(c.id,self,{x:SQUARE.x,y:Math.round(self.y),z:SQUARE.z}).catch(()=>{});
        if(Date.now()-e.started<20*60000)return;}
      const list=Object.entries(e.finds).map(([k,n])=>`${n} ${k.toLowerCase().replace(/_/g,' ')}`);
      const rec={day:town.day,dir:e.dir,at:e.at,finds:e.finds};S.trips=[rec,...S.trips].slice(0,30);
      ledger(c.id,`scouted the ${e.dir} at ${e.at?.x}, ${e.at?.z}: ${list.length?list.join(', '):'nothing of use'}`);
      log('scout_report',{agent:c.id,...rec});
      const best=Object.keys(e.finds).find(k=>/_ORE$/.test(k))??Object.keys(e.finds).find(k=>/CLAY|SUGAR|PUMPKIN|MELON|BERRY/.test(k))??Object.keys(e.finds)[0];
      say(c.id,best?`Back from the ${e.dir}! Found ${list.slice(0,4).join(', ')} around ${e.at?.x}, ${e.at?.z}.`:`Back from the ${e.dir} - nothing much out there today.`).catch(()=>{});
      s.expedition=null;
    };
  }
  /** Working hours at the post (dawn and day): Marlo in the market hall. main.mjs keeps strolls and gatherings off him. */
  const traderOnDuty=c=>roleOf(c)==='merchant'&&!!shopSpot('merchant')&&['dawn','day'].includes(dayPhase(getSnapshot()?.worldTime));

  function onProjectDone(c,project,success){
    if(project.registryKey&&town.constructionRegistry?.[project.registryKey])Object.assign(town.constructionRegistry[project.registryKey],{status:success&&project.verified?'completed':'unfinished',verified:!!project.verified,updated:Date.now()});
    if(project.completionPlan!==undefined){if(success){(town.completionInspections??={})[project.completionPlan]={at:Date.now(),missing:0,verified:!!project.verified};if(project.completionSite){installCompletionDefinition(project.completionSite,project.completionDefinition);town.built[project.completionSite]=true;(town.finishedSites??={})[project.completionSite]=Date.now();setTimeout(postAllSigns,5000);}}else (town.priorityBuilds??=[]).push(`complete:${project.completionPlan}`);}
    if(project?.finishing&&project.publicWork){delete (town.finishing??{})[project.publicWork];if(success){town.built[project.publicWork]=true;(town.finishedSites??={})[project.publicWork]=Date.now();log('finish_done',{site:project.publicWork});}else if(((town.finishTries??={})[project.publicWork]=(town.finishTries[project.publicWork]??0)+1)<3)(town.priorityBuilds??=[]).unshift('finish:'+project.publicWork);}
    if(success&&project?.publicWork)setTimeout(postSigns,5000);
    const site=project.publicWork&&SITES[project.publicWork];
    intel()?.onProjectDone(c.id,project,success,site?{x:site.x+3,z:site.z+3}:getSnapshot()?.agents.find(a=>a.id===c.id));
    town.attempts??={};
    if(project.publicWork){
      if(success){town.built[project.publicWork]=true;if(project.publicWork!=='warehouse'&&!project.finishing)scheduleFestival('feast',`the new ${project.name}`,SITES[project.publicWork]);}
      else{town.attempts[project.publicWork]=(town.attempts[project.publicWork]??0)+1;(town.attemptAt??={})[project.publicWork]=Date.now();}
      if(success&&town.requests)town.requests=town.requests.filter(x=>x!==project.publicWork);
    }
    // A road only counts when mostly placed; otherwise retry it (up to 3 times) before moving on.
    if(project.road){if(success)town.roadsDone++;else{town.roadAttempts??={};if((town.roadAttempts[project.road]=(town.roadAttempts[project.road]??0)+1)>=3)town.roadsDone++;}}
    if(project.bridgeFix?.startsWith('redo:')){if(success)ledger(c.id,`rebuilt the ${project.bridgeFix.slice(5)}`);}
    else if(project.bridgeFix){
      if(success)town.bridgeFix=town.bridgeFix.filter(n=>n!==project.bridgeFix);
      else{town.bridgeFixTries??={};town.bridgeFixTries[project.bridgeFix]=(town.bridgeFixTries[project.bridgeFix]??0)+1;}
    }
    if(project.planStage){
      if(success){
        town.plan.done.push(project.planStage);town.plan.funded=town.plan.funded.filter(x=>x!==project.planStage);
        const found=stageOf(project.planStage);ledger(c.id,`finished the ${found?.stage.name??project.name} (${found?.plan.name??'town plan'})`);
        if(found&&found.plan.stages.every(st=>town.plan.done.includes(st.id)))scheduleFestival('feast',`completing the ${found.plan.name.toLowerCase()}`,null);
      }else{town.plan.attempts[project.planStage]=(town.plan.attempts[project.planStage]??0)+1;(town.plan.attemptAt??={})[project.planStage]=Date.now();}
    }
    if(success)award(c.id,'project');
    if(project.publicWork==='warehouse'&&success){ledger(c.id,'the warehouse is open: bring surplus goods here');refreshStock();}
  }
  /** Builder ran out of a material: fetch what the rest of the project needs from the warehouse. */
  // ---------- materials for a construction phase (reservations.mjs) ----------
  // The builder asks for the materials of the NEXT phase (foundation, walls, roof): what the warehouse holds is reserved
  // for it; what is short is promised by the crafter (crafted or felled), the miner (dug: cobblestone, clay) or nobody.
  // The courier brings the reserved goods to the site; every delivery is confirmed. Blocks are never left out: when
  // nobody can supply a material, a same-kind stand-in is used only after the builder has waited (and it is recorded),
  // otherwise the project is blocked with the reason (construction.mjs parks it and comes back).
  const projectKey=(c,p)=>`${c.id}:${p.name}`;
  async function fetchForProject(c,s,self){
    const p=s.project,key=projectKey(c,p),have=self.inventory??{};
    const pending=p.queue.filter(b=>!b.clear);
    if(!pending.length){p.waiting=false;return;}
    const phase=phaseOf(p,Math.min(...pending.map(b=>b.y)));
    const need={};for(const b of pending.filter(b=>phaseOf(p,b.y)===phase)){const item=b.block==='REDSTONE_WIRE'?'REDSTONE':b.block;need[item]=(need[item]??0)+1;}
    const roles={crafter:byRole('crafter')?.id,miner:byRole('miner')?.id,courier:byRole('courier')?.id};
    const r=requestPhase(reservations,{key,builder:c.id,project:p.name,phase,need,stock:town.stock.items,have,roles,dueMs:SUPPLY_WAIT},{supplySteps,recipeFor});
    p.supplyAsked??={};
    // Nobody can make or dig it: after the builder's wait, a same-kind stand-in from the warehouse (recorded); else the
    // town is asked (a work order players and citizens can fill) and the project stays blocked - never left out.
    for(const [item,n] of Object.entries(r.unsupplied)){
      p.supplyAsked[item]??=Date.now();
      const waited=Date.now()-p.supplyAsked[item]>=SUPPLY_WAIT;
      const swap=waited?supplyPlan([[item,n]],{stock:town.stock.items,have:{}}).find(st=>st.kind==='swap'):null;
      if(swap){
        let left=swap.count;for(const blk of p.queue)if(left>0&&!blk.clear&&blk.block===item){blk.block=swap.to;left--;}
        let left2=swap.count;for(const blk of p.expected??[])if(left2>0&&blk.block===item){blk.block=swap.to;left2--;}
        delete r.unsupplied[item];
        ledger(c.id,`used ${label(swap.to)} for ${swap.count} ${label(item)} in the ${p.name} (nobody in town can make ${label(item)})`);
        log('build_supply',{agent:c.id,project:p.name,swap:item,to:swap.to,count:swap.count});continue;
      }
      if(waited&&ready(`public-ask:${key}:${item}`,1800000))await postQuest(c.id,item,Math.min(64,n),`for the ${p.name}`,{priority:'HIGH',targetLocation:'warehouse'}).catch(()=>{});
    }
    // Assigned but never delivered (the miner digs stone, not cobblestone, and his new level keeps hitting water): after
    // twice the wait, a same-kind stand-in the warehouse holds is used (recorded) - the bakery and the jail waited hours
    // for 72 cobblestone with 312 stone on the shelves.
    p.shortSince??={};
    for(const [item,n] of Object.entries(r.missing??{})){
      if(item in r.unsupplied||n<=0){delete p.shortSince[item];continue;}
      p.shortSince[item]??=Math.min(Date.now(),p.blocker?.since??Date.now());
      if(Date.now()-p.shortSince[item]<2*SUPPLY_WAIT)continue;
      const swap=supplyPlan([[item,n]],{stock:town.stock.items,have:{}}).find(st=>st.kind==='swap');
      if(!swap)continue;
      let left=swap.count;for(const blk of p.queue)if(left>0&&!blk.clear&&blk.block===item){blk.block=swap.to;left--;}
      let left2=swap.count;for(const blk of p.expected??[])if(left2>0&&blk.block===item){blk.block=swap.to;left2--;}
      delete r.missing[item];delete p.shortSince[item];
      ledger(c.id,`used ${label(swap.to)} for ${swap.count} ${label(item)} in the ${p.name} (waited too long for ${label(item)} to be delivered)`);
      log('build_supply',{agent:c.id,project:p.name,swap:item,to:swap.to,count:swap.count,why:'assigned but not delivered'});
    }
    // Without a courier on duty the builder fetches the reserved goods himself.
    // ...or when the courier has not brought them within 3 minutes (busy with other errands, or night): the builder
    // walks over himself - three buildings sat for hours on "the courier is bringing the reserved materials".
    const reservedWaiting=Object.values(r.reserved).some(n=>n>0);if(!reservedWaiting)p.reservedSince=null;else p.reservedSince??=Date.now();
    if((!roles.courier||reservedWaiting&&Date.now()-p.reservedSince>180000)&&reservedWaiting&&await goToWarehouse(c.id,self)){
      for(const [item,n] of Object.entries(r.reserved))if(n>0){const got=await withdraw(c.id,item,Math.min(128,n),{direct:true});if(got)reservations.delivered(key,item,got,c.id);}
    }
    const missing={...r.missing,...r.unsupplied};
    if(r.assigned.miner)r.assigned.minerSite=d.mineSite?.();   // where the miner is digging now (or opening a new level)
    p.materials={missing,assigned:r.assigned,nextCheck:Date.now()+30000};
    p.waiting=Object.keys(missing).length>0||(!!roles.courier&&Object.values(r.reserved).some(n=>n>0));
    p.waitUntil=Date.now()+30000;
    if(Object.keys(missing).length)log('materials_short',{agent:c.id,project:p.name,phase,missing,assigned:r.assigned});
  }
  // ---------- the crafter supplies the builder ----------
  // The crafter reads every active build queue, works out what neither the builder nor the warehouse has
  // (materials.mjs shortages) and how to make it (supplySteps): crafts it from warehouse stock, and when the raw
  // wood is missing too, goes out and fells trees for it (any distance - trees the town has seen, or exploring).
  // The goods go into the warehouse, where the builder picks them up, and the builder is told.
  const SUPPLY_WAIT=Number(process.env.SUPPLY_WAIT_MS??600000);   // how long a builder waits for the crafter
  const label=x=>x.toLowerCase().replace(/_/g,' ');
  /** What builders have asked for (open reservation requests) that the crafter can make now. */
  function supplyDemand(){
    const out=[];
    for(const r of reservations.requests())for(const [item,count] of Object.entries(r.short)){
      if(MINED.has(item))continue;
      // Already there for that builder (a parked project's list is not refreshed): nothing to make - Tink made 37
      // campfires for a tavern that needed one.
      if(reservations.availableFor(r.builder,item,town.stock.items)>=count)continue;
      const plan=supplySteps(item,count,{...town.stock.items});
      if(!Object.keys(plan.short).length)out.push({item,count,for:r.project,builder:r.builder,key:r.key});
    }
    return out;
  }
  /** Orders for the miner: dug materials the requests need (directly, or for something the crafter makes from them). */
  function minerOrders(){
    const out={};
    // The forge's standing orders (skills/supply.mjs): iron or coal running low.
    for(const o of standing().filter(o=>o.role==='miner'))out[o.item]={key:o.key,item:o.item,count:o.count};
    for(const r of reservations.requests())for(const [item,count] of Object.entries(r.short)){
      const plan=supplySteps(item,count,{...town.stock.items});
      for(const [raw,k] of Object.entries(plan.short))if(MINED.has(raw)){const o=out[raw]??={key:r.key,item:raw,count:0};o.count+=k;}
    }
    return Object.values(out);
  }
  /** Can the crafter make this (from stock or by felling trees)? Then a builder short of it waits a while. */
  function crafterCanSupply(item,count){
    if(!byRole('crafter'))return false;
    return !Object.keys(supplySteps(item,count,{...town.stock.items}).short).length;
  }
  async function supplyJob(c,s,self){
    const demand=supplyDemand();
    let job=s.supply;
    // Still wanted? (the builder may have finished, used a stand-in, or someone else stocked it)
    if(job&&!demand.some(x=>x.item===job.item&&x.for===job.for)&&!job.carrying){log('supply_done',{agent:c.id,item:job.item,reason:'no longer needed'});s.supply=job=null;}
    if(!job){
      const next=demand[0];if(!next)return;
      job=s.supply={...next,started:Date.now(),explored:0};
      log('supply_started',{agent:c.id,item:job.item,count:job.count,for:job.for});
      ledger(c.id,`set out to supply ${job.count} ${label(job.item)} for the ${job.for}`);
      await say(c.id,`@${job.builder}: you need ${job.count} ${label(job.item)} for the ${job.for} - I'm on it!`);
    }
    // Time away from the job (night, a festival, a meal) does not count against it.
    if(job.lastTick&&Date.now()-job.lastTick>60000)job.started+=Date.now()-job.lastTick;
    job.lastTick=Date.now();
    const inv=self.inventory??{},pool={...town.stock.items};
    for(const [k,n] of Object.entries(inv))pool[k]=(pool[k]??0)+n;
    // What the warehouse already holds of the item is counted in the shortage (set aside for the builder):
    // the job is to make `count` more, from what the crafter carries plus other stock.
    pool[job.item]=inv[job.item]??0;
    const plan=supplySteps(job.item,job.count,pool);
    const logs=Object.entries(plan.gather);
    // 1. Fell trees until there is enough raw wood (after 15 minutes: bring what there is).
    if(logs.length&&Date.now()-job.started<900000){job.carrying=true;return chopFor(c,job,self,logs[0][0]);}
    // 2. Craft it at the warehouse from stock and what was gathered, then store it there.
    if(!await goToWarehouse(c.id,self))return;
    for(const step of plan.steps)for(const [input,n] of Object.entries(step.inputs)){
      const short=n-(self.inventory?.[input]??0);
      if(short>0&&(town.stock.items[input]??0)>0&&!plan.steps.some(p=>p.item===input))await withdraw(c.id,input,Math.min(short,town.stock.items[input]));
    }
    let made=0;
    if(plan.steps.some(s=>s.how==='craft'))await atCraftingTable(c.id);   // the warehouse crafting table by the door
    for(const step of plan.steps){
      // Fuel for the furnace: coal, else charcoal, planks, logs or sticks from the warehouse (it used to be coal or
      // nothing - the crafter failed to smelt smooth stone again and again with planks on the shelves).
      if(step.how==='smelt'){
        const FUEL=[['COAL',8],['CHARCOAL',8],['OAK_PLANKS',1.5],['SPRUCE_PLANKS',1.5],['BIRCH_PLANKS',1.5],['OAK_LOG',1.5],['SPRUCE_LOG',1.5],['BIRCH_LOG',1.5],['STICK',0.5]];
        const have=FUEL.reduce((n,[k,per])=>n+(self.inventory?.[k]??0)*per,0);
        if(have<step.times){const f=FUEL.find(([k])=>(town.stock.items[k]??0)>0);if(f)await withdraw(c.id,f[0],Math.min(64,Math.ceil((step.times-have)/f[1])));}
      }
      let times=step.times;
      while(times>0){
        const n=Math.min(step.how==='smelt'?64:16,times);
        const r=await act(c.id,step.how==='craft'?{type:'craft',x:0,y:0,z:0,target:step.item,count:n}
          :{type:'smelt',x:0,y:0,z:0,target:Object.keys(step.inputs)[0],count:n}).catch(error=>{log('supply_error',{agent:c.id,item:step.item,message:error.message});return null;});
        if(!r)break;times-=n;
        // The snapshot lags behind a craft: count what was made from the results.
        if(step.item===job.item)made+=step.how==='craft'?(r.times??n)*(recipeFor(job.item)?.out??1):(r.count??n);
      }
    }
    sound(c.id,'block.anvil.use');
    const carried=getSnapshot()?.agents.find(a=>a.id===c.id)?.inventory??{};
    const amount=Math.max(made+(self.inventory?.[job.item]??0),carried[job.item]??0);
    const stored=amount>0?await deposit(c.id,job.item,amount):0;
    log('supply_delivered',{agent:c.id,item:job.item,count:stored,for:job.for,minutes:Math.round((Date.now()-job.started)/60000)});
    if(stored){
      award(c.id,'craft',Math.ceil(stored/4));ledger(c.id,`stocked ${stored} ${label(job.item)} in the warehouse for the ${job.for}`);
      await say(c.id,`@${job.builder}: ${stored} ${label(job.item)} are in the warehouse for the ${job.for}.`);
      const bs=stateOf(job.builder);if(bs?.project)bs.project.waitUntil=0;
    }
    // Leftover logs and planks go to the warehouse too, so the next job can use them.
    for(const [k,n] of Object.entries(carried))if(n>0&&k!==job.item&&/_LOG$|_PLANKS$/.test(k))await deposit(c.id,k,n);
    s.supply=null;
  }
  /** Fell trees of `kind` (e.g. SPRUCE_LOG): nearest in sight, else trees the town remembers, else explore outward. */
  async function chopFor(c,job,self,kind){
    if(self.pathing||['moving','loading'].includes(self.navigation?.status))return;
    const all=await act(c.id,{type:'find',x:0,y:0,z:0,target:kind,count:24}).catch(()=>[]);
    // Only real trees: logs with leaves around the top of the trunk. Logs in buildings (a warehouse corner post,
    // a player's cabin) are never cut, and are remembered as not-a-tree.
    town.notTrees??={};
    let t=null,checks=0,unchecked=false;
    for(const l of all??[]){
      const key=`${l.x},${l.z}`;if(town.notTrees[key]||job.skip?.[key]||(t&&t.x===l.x&&t.z===l.z))continue;
      if(job.trees?.[key]){t=l;break;}
      const top=Math.max(...all.filter(o=>o.x===l.x&&o.z===l.z).map(o=>o.y));
      const crown=await act(c.id,{type:'scan',x:l.x-2,y:top-1,z:l.z-2,width:5,height:5,depth:5}).catch(()=>null);
      if(crown?.cells?.some(cell=>/_LEAVES$/.test(cell[3]))){(job.trees??={})[key]=true;t=l;break;}
      town.notTrees[key]=Date.now();log('supply_not_tree',{agent:c.id,kind,x:l.x,y:l.y,z:l.z});
      if(++checks>=4){unchecked=true;break;}   // a few checks per tick; the rest next time
    }
    if(!t&&unchecked)return;
    const found=t?(all??[]).filter(l=>(l.x===t.x&&l.z===t.z)||job.trees?.[`${l.x},${l.z}`]):[];
    if(t){
      const trunk=found.filter(l=>l.x===t.x&&l.z===t.z),base=Math.min(...trunk.map(l=>l.y));
      const reachable=found.filter(l=>Math.hypot(l.x+0.5-self.x,l.y+0.5-self.y,l.z+0.5-self.z)<=5.5);
      if(!reachable.length){
        // A tree that cannot be reached after a few tries (logs left hanging, a cliff) is left alone.
        if(Date.now()-(job.walkAt??0)<5000)return;   // let the last walk get going
        job.walkAt=Date.now();
        const key=`${t.x},${t.z}`;job.walkTries??={};
        if((job.walkTries[key]=(job.walkTries[key]??0)+1)>6){(job.skip??={})[key]=true;log('supply_tree_skipped',{agent:c.id,kind,x:t.x,z:t.z});return;}
        // Stand beside the trunk; when that spot is blocked (leaves, bushes), try the other sides, then 2 out.
        const SIDES=[[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2],[2,2],[-2,-2]];
        const [sx,sz]=SIDES[(job.side??=0)%SIDES.length];
        // Stand on the ground: when the lower trunk is already cut the remaining logs hang in the air.
        const r=await travel(c.id,self,{x:t.x+sx+0.5,y:base>self.y+1?Math.round(self.y):base,z:t.z+sz+0.5}).catch(error=>({error:error.message}));
        if(r?.error)job.side++;
        if(ready(`chop-walk:${c.id}`,30000))log('supply_walk',{agent:c.id,kind,tree:{x:t.x,y:base,z:t.z},at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)},result:JSON.stringify(r)?.slice(0,140)});
        return;
      }
      await act(c.id,{type:'equip',x:0,y:0,z:0,target:'IRON_AXE'}).catch(()=>act(c.id,{type:'equip',x:0,y:0,z:0,target:'STONE_AXE'}).catch(()=>{}));
      let cut=0;
      for(const l of reachable.slice(0,8)){
        if(await act(c.id,{type:'mine',x:l.x,y:l.y,z:l.z}).then(()=>true).catch(()=>false))cut++;
      }
      if(cut){job.cut=(job.cut??0)+cut;sound(c.id,'block.wood.break');if(ready(`chop-log:${c.id}`,60000))log('supply_chopping',{agent:c.id,kind,cut:job.cut,at:{x:t.x,z:t.z}});}
      return;
    }
    // Nothing in sight: the nearest tree of that kind the town has seen.
    const mem=intel()?.spatial.query(c.id,kind,1,null,{from:self,category:'tree'})[0];
    if(ready(`chop-trace:${c.id}`,30000))log('supply_search',{agent:c.id,kind,at:{x:Math.round(self.x),z:Math.round(self.z)},memory:mem?{item:mem.item,x:mem.x,z:mem.z}:null,explored:job.explored});
    if(mem&&mem.item===kind){
      if(Math.hypot(self.x-mem.x,self.z-mem.z)>8){await travel(c.id,self,{x:mem.x+1.5,y:mem.y,z:mem.z+0.5}).catch(()=>{});return;}
      intel().spatial.markStale(mem.memory_id);return;   // felled or never there
    }
    // Explore: rings around town, 40 blocks apart, eight points each.
    const ring=1+Math.floor(job.explored/8),angle=(job.explored%8)*Math.PI/4;
    const spot={x:SQUARE.x+Math.cos(angle)*40*ring,z:SQUARE.z+Math.sin(angle)*40*ring};
    if(Math.hypot(self.x-spot.x,self.z-spot.z)>10){await travel(c.id,self,{...spot,y:Math.round(self.y)}).catch(()=>{});return;}
    job.explored++;
    if(job.explored>=32){log('supply_failed',{agent:c.id,item:job.item,reason:`no ${label(kind)} found`});job.started=0;}
  }

  // ---------- keeping the town whole: repairs after creepers, fire and mobs ----------
  // The plugin remembers every town block an explosion, fire or a mob destroys (damage.json). Citizens put them back:
  // a building's blocks exactly as they were (a hole in a wall is a danger at night), blown-out ground with dirt so it
  // is level again. The builder leads; one free citizen nearby helps.
  town.damage??={sites:[]};
  let repairList=[],lastDamagePoll=0;
  const anyOnline=()=>{const snap=getSnapshot();return (snap?.agents.find(a=>roleOf(configs.find(c=>c.id===a.id)??{id:''})==='builder')??snap?.agents[0])?.id;};
  // ---------- terrain: craters the plugin never saw (skills/terrain.mjs) ----------
  const TERRAIN_BOX={x1:226,z1:50,x2:330,z2:170};   // the zones and a margin (the craters east of the village street)
  const T=town.terrain??={next:0,fills:[],found:0,filled:0,playerEdits:{}};
  /** A player broke ground here: leave this column alone for a day (a pond or cellar, not a crater). */
  function notePlayerEdit(x,z){T.playerEdits[`${x},${z}`]=Date.now();}
  const noTouch=(x,z)=>{
    const t=T.playerEdits[`${x},${z}`];if(t&&Date.now()-t<86400000)return true;
    if(x>=252&&x<=268&&z>=104&&z<=120)return true;                               // the mine entrance and its staircase
    if(Math.hypot(x-276,z-83)<=13)return true;                                   // the clay pit
    return false;
  };
  let lastTerrain=0;
  async function sweepTerrain(){
    if(Date.now()-lastTerrain<30000)return;lastTerrain=Date.now();
    const id=anyOnline();if(!id)return;
    const tiles=tilesOf(TERRAIN_BOX),tile=tiles[T.next%tiles.length];T.next=(T.next+1)%tiles.length;
    const sv=await act(id,{type:'survey',x:tile.x,y:0,z:tile.z,width:16,depth:16}).catch(()=>null);if(!sv?.heights)return;
    const pits=findPits(sv,{skip:noTouch});if(!pits.length)return;
    const have=new Set(T.fills.map(f=>`${f.x},${f.y},${f.z}`)),fresh=fillsFor(pits).filter(f=>!have.has(`${f.x},${f.y},${f.z}`));
    if(!fresh.length)return;
    T.fills=[...T.fills,...fresh].slice(-300);T.found+=pits.length;
    const c=pits.reduce((a,p)=>({x:a.x+p.x/pits.length,z:a.z+p.z/pits.length}),{x:0,z:0});
    log('crater_found',{x:Math.round(c.x),z:Math.round(c.z),columns:pits.length,blocks:fresh.length,deepest:Math.max(...pits.map(p=>p.level-p.top))});
    ledger(byRole('governor')?.id??'town',`a crater was found near ${Math.round(c.x)},${Math.round(c.z)} (${fresh.length} blocks of ground missing); the repair crew will fill it level`);
    lastDamagePoll=0;
  }
  async function pollDamage(){
    const id=anyOnline();if(!id)return;lastDamagePoll=Date.now();
    const r=await act(id,{type:'damages',x:0,y:0,z:0}).catch(()=>null);if(!r)return;
    repairList=(r.blocks??[]).map(([x,y,z,block,natural,cost])=>({x,y,z,block,natural,cost})).filter(b=>b.y>=56&&!(town.damage.skip??{})[`${b.x},${b.z}`]);
    // Craters from the sweep: filled with dirt by the same crew (TERRAIN_REPAIR).
    repairList.push(...T.fills.filter(f=>!(town.damage.skip??{})[`${f.x},${f.z}`]&&!noTouch(f.x,f.z)).map(f=>({...f,block:'DIRT',natural:true,cost:'DIRT',fill:true})));
    // Furnishing a house that lacks its bed (main.mjs goToBed): placed by the same crew.
    repairList.push(...(town.damage.furnish??[]).map(f=>({...f,natural:false,cost:f.sign?null:f.block,place:!f.sign})));
    town.damage.open=repairList.length;
  }
  // One-time: a bed requested on a roof (before the floor check) is dropped with its 'unreachable' mark; the
  // citizen asks again at bedtime from inside the house.
  // Again (v2): a bed asked for on a roof before the house floor was measured.
  if(!town.damage.furnishFixV2){town.damage.furnishFixV2=true;for(const f of (town.damage.furnish??[]).filter(f=>/_BED$/.test(f.block??'')&&!/^fisher/.test(f.for??'')))delete (town.damage.skip??{})[`${f.x},${f.z}`];town.damage.furnish=(town.damage.furnish??[]).filter(f=>!(/_BED$/.test(f.block??'')&&!/^fisher/.test(f.for??'')));delete (town.damage.skip??{})['295,129'];}
  if(!town.damage.furnishFixV1){town.damage.furnishFixV1=true;
    for(const f of (town.damage.furnish??[]).filter(f=>f.for!=='town_hall'))delete (town.damage.skip??{})[`${f.x},${f.z}`];
    town.damage.furnish=(town.damage.furnish??[]).filter(f=>f.for==='town_hall');}
  /** A house without its bed: the repair crew (Bram first) brings and places one (the bed item comes from the warehouse). */
  // One-time: the queued doors, walls and signs were all marked unreachable by those retries - cleared.
  if(!town.furnishResetV1){town.furnishResetV1=true;for(const f of town.damage?.furnish??[]){const k=`${f.x},${f.z}`;if(town.damage.walks)delete town.damage.walks[k];if(town.damage.skip)delete town.damage.skip[k];}}
  function requestFurnish(item){
    // A home's bed: a newer request replaces an older one for the same citizen (an earlier one may have been wrong).
    if(item.for&&/_BED$/.test(item.block??''))town.damage.furnish=(town.damage.furnish??[]).filter(f=>!(f.for===item.for&&/_BED$/.test(f.block??'')));
    const list=town.damage.furnish??=[];
    if(list.some(f=>f.x===item.x&&f.y===item.y&&f.z===item.z))return false;
    // A fresh request gets a fresh start: the spot's walk count and any 'unreachable' mark are cleared (the door spots
    // were marked unreachable after 1,200 retries while spruce doors were not yet an allowed material).
    {const k=`${item.x},${item.z}`;if(town.damage.walks)delete town.damage.walks[k];if(town.damage.skip)delete town.damage.skip[k];}
    list.push({...item,at:Date.now()});lastDamagePoll=0;if(!item.quiet)log('furnish_requested',item);return true;
  }
  function onDamage(data){
    const site={x:data.x,y:data.y,z:data.z,cause:data.cause,built:data.built,ground:data.ground,at:Date.now()};
    town.damage.sites=[...town.damage.sites,site].slice(-20);lastDamagePoll=0;
    log('town_damaged',site);
    const snap=getSnapshot(),near=snap?.agents.filter(a=>configs.some(c=>c.id===a.id)&&a.id!=='visitor').sort((a,b)=>Math.hypot(a.x-data.x,a.z-data.z)-Math.hypot(b.x-data.x,b.z-data.z))[0];
    const by=/CREEPER/.test(data.cause)?'A creeper':data.cause==='fire'?'Fire':/ENDERMAN/.test(data.cause)?'An enderman':/TNT/.test(data.cause)?'An explosion':'Something';
    const what=data.built?'a hole in one of our buildings':'a crater in the ground';
    if(near&&Math.hypot(near.x-data.x,near.z-data.z)<64&&ready('damage-say',45000))
      say(near.id,`${by} just ${data.cause==='fire'?'burned':'blew'} ${what} near ${data.x},${data.z}! We'll fix it${data.built?' - we can\'t leave a wall open at night':', I\'ll fill it in level'}.`);
    ledger(near?.id??'governor',`saw ${by.toLowerCase()} damage ${what} near ${data.x},${data.z}`);
  }
  /** Who repairs: the builder (any damage), plus one free citizen for the nearest site. Never the guardian. */
  function repairCrew(c,s,self){
    // Not the guard, the miner (his day is the mine) or the essential workers at their posts.
    if(!repairList.length||['guardian','miner','merchant','clerk','chef','banker','herbalist'].includes(roleOf(c))||s.resting)return false;
    if(roleOf(c)==='builder')return !s.project;
    if(s.project||s.dig||s.supply||s.errand||s.order||s.angler?.trip)return town.damage.helper===c.id&&Date.now()-(town.damage.helperAt??0)<300000;
    const helper=town.damage.helper;
    if((town.policy?.repairAllUntil??0)>Date.now())return true;   // a voted repair drive: every free hand
    if(helper&&helper!==c.id&&Date.now()-(town.damage.helperAt??0)<300000)return false;
    town.damage.helper=c.id;town.damage.helperAt=Date.now();return true;
  }
  async function repairJob(c,s,self){
    if(self.pathing||['moving','loading'].includes(self.navigation?.status))return;
    if(town.damage.helper===c.id)town.damage.helperAt=Date.now();
    // The nearest damaged spot and everything within 8 blocks of it.
    const first=repairList.reduce((a,b)=>Math.hypot(a.x-self.x,a.z-self.z)<=Math.hypot(b.x-self.x,b.z-self.z)?a:b);
    const site=repairList.filter(b=>Math.hypot(b.x-first.x,b.z-first.z)<=8);
    // Materials first: what the job uses up that the citizen does not carry, from the warehouse. What the warehouse
    // does not have is repaired anyway (safety comes before the books).
    const need={};for(const b of site)if(b.cost)need[b.cost]=(need[b.cost]??0)+1;
    const missing=Object.entries(need).map(([k,n])=>[k,n-(self.inventory?.[k]??0)]).filter(([k,n])=>n>0&&!(s.repairFree??{})[k]);
    if(missing.length&&town.built.warehouse){
      if(!await goToWarehouse(c.id,self))return;
      for(const [k,n] of missing){const got=await withdraw(c.id,k,Math.min(128,n));if(got<n)(s.repairFree??={})[k]=true;}
      return;
    }
    const inReach=site.filter(b=>Math.hypot(b.x+0.5-self.x,b.y+0.5-self.y,b.z+0.5-self.z)<=8).sort((a,b)=>a.y-b.y);
    if(!inReach.length){const k=`${first.x},${first.z}`,w=town.damage.walks??={};w[k]=(w[k]??0)+1;
      if(w[k]>40){(town.damage.skip??={})[k]=Date.now();repairList=repairList.filter(b=>Math.hypot(b.x-first.x,b.z-first.z)>8);log('repair_unreachable',{agent:c.id,x:first.x,y:first.y,z:first.z});return;}}
    if(!inReach.length&&ready(`repair-walk:${c.id}`,30000))log('repair_walk',{agent:c.id,to:{x:first.x,y:first.y,z:first.z},at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)},open:repairList.length});
    if(!inReach.length){
      // Walk to the rim of the damage, on the side facing the citizen.
      const top=Math.max(...site.map(b=>b.y));
      const dx=self.x-first.x,dz=self.z-first.z,len=Math.hypot(dx,dz)||1;
      await travel(c.id,self,{x:Math.floor(first.x+dx/len*3)+0.5,y:top+1,z:Math.floor(first.z+dz/len*3)+0.5}).catch(()=>{});
      return;
    }
    let fixed=0,underfoot=0;
    for(const b of inReach.slice(0,12)){
      // A crater from the sweep is filled with dirt (place); plugin-recorded damage is put back exactly (repair).
      const r=await act(c.id,b.sign?{type:'sign',x:b.x,y:b.y,z:b.z,target:b.block,facing:b.facing,text:b.text}:b.place?{type:'place',x:b.x,y:b.y,z:b.z,target:b.block,facing:b.facing??'SOUTH',...((s.repairFree??{})[b.cost]?{free:true}:{})}:b.fill?{type:'place',x:b.x,y:b.y,z:b.z,target:'DIRT',...((s.repairFree??{}).DIRT?{free:true}:{})}:{type:'repair',x:b.x,y:b.y,z:b.z,...((s.repairFree??{})[b.cost]?{free:true}:{})}).then(()=>'ok').catch(error=>error.message);
      const done=r==='ok'||/Nothing to repair/.test(r)||((b.fill||b.place)&&/occupied/i.test(r));
      if(done&&(b.place||b.sign)){town.damage.furnish=(town.damage.furnish??[]).filter(f=>!(f.x===b.x&&f.y===b.y&&f.z===b.z));if(r==='ok')log('furnished',{agent:c.id,block:b.block,at:[b.x,b.y,b.z],for:b.for});}
      if(done){repairList.splice(repairList.indexOf(b),1);if(b.fill){T.fills=T.fills.filter(f=>!(f.x===b.x&&f.y===b.y&&f.z===b.z));if(r==='ok')T.filled++;}if(r==='ok')fixed++;}
      else if(/standing there/.test(r))underfoot++;
      if(r!=='ok'&&ready(`repair-fail:${c.id}`,30000))log('repair_failed',{agent:c.id,block:b,at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)},error:r});
      else if(/^Out of /.test(r)){(s.repairFree??={})[b.cost]=!town.built.warehouse||(town.stock.items[b.cost]??0)===0;break;}
    }
    if(fixed){
      award(c.id,'place',fixed);sound(c.id,'block.stone.place');
      town.damage.repaired=(town.damage.repaired??0)+fixed;
      if(!repairList.some(b=>Math.hypot(b.x-first.x,b.z-first.z)<=8)){
        const ground=site.every(b=>b.natural);
        ledger(c.id,`${ground?'filled in the crater':'repaired the damaged building'} near ${first.x},${first.z}`);
        log('town_repaired',{agent:c.id,x:first.x,z:first.z,blocks:site.length});
        if(ready(`repair-say:${c.id}`,120000))await say(c.id,ground?`Filled in that crater near ${first.x},${first.z} - nice and level again.`:`The wall near ${first.x},${first.z} is patched up. Safe and sound.`);
        s.repairFree={};
      }
    }
    // Standing on the last damaged blocks: step out to the rim so they can be filled too.
    if(!fixed&&underfoot){const top=Math.max(...site.map(b=>b.y));await travel(c.id,self,{x:Math.floor(first.x)+3.5,y:top+1,z:Math.floor(first.z)+0.5}).catch(()=>{});}
  }

  // ---------- lamplighting: no dark ground in town for monsters to spawn on ----------
  // Hostile mobs spawn where no block light reaches. The guardian (between threats, in daylight) and the scout light
  // the dark ground in town with torches, nearest to the square first; the plugin lists the dark spots.
  let darkSpots=[],lastDarkPoll=0;
  async function pollDark(id){
    lastDarkPoll=Date.now();
    const r=await act(id,{type:'darkspots',x:0,y:0,z:0,count:Math.min(112,(town.area?.radius??64)+8)}).catch(()=>null);
    // Never inside a building that is still going up (or being finished): a torch on its floor took the spot of the
    // last floor tile, and the courthouse and infirmary each stood one block short for hours.
    if(Array.isArray(r)){darkSpots=r.filter(p=>!inUnfinished(p.x,p.z)&&[...ROAD_COLS].some(k=>{const [x,z]=k.split(',').map(Number);return Math.hypot(x-p.x,z-p.z)<=4;}));town.darkSpots=darkSpots.length;}
  }
  function inUnfinished(x,z){
    for(const [k,at] of Object.entries(town.sites??{})){
      if(!SITES[k]||(town.built[k]&&!(town.finishing??{})[k]))continue;
      let fp;try{fp=siteFootprint(SITES[k],at.x,at.z);}catch{continue;}
      if(x>=fp.x1-1&&x<=fp.x2+1&&z>=fp.z1-1&&z<=fp.z2+1)return true;
    }
    return false;
  }
  function lightingWanted(c,s,self){
    const drive=(town.policy?.lightingUntil??0)>Date.now();
    if(!(['guardian','scout'].includes(roleOf(c))||drive&&['courier','herbalist','merchant'].includes(roleOf(c)))||s.resting||s.project||s.dig)return false;
    if(dayPhase(getSnapshot()?.worldTime)==='night')return false;
    if(roleOf(c)==='guardian'&&(self.entities??[]).some(e=>d.HOSTILE.has(e.type)))return false;
    if(roleOf(c)==='guardian'&&c.protect&&playerByName(c.protect))return false;   // escorting the player comes first
    return (town.lampPosts??[]).some(p=>p.owner===c.id&&(p.status==='building'||p.status==='blocked'&&!(p.retryAt>Date.now())))||Date.now()-lastDarkPoll>600000||darkSpots.length>0;
  }
  async function lightingJob(c,s,self){
    if(self.pathing||['moving','loading'].includes(self.navigation?.status))return;
    town.lampPosts??=[];
    const active=town.lampPosts.find(p=>p.owner===c.id&&(p.status==='building'||p.status==='blocked'&&!(p.retryAt>Date.now())));
    if(active){
      const b=active.plan[active.cursor??0];
      if(!b){active.status='completed';town.lightsPlaced=(town.lightsPlaced??0)+2;ledger(c.id,`completed a street lamp post at ${active.x}, ${active.z}`);return;}
      const current=await act(c.id,{type:'scan',x:b.x,y:b.y,z:b.z,width:1,height:1,depth:1}).catch(()=>null);
      if(!Array.isArray(current?.cells))return;
      const existing=current.cells[0]?.[3];
      if(existing===b.block){active.cursor++;return;}
      if(existing&&!['SHORT_GRASS','TALL_GRASS'].includes(existing)){active.status='blocked';active.retryAt=Date.now()+60000;active.note='Placement occupied; preserve the existing block.';return;}
      active.status='building';delete active.note;
      if(!(self.inventory?.[b.block]>0)){
        if(await goToWarehouse(c.id,self))await withdraw(c.id,b.block,active.plan.slice(active.cursor).filter(p=>p.block===b.block).length);
        return;
      }
      if(Math.hypot(b.x+0.5-self.x,b.y-self.y,b.z+0.5-self.z)>7){await travel(c.id,self,{x:active.x+2.5,y:active.y,z:active.z+0.5}).catch(()=>{});return;}
      await act(c.id,{type:'place',x:b.x,y:b.y,z:b.z,target:b.block,hanging:!!b.hanging});
      active.cursor++;award(c.id,'place',1);return;
    }
    if(Date.now()-lastDarkPoll>600000||(!darkSpots.length&&Date.now()-lastDarkPoll>120000))await pollDark(c.id);
    if(!darkSpots.length)return;
    let candidate=darkSpots.shift();
    const inspected=await act(c.id,{type:'scan',x:candidate.x-2,y:candidate.y-1,z:candidate.z-2,width:5,height:7,depth:5}).catch(()=>null);
    if(!lampSiteSafe(candidate,inspected?.cells,town.lampPosts,ROAD_COLS))candidate={...candidate,axis:'z'};
    if(!lampSiteSafe(candidate,inspected?.cells,town.lampPosts,ROAD_COLS))return;
    town.lampPosts.push({...candidate,owner:c.id,status:'building',cursor:0,plan:lampPlan(candidate)});
    darkSpots=darkSpots.filter(p=>Math.hypot(p.x-candidate.x,p.z-candidate.z)>=10);

  }

  // ---------- the proposal engine: fresh, relevant topics for every meeting (skills/proposals.mjs) ----------
  const proposalHistory=()=>memory.data.proposal_history??=[];
  /** The town's state, as the proposal engine reads it. */
  function proposalContext(){
    const nameOf=id=>(configs.find(c=>c.id===id)?.name??id).split(' ')[0];
    const stock=town.stock.items,builder=byRole('builder'),bq=builder?stateOf(builder.id)?.project?.queue??[]:[];
    const need={};for(const b of bq)if(!b.clear)need[b.block]=(need[b.block]??0)+1;
    const shortages=Object.entries(need).filter(([k,n])=>(stock[k]??0)<Math.min(n,16)).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
    const affects=configs.filter(c=>c.id!=='visitor').map(c=>d.affectOf?.(c.id)).filter(Boolean);
    const avg=k=>affects.length?Math.round(affects.reduce((s,a)=>s+(a[k]??50),0)/affects.length):50;
    const faithView=d.faith?.()?.view?.();
    const census=faithView?.census??{},believers=Object.entries(census).filter(([k])=>k!=='no faith').reduce((s,[,n])=>s+n,0);
    const largest=Object.entries(census).filter(([k])=>k!=='no faith').sort((a,b)=>b[1]-a[1])[0]?.[0];
    const meals=(town.diet?.meals??[]).slice(-60),diet=meals.length>=8?dietStats(meals):null;
    return {
      day:town.day,pantryStatus:pantryStatus(),treasury:stock.EMERALD??0,shortages,
      pendingBuilds:town.unlocked.filter(id=>!town.built[id]&&SITES[id]&&!town.plan.funded.includes(`site:${id}`)&&!(town.requests??[]).includes(id)).map(id=>({id,name:siteName(id)})),
      threats:(town.weekThreats??0),darkSpots:town.darkSpots??0,damageOpen:repairList.length,
      avgMorale:avg('morale'),avgStress:avg('stress'),
      daysSinceFestival:town.lastFestivalDay!=null?town.day-town.lastFestivalDay:9,
      conflicts:town.conflicts.filter(x=>!x.resolved).map(x=>({...x,aName:nameOf(x.a),bName:nameOf(x.b)})),
      dietVariety:diet?.score??null,fatigued:diet?.fatigued??[],
      faith:{believers,largest:largest??'faith',skeptics:census['no faith']??0},shrineBuilt:!!town.built.shrine,
      hasPark:town.zones.some(z=>z.kind==='park'&&z.status==='adopted'),hasLake:!!byRole('fisher'),marketActive:!!town.market||isMarketDay(town.day),
      policy:town.policy??{},
    };
  }
  /** Puts one fresh proposal to the town (at a council or the morning meeting). Returns it, or null. */
  async function tableProposal(occasion){
    const charter=memory.data.charter;
    if(charter.proposals.some(p=>p.generated))return null;   // one at a time
    const ctx=proposalContext(),pick=chooseProposal(ctx,{history:proposalHistory(),open:charter.proposals});
    if(!pick)return null;
    // The governor words it (the model, at a lively temperature); the plain wording stands in when it is offline.
    let words={title:pick.title,description:pick.description,pros:pick.pros,cons:pick.cons};
    try{
      const raw=await lm.callUtilityTask('proposal_writing','You write one proposal for a Minecraft village meeting. Keep the facts and numbers in the draft; make it vivid and specific, in the voice of a town governor. Reply with JSON only: {"title": "...", "description": "one or two sentences", "pros": ["..."], "cons": ["..."]}.',
        {draft:words,domain:pick.domain,town:{day:ctx.day,pantry:ctx.pantryStatus,treasury:ctx.treasury,morale:ctx.avgMorale,stress:ctx.avgStress}},{opts:{temperature:0.9,presence_penalty:0.4}});
      const j=JSON.parse(String(raw).replace(/^[^{]*/,'').replace(/[^}]*$/,''));
      if(j.title&&j.description)words={title:String(j.title).slice(0,90),description:String(j.description).slice(0,300),pros:(j.pros??words.pros).slice(0,3).map(String),cons:(j.cons??words.cons).slice(0,3).map(String)};
    }catch{}
    const gov=governorOf()??configs[0];
    const p={id:String(charter.next++),by:gov.id,generated:true,occasion,key:pick.key,topic:pick.topic,domain:pick.domain,effect:pick.effect,
      title:words.title,description:words.description,pros:words.pros,cons:words.cons,text:`${words.title}: ${words.description}`,
      votes:{},reasons:{},time:Date.now(),closesAt:Date.now()+180000};
    // Every citizen weighs it by its own values, role, faith and mood.
    for(const c of configs.filter(x=>x.id!=='visitor')){
      const a=d.affectOf?.(c.id)??{},prof=d.faith?.()?.profileOf?.(c.id);
      const v=voteProposal(p,{id:c.id,role:roleOf(c),values:d.valuesOf?.(c.id)??{},faith:prof?.religion?.deity_or_faith??null,morale:a.morale,stress:a.stress,irritable:!!d.moodOf?.(c.id)?.irritable});
      p.votes[c.id]=v.vote;p.reasons[c.id]=v.why;
    }
    charter.proposals.push(p);
    const yes=Object.values(p.votes).filter(v=>v==='yes').length,no=Object.values(p.votes).length-yes;
    log('proposal_tabled',{id:p.id,occasion,domain:p.domain,topic:p.topic,title:p.title,yes,no});
    ledger(gov.id,`put proposal #${p.id} (${p.domain.toLowerCase()}) to the town: ${p.title}`);
    await say(gov.id,`Proposal #${p.id} - ${p.title}. ${p.description} (${yes} for, ${no} against so far.) Mayor, have your say: /sid vote ${p.id} yes|no`);
    return p;
  }
  /** What an adopted proposal does, and what every decision is remembered as. */
  async function proposalResolved(p,adopted){
    const yes=Object.values(p.votes).filter(v=>v==='yes').length,no=Object.values(p.votes).length-yes;
    memory.data.proposal_history=rememberProposal(proposalHistory(),{...p,yes,no},adopted?'adopted':'rejected',town.day);
    // Winning or losing a vote is felt, a little.
    for(const [id,v] of Object.entries(p.votes))d.feel?.(id,(v==='yes')===adopted?'small_success':'failure',0.5);
    log('proposal_decided',{id:p.id,topic:p.topic,domain:p.domain,adopted,yes,no});
    const gov=governorOf()??configs[0];
    if(!adopted){await say(gov.id,`Proposal #${p.id} (${p.title}) did not pass, ${yes} to ${no}.`).catch(()=>{});return;}
    const e=p.effect??{},policy=town.policy??={};
    let done='';
    switch(e.type){
      case 'fund_build':await requestBuild(e.site,nameOf(gov.id)).catch(()=>{});done=`the ${e.name} is next for the builder`;break;
      case 'quest_drive':for(const item of e.items??[])await postQuest(gov.id,item,32,`town drive: ${p.title}`).catch(()=>{});done=`a bounty is out for ${(e.items??[]).map(x=>x.toLowerCase().replace(/_/g,' ')).join(', ')}`;break;
      case 'wages':policy.wageMultiplier=e.multiplier;done=`wages are now ${e.multiplier}x`;break;
      case 'market_fee':policy.marketFee=e.rate;done=`a ${Math.round(e.rate*100)}% market fee goes to the treasury`;break;
      case 'food_first':town.emergency={until:town.day+2};town.prices=null;updatePrices();done='food comes first for two days, with higher food prices';break;
      case 'curfew':policy.curfew=e.mode;done=e.mode==='always'?'the curfew bell rings every evening':'the curfew bell rings only when danger is near';break;
      case 'lighting':policy.lightingUntil=Date.now()+2*3600000;lastDarkPoll=0;done='everyone free lends a hand lighting the dark corners';break;
      case 'repairs':policy.repairAllUntil=Date.now()+3600000;done='every free hand helps with the repairs';break;
      case 'festival':case 'gathering':town.festival=null;scheduleFestival(e.kind??e.name,p.title,null);done=`a ${e.kind??e.name} is planned`;break;
      case 'holy_day':town.festival=null;scheduleFestival(`${e.faith} holy day`,p.title,town.built.shrine?SITES.shrine:null);policy.restDay=town.day+1;policy.holyFrom??=town.day+1;done='a holy day of rest and prayer';break;   // weekly from then on (skills/rest.mjs)
      case 'mediate':{const k=town.conflicts.find(x=>!x.resolved&&x.a===e.a&&x.b===e.b);if(k){k.resolved=true;k.resolution='settled by town vote';befriend(e.a,e.b,2);}done='the quarrel is settled';break;}
      case 'variety':policy.varietyUntil=Date.now()+2*3600000;done='the chef experiments with new dishes';break;
      case 'park':{const x1=Math.floor(SQUARE.x)-14,z1=Math.floor(SQUARE.z)+6;town.zones.push({id:`park-${p.id}`,name:'Town park',kind:'park',x1,z1,x2:x1+8,z2:z1+8,status:'adopted',by:gov.id});done='the ground beside the square is a park now';break;}
      case 'rest_day':policy.restDay=town.day+1;done='tomorrow is a day of rest';break;
      case 'policy':policy[e.key]=e.value;break;
    }
    // Lasting policies join the settlement's rules; one-off decisions do not.
    if(['wages','market_fee','curfew','policy','park'].includes(e.type)){memory.data.charter.rules.push({id:p.id,text:p.text,by:p.by,time:Date.now()});memory.data.charter.rules=memory.data.charter.rules.slice(-20);}
    ledger(gov.id,`proposal #${p.id} adopted (${yes}-${no}): ${p.title}${done?` - ${done}`:''}`);
    await say(gov.id,`Proposal #${p.id} passed, ${yes} to ${no}: ${p.title}.${done?` ${done[0].toUpperCase()+done.slice(1)}.`:''}`).catch(()=>{});
  }
  const nameOf=id=>(configs.find(c=>c.id===id)?.name??id).split(' ')[0];

  // ---------- logistics reflexes ----------
  /** Carry-limit drop-off: wheat, seeds, ore, logs and cooked food over the limits go to the warehouse. */
  async function dropOffJob(c,s,self){
    let load=dropOffItems(self.inventory,roleOf(c));if(!load.length)return;
    if(!await goToWarehouse(c.id,self))return;
    // Bread fetches a high price: the farmer bakes part of the wheat before handing it in.
    if(roleOf(c)==='farmer'&&scarceFood(prices()).includes('BREAD')&&(self.inventory?.WHEAT??0)>=9){
      const times=Math.min(16,Math.floor((self.inventory.WHEAT-8)/3));
      if(times>0&&await act(c.id,{type:'craft',x:0,y:0,z:0,target:'BREAD',count:times}).then(()=>true).catch(()=>false)){
        log('baked',{agent:c.id,bread:times,reason:'bread price'});
        const inv={...self.inventory,WHEAT:self.inventory.WHEAT-times*3,BREAD:(self.inventory.BREAD??0)+times};
        load=dropOffItems(inv,roleOf(c));if(!load.some(([k])=>k==='BREAD'))load.push(['BREAD',times]);
      }
    }
    const moved={};
    for(const [item,n] of load){const got=await deposit(c.id,item,n);if(got)moved[item]=got;}
    if(Object.keys(moved).length)ledger(c.id,`dropped off ${Object.entries(moved).map(([k,v])=>`${v} ${k.toLowerCase().replace(/_/g,' ')}`).join(', ')} at the warehouse`);
  }
  // The courier (Barnaby the Runner; Marlo or Wren stand in when there is none) feeds the starving,
  // runs quest deliveries and patrols the farm, the dock and the mine, carrying goods to the pantry.
  function courierId(){
    const runner=byRole('courier');
    if(runner&&!stateOf(runner.id)?.resting&&!stateOf(runner.id)?.order)return runner.id;
    const merchant=byRole('merchant'),scout=byRole('scout');
    const busy=id=>{const st=stateOf(id);return !id||st?.resting||st?.order||st?.helping?.day===town.day||town.market?.day===town.day&&id===merchant?.id;};
    // Marlo no longer stands in: his day is the market hall.
    return scout&&!busy(scout.id)?scout.id:null;
  }
  const PICKUP=/^(WHEAT|CARROT|POTATO|BEETROOT|BREAD|BAKED_POTATO|COOKED_COD|COOKED_SALMON|SWEET_BERRIES|APPLE|MUSHROOM_STEW|EGG|SUGAR_CANE|PUMPKIN|RAW_IRON|RAW_COPPER|RAW_GOLD|COAL|REDSTONE|LAPIS_LAZULI|DIAMOND|COBBLESTONE|COBBLED_DEEPSLATE|[A-Z_]+_LOG)$/;
  /** What the courier takes from a producer on its rounds: raw goods beyond what they keep for themselves. */
  const pickupOf=(c,inventory)=>surplusOf(c,inventory).filter(([k,n])=>PICKUP.test(k)&&n>=(FOOD_ITEMS.has(k)?6:k==='COBBLESTONE'||k==='COBBLED_DEEPSLATE'?32:4));
  function patrolStops(snap){
    // Producers at work above ground (the miner only when it is near the surface, at the mine entrance).
    return ['farmer','fisher','miner'].map(byRole).filter(Boolean).map(c=>({id:c.id,a:snap.agents.find(a=>a.id===c.id)}))
      .filter(x=>x.a&&x.a.y>=58&&!stateOf(x.id)?.angler?.trip&&!stateOf(x.id)?.resting);
  }
  /** The forge's and the warehouse's standing orders right now (skills/supply.mjs). */
  const standing=()=>{const sm=byRole('smith'),me=sm&&getSnapshot()?.agents.find(a=>a.id===sm.id);return standingOrders({smith:me?.inventory??{},stock:town.stock.items});};
  /** Clear-out: the warehouse holds more of something than its cap - the courier takes a load to the market stall. */
  function clearoutErrand(){
    const sur=surplusOf(town.stock.items),merchant=byRole('merchant');
    if(shopReady('merchant')||shopReady('chef'))return sur.length||Object.values(town.marketQueue??{}).some(n=>n>0)?{kind:'clearout',load:null}:null;
    return sur.length&&merchant?{kind:'clearout',to:merchant.id,load:null}:null;
  }
  async function courierJob(c,s,self){
    const snap=getSnapshot();if(!snap)return;
    const view=snap.agents.map(a=>({...a,role:configs.find(x=>x.id===a.id)?.role,hunger:stateOf(a.id)?.needs?.hunger??20}));
    const dedicated=roleOf(c)==='courier';
    s.errand??=(dedicated?supplyErrand()??nextDelivery(town.deliveries??[],town.stock.items)??clearoutErrand():null)??courierErrand({...self,id:c.id},view,town.stock.items,{allGoods:dedicated});
    // The dedicated runner walks its rounds (work orders are claimed through the order board).
    if(!s.errand&&dedicated){
      {
        // Carry a ration pack on the rounds so hungry workers can be fed on the spot.
        if(!edibleIn(self.inventory)&&(town.stock.items.BREAD??0)>=16){s.errand={kind:'rations'};}
        else{const stop=nextPatrolStop(patrolStops(snap),s.lastStop);if(stop)s.errand={kind:'patrol',to:stop.id};}
      }
    }
    const e=s.errand;if(!e){s.nextErrand=Date.now()+(dedicated?15000:30000);return;}
    // An errand nobody knows how to run is dropped instead of freezing the courier.
    if(!['supply','fetch-food','feed','collect','rations','patrol','store','clearout'].includes(e.kind)){log('errand_dropped',{agent:c.id,kind:e.kind});s.errand=null;return;}
    const target=id=>snap.agents.find(a=>a.id===id);
    const reach=async t=>{if(dist(self,t)<=3)return true;if(!self.pathing)await travel(c.id,self,{x:t.x+1,y:Math.round(t.y),z:t.z+1}).catch(()=>{});return false;};
    if(e.kind==='supply'){
      // Fetch the builder's materials: take them from the warehouse, then carry them to the builder.
      if(!e.loaded){
        if(!await goToWarehouse(c.id,self))return;
        const got={};for(const [item,n] of Object.entries(e.items)){const k=await withdraw(c.id,item,n);if(k)got[item]=k;}
        if(!Object.keys(got).length){s.errand=null;s.nextErrand=Date.now()+30000;return;}
        e.items=got;e.loaded=true;return;
      }
      const t=target(e.to);if(!t){s.errand=null;return;}
      if(!await reach(t))return;
      const handed=[],given={};
      for(const [item,n] of Object.entries(e.items)){
        const carried=Math.min(n,self.inventory?.[item]??n);let left=carried;
        while(left>0){const k=Math.min(64,left);if(!await act(c.id,{type:'give',x:0,y:0,z:0,target:item,count:k,to:e.to}).then(()=>true).catch(()=>false))break;left-=k;}
        given[item]=carried-left;
        if(given[item]>0)handed.push(`${given[item]} ${item.toLowerCase().replace(/_/g,' ')}`);
      }
      if(handed.length){ledger(c.id,`brought ${handed.join(', ')} to ${e.to} for the ${e.for}`);log('courier_supply',{agent:c.id,to:e.to,items:e.items,for:e.for});
        befriend(c.id,e.to,1);const bs=stateOf(e.to);if(bs?.project)bs.project.waitUntil=0;
        // Confirmed: each give was acknowledged. The reservation counts it, the promise is kept, and the builder says so.
        if(e.key){for(const [item,n] of Object.entries(given))if(n>0)reservations.delivered(e.key,item,n,c.id);reservations.delivered(e.key,'*reserved',1,c.id);}
        say(e.to,`Thanks, ${nameOf(c.id)} - that's ${handed[0]} for the ${e.for}.`).catch(()=>{});}
      if(e.requestId)recordDelivery(town.deliveries??[],e.requestId,given);
      // Anything the builder could not take goes back to the warehouse.
      s.errand=null;return;
    }
    if(e.kind==='fetch-food'){
      // A hungry worker with nothing to eat: take food from the warehouse, then feed them.
      if(!await goToWarehouse(c.id,self))return;
      const got=await withdraw(c.id,e.item,8);
      s.errand=got?{kind:'feed',to:e.for,item:e.item}:null;return;
    }
    if(e.kind==='feed'){
      const t=target(e.to);
      if(!t||(stateOf(e.to)?.needs?.hunger??20)>=12||!(self.inventory?.[e.item]>0)){s.errand=null;return;}
      if(!await reach(t))return;
      const n=Math.min(4,self.inventory[e.item]);
      if(await act(c.id,{type:'give',x:0,y:0,z:0,target:e.item,count:n,to:e.to}).then(()=>true).catch(()=>false)){
        ledger(c.id,`brought ${n} ${e.item.toLowerCase().replace(/_/g,' ')} to ${e.to}`);befriend(c.id,e.to,1);}
      s.errand=null;return;
    }
    if(e.kind==='collect'){
      // Pick up a worker's surplus (crops, ore, logs, stone) at their work and carry it to the warehouse.
      const t=target(e.from);if(!t){s.errand=null;return;}
      if(!await reach(t))return;
      const got={};
      for(const [item,n] of e.items.slice(0,6))
        if(await act(e.from,{type:'give',x:0,y:0,z:0,target:item,count:Math.min(64,n),to:c.id}).then(()=>true).catch(()=>false))got[item]=Math.min(64,n);
      s.errand=Object.keys(got).length?{kind:'store',items:got,from:e.from}:null;
      if(!s.errand)s.nextErrand=Date.now()+10000;
      return;
    }
    if(e.kind==='clearout'){
      // Barnaby the Runner carries the warehouse's overflow (over its caps, or flagged by Jasper when its own chests
      // are full) to the shops: food to Antoine's bakery, the rest to Marlo's market - one load, one shop at a time.
      // Jasper stays at his post. (The old hand-over used 'wage', which takes from the warehouse, not his pack.)
      if(!e.load){
        if(!await goToWarehouse(c.id,self))return;
        const q=town.marketQueue??={};
        const want=[...Object.entries(q).filter(([,n])=>n>0).map(([item,n])=>({item,over:n})),...surplusOf(town.stock.items).filter(x=>!q[x.item])];
        const got=[];
        for(const l of loadOf(want)){const n=await withdraw(c.id,l.item,l.count,{procure:false});if(n){got.push({item:l.item,count:n});if(q[l.item])q[l.item]=Math.max(0,q[l.item]-n);}}
        if(!got.length){s.errand=null;return;}
        e.load=got;log('surplus_loaded',{agent:c.id,load:got,total:got.reduce((a,b)=>a+b.count,0)});return;
      }
      const shop=shopFor(e.load[0].item);
      if(!shop){s.errand=null;return;}
      const part=e.load.filter(l=>shopFor(l.item)===shop);
      const put=await stockMarket(c.id,self,part,{shop});if(put===null)return;   // still on the way
      ledger(c.id,`took ${part.map(l=>`${l.count} ${l.item.toLowerCase().replace(/_/g,' ')}`).join(', ')} from the warehouse to ${SHOPS[shop].name}`);
      log('surplus_cleared',{agent:c.id,to:shop,load:part});
      e.load=e.load.filter(l=>!part.includes(l));if(!e.load.length)s.errand=null;return;
    }
    if(e.kind==='rations'){
      if(!await goToWarehouse(c.id,self))return;
      await withdraw(c.id,'BREAD',16);s.errand=null;return;
    }
    if(e.kind==='patrol'){
      const t=target(e.to);if(!t||t.y<58){s.lastStop=e.to;s.errand=null;return;}
      if(!await reach(t))return;
      s.lastStop=e.to;
      const cfg=configs.find(x=>x.id===e.to),hunger=stateOf(e.to)?.needs?.hunger??20,food=edibleIn(self.inventory);
      if(hunger<12&&food&&!edibleIn(t.inventory)){
        const n=Math.min(4,self.inventory[food]);
        if(await act(c.id,{type:'give',x:0,y:0,z:0,target:food,count:n,to:e.to}).then(()=>true).catch(()=>false)){
          ledger(c.id,`handed ${n} ${food.toLowerCase().replace(/_/g,' ')} to ${e.to} at work`);befriend(c.id,e.to,1);}
      }
      const got={};
      for(const [item,n] of pickupOf(cfg,t.inventory).slice(0,6))
        if(await act(e.to,{type:'give',x:0,y:0,z:0,target:item,count:Math.min(64,n),to:c.id}).then(()=>true).catch(()=>false))got[item]=Math.min(64,n);
      s.errand=Object.keys(got).length?{kind:'store',items:got,from:e.to}:null;
      if(!s.errand)s.nextErrand=Date.now()+10000;
      return;
    }
    if(e.kind==='store'){
      if(!await goToWarehouse(c.id,self))return;
      // Goods are paid for as the producer's: the merchant owes them, not the courier.
      for(const [item,n] of Object.entries(e.items))await deposit(c.id,item,Math.min(n,self.inventory?.[item]??n),e.from??c.id);
      ledger(c.id,`carried ${Object.entries(e.items).map(([k,v])=>`${v} ${k.toLowerCase().replace(/_/g,' ')}`).join(', ')} from ${e.from} to the warehouse`);
      s.errand=null;
    }
  }
  /** Indoor work while resting at night: bake bread from wheat, cook raw fish, and the crafter runs recipes from its own stock. */
  async function nightChore(c,s,self){
    if(!ready(`chore:${c.id}`,60000))return;
    const inv=self.inventory??{};
    const breadScarce=scarceFood(prices()).includes('BREAD');
    if((inv.WHEAT??0)>=3&&((inv.BREAD??0)<16||breadScarce)){
      const times=Math.min(breadScarce?16:8,Math.floor(inv.WHEAT/3));
      if(await act(c.id,{type:'craft',x:0,y:0,z:0,target:'BREAD',count:times}).then(()=>true).catch(()=>false)){log('night_chore',{agent:c.id,chore:`baked ${times} bread`});award(c.id,'craft',times);return;}
    }
    for(const fish of ['COD','SALMON'])if((inv[fish]??0)>0){
      if(await act(c.id,{type:'smelt',x:0,y:0,z:0,target:fish,count:Math.min(16,inv[fish])}).then(()=>true).catch(()=>false)){log('night_chore',{agent:c.id,chore:`cooked ${fish.toLowerCase()}`});return;}
    }
    if(roleOf(c)==='crafter'){
      const rule=chooseProduction(inv,PRODUCTION);
      if(rule){
        const r=await act(c.id,rule.how==='craft'?{type:'craft',x:0,y:0,z:0,target:rule.item,count:rule.times}:{type:'smelt',x:0,y:0,z:0,target:Object.keys(rule.inputs)[0],count:rule.times}).catch(()=>null);
        if(r){log('night_chore',{agent:c.id,chore:`made ${rule.item.toLowerCase()}`});award(c.id,rule.how,rule.times);}
      }
    }
  }
  const CROPS=new Set(['WHEAT','CARROT','POTATO','BEETROOT','PUMPKIN','SUGAR_CANE','EGG','BREAD','BAKED_POTATO']);
  function surplusOf(c,inventory){
    const keep={BREAD:8,APPLE:4,TORCH:roleOf(c)==='miner'?32:8,DIRT:roleOf(c)==='miner'?32:0,COBBLESTONE:roleOf(c)==='miner'?16:0,WHEAT_SEEDS:roleOf(c)==='farmer'?32:0,CARROT:roleOf(c)==='farmer'?8:0,POTATO:roleOf(c)==='farmer'?8:0,EMERALD:roleOf(c)==='merchant'?999:0};
    return Object.entries(inventory??{}).filter(([k])=>!KEEP.test(k)).map(([k,n])=>[k,n-(keep[k]??0)]).filter(([,n])=>n>0);
  }
  /** The courier's supply run: what a builder lacks for its project and the warehouse has, up to a cartload. */
  /** The courier's next delivery: what is reserved for a builder's current phase (reservations.mjs), up to 256 items. */
  function supplyErrand(){
    for(const r of Object.values(town.reservations?.list??{})){
      const bs=stateOf(r.builder);if(!bs?.project||bs.resting)continue;
      const items={};let load=0;
      for(const [item,n] of Object.entries(r.reserved??{})){const k=Math.min(n,256-load);if(k>0){items[item]=k;load+=k;}if(load>=256)break;}
      if(load>0)return {kind:'supply',to:r.builder,for:bs.project.name,key:r.key,items};
    }
    return null;
  }
  /** Hauling is the courier's job. Others carry their own goods only when there is no courier on duty, or when
   *  they are badly overloaded (and then the courier is not coming in time). */
  function haulsOwnGoods(c,inventory){
    const runner=byRole('courier');
    if(!runner||roleOf(c)==='courier'||courierId()!==runner.id)return true;
    return Object.values(inventory??{}).reduce((n,k)=>n+k,0)>=1500;
  }
  async function haulJob(c,s,self){
    if(s.sellAtMarket?.length){const put=await stockMarket(c.id,self,s.sellAtMarket,{sale:true});if(put===null)return;
      if(Object.keys(put).length)ledger(c.id,`sold ${Object.entries(put).map(([k,v])=>`${v} ${k.toLowerCase().replace(/_/g,' ')}`).join(', ')} at Marlo's market`);s.sellAtMarket=null;return;}
    if(!await goToWarehouse(c.id,self))return;
    const unsold=[];
    for(const [item,n] of surplusOf(c,self.inventory)){const put=await deposit(c.id,item,n);if(put<n)unsold.push({item,count:n-put});}
    ledger(c.id,'brought goods to the warehouse');
    // The warehouse is full of it (or over its cap): sold to Marlo at his market instead (walked over on the next haul).
    if(unsold.length&&(shopReady('merchant')||shopReady('chef')))s.sellAtMarket=unsold;
  }
  async function productionJob(c,s,self){
    const pool={...town.stock.items};for(const [k,n] of Object.entries(self.inventory??{}))pool[k]=(pool[k]??0)+n;
    // No stock count yet (warehouse just finished): try again shortly instead of waiting minutes.
    // Store food ahead of winter: bread targets double in autumn and winter.
    // A high bread price moves baking to the front of the queue with a bigger target.
    const cold=['autumn','winter'].includes(seasonOf(town.day)),breadScarce=scarceFood(prices()).includes('BREAD');
    // A recipe that just failed for want of ingredients (the stock count was out of date) waits 15 minutes.
    const skip=s.skipRules??={};
    const rules=PRODUCTION.filter(r=>!(skip[r.item]>Date.now())).map(r=>r.item==='BREAD'?{...r,target:breadScarce?128:cold?96:r.target}:r).sort((a,b)=>(b.item==='BREAD'&&breadScarce)-(a.item==='BREAD'&&breadScarce));
    const rule=chooseProduction(pool,rules);
    if(!rule){
      s.producing=null;s.nextProduction=Date.now()+(town.stock.time?180000:20000);
      // Stalled: post a supply quest for the input of the most wanted product.
      const want=rules.find(r=>(pool[r.item]??0)<r.target&&Object.entries(r.inputs).some(([k,n])=>(pool[k]??0)<n));
      const input=want&&Object.entries(want.inputs).find(([k,n])=>(pool[k]??0)<n)?.[0];
      if(input&&town.stock.time&&ready(`stall:${c.id}:${input}`,1800000))await postQuest(c.id,input,32,`to make ${want.item.toLowerCase().replace(/_/g,' ')}`);
      return;
    }
    s.producing=rule.item;
    if(!await goToWarehouse(c.id,self))return;
    for(const [input,per] of Object.entries(rule.inputs)){const need=per*rule.times-(self.inventory?.[input]??0);if(need>0)await withdraw(c.id,input,need);}
    if(rule.fuel){const coal=Math.ceil(rule.times/8)-(self.inventory?.COAL??0);if(coal>0)await withdraw(c.id,'COAL',coal);}
    const r=await act(c.id,rule.how==='craft'?{type:'craft',x:0,y:0,z:0,target:rule.item,count:rule.times}
      :{type:'smelt',x:0,y:0,z:0,target:Object.keys(rule.inputs)[0],count:rule.times}).catch(error=>{log('production_error',{agent:c.id,item:rule.item,message:error.message});if(/Missing ingredients|Not enough/.test(error.message)){skip[rule.item]=Date.now()+900000;lastStock=0;}return null;});
    if(r){sound(c.id,rule.how==='smelt'?'block.grindstone.use':'block.anvil.use');award(c.id,rule.how,rule.times);const made=rule.how==='craft'?rule.times*rule.out:r.count;
      await deposit(c.id,rule.item,made);ledger(c.id,`made ${made} ${rule.item.toLowerCase().replace(/_/g,' ')} for the warehouse`);}
    s.producing=null;s.nextProduction=Date.now()+60000;
  }

  // ---------- guardian ----------
  function hostilesNearTown(snap){
    const seen=new Map();
    for(const a of snap.agents)for(const e of a.entities??[])if(d.HOSTILE.has(e.type)&&dist(e,SQUARE)<50)seen.set(e.uuid,e);
    return [...seen.values()];
  }
  async function guardianOverride(c,s,self){
    if(self.health<8){
      const food=bestFood(self.inventory);
      if(food&&ready(`heal:${c.id}`,2000)){await act(c.id,{type:'eat',x:0,y:0,z:0,target:food}).catch(()=>{});return true;}
      const threat=(self.entities??[]).find(e=>d.HOSTILE.has(e.type));
      if(threat&&!self.pathing){const dx=self.x-threat.x,dz=self.z-threat.z,len=Math.hypot(dx,dz)||1;
        await walk(c.id,clampMove({type:'pathfind',x:self.x+dx/len*8,y:Math.round(self.y),z:self.z+dz/len*8},self)).catch(()=>{});
        if(ready(`retreat:${c.id}`,30000))await say(c.id,"I'm hurt - falling back for a moment!");return true;}
    }
    return false;
  }

  // ---------- schedule ----------
  function scheduleFestival(kind,reason,site){
    if(town.festival&&town.festival.day>=town.day)return;
    // Around a building, gather and decorate outside its walls (8 blocks out), not on its roof.
    town.festival={kind,reason,day:town.day,place:site?{x:site.x+2.5,z:site.z+2.5}:SQUARE,radius:site?8:5,held:false};
    town.lastFestivalDay=town.day;
    ledger('governor',`a ${kind} is planned for this evening: ${reason}`);
  }
  function queueDaily(){
    // One of each per agent in the queue (while the model is offline for days, they do not pile up).
    const queued=(id,kind)=>tasks.some(t=>t.id===id&&t.kind===kind);
    for(const c of configs)if(!queued(c.id,'diary'))tasks.push({id:c.id,kind:'diary'});
    if(byRole('scribe')&&!queued(byRole('scribe').id,'chronicle'))tasks.push({id:byRole('scribe').id,kind:'chronicle'});
  }
  function onPhaseChange(phase,previous){
    if(phase==='dawn'&&previous==='night'){
      town.day++;town.today={harvested:0,kills:0};
      town.meeting={day:town.day,start:Date.now(),spoke:false};
      setTimeout(()=>tableProposal('meeting').catch(error=>log('proposal_error',{message:error.message})),20000);
      ledger('scribe',`day ${town.day} begins`);
      if(isMarketDay(town.day))town.market={day:town.day,announced:false};
      maybeConflict();
      if(town.alert){town.alert=null;const g=byRole('guardian');if(g)say(g.id,'Dawn. All clear - back to work, everyone.');}
      if(councilDue(town.day,town.council.last,COUNCIL_EVERY)||town.council.called)town.councilMeeting={day:town.day,start:null};
      town.council.called=false;
      climateDawn();
      intel()?.onDawn().catch(()=>{});
      dawnQuests().catch(error=>log('quest_error',{where:'dawn',message:error.message}));
    }
    if(phase==='evening'&&(town.readiness&&town.readiness!=='green'||town.policy?.curfew==='always'))raiseAlert(town.readiness&&town.readiness!=='green'?town.readiness:'yellow','dusk');
    // A rest day (voted): everyone wakes rested and in better spirits.
    if(phase==='dawn'&&town.policy?.restDay===town.day)for(const c of configs)d.feel?.(c.id,'rested',1.5);
    if(phase==='evening'&&town.today.harvested>=32&&!town.festival)scheduleFestival('harvest festival',`a harvest of ${town.today.harvested} crops`,null);
    if(phase==='night')queueDaily();
  }
  /** Dawn: the sheriff asks for a jail once; citizens post quests from the town's needs; finished stages pay their builders. */
  async function dawnQuests(){
    const q=d.quests?.();if(!q)return;
    if(!town.built.tavern&&!town.tavernRequested){town.tavernRequested=true;await requestBuild('tavern',nameOf(governorOf()?.id??configs[0].id)).catch(()=>{});}
    if(byRole('banker')&&!town.built.bank&&!town.bankRequested){town.bankRequested=true;await requestBuild('bank',nameOf(byRole('banker').id)).catch(()=>{});}
    if(byRole('sheriff')&&!town.built.jail&&!town.jailRequested){town.jailRequested=true;await requestBuild('jail',nameOf(byRole('sheriff').id)).catch(()=>{});}
    if(byRole('judge')&&!town.built.courthouse&&!town.courthouseRequested){town.courthouseRequested=true;await requestBuild('courthouse',nameOf(byRole('judge').id)).catch(()=>{});}
    furnishHall();postSigns();
    if(byRole('chef')&&!town.built.bakery&&!town.bakeryRequested){town.bakeryRequested=true;await requestBuild('bakery',nameOf(byRole('chef').id)).catch(()=>{});}
    if(byRole('herbalist')&&!town.built.infirmary&&!town.infirmaryRequested){town.infirmaryRequested=true;await requestBuild('infirmary',nameOf(byRole('herbalist').id)).catch(()=>{});}
    await q.syncConstruction(town.plan.done,byRole('builder')?.id);
    const builder=byRole('builder'),bq=builder?stateOf(builder.id)?.project?.queue??[]:[],need={};
    for(const b of bq)if(!b.clear)need[b.block]=(need[b.block]??0)+1;
    const roles=Object.fromEntries(configs.map(c=>[roleOf(c),c.id]));
    const made=q.generate({shortages:Object.entries(need).filter(([k,n])=>(town.stock.items[k]??0)<Math.min(n,16)).sort((a,b)=>b[1]-a[1]).map(([item,n])=>({item,n:Math.min(64,n),by:builder?.id,for:stateOf(builder?.id)?.project?.name})),
      brokenTools:(town.toolBreaks??[]).filter(t=>Date.now()-t.time<3600000).map(t=>({agent:t.agent,tool:t.tool})),
      threats:town.weekThreats??0,darkSpots:town.darkSpots??0,damageOpen:repairList.length,complaints:[],
      fundedStages:town.plan.funded.filter(id=>!town.plan.done.includes(id)).map(id=>({stage:id,name:stageOf(id)?.stage.name??id.replace('site:','').replace(/_/g,' ')})),roles,square:SQUARE});
    if(made.length)log('quests_generated',{day:town.day,count:made.length,numbers:made.map(o=>o.number)});
  }
  /** Community service: real work for the town (repairs, lighting dark corners), or null when there is none. */
  function serviceWork(c,s,self){
    if(repairList.length)return ()=>repairJob(c,s,self);
    if(darkSpots.length||Date.now()-lastDarkPoll>600000)return ()=>lightingJob(c,s,self);
    return null;
  }
  /** The built jail's floor corner (for its cells), or null. */
  const jailSite=()=>town.built.jail&&town.sites?.jail?{...town.sites.jail}:null;
  /** The built courthouse's working points (blueprints.mjs courthouseLayout), or null. */
  const courtLayout=()=>town.built.courthouse&&town.sites?.courthouse?courthouseLayout(town.sites.courthouse):null;
  /** Where the chef cooks: the bakery (its stove) once built; until then the tavern, else his post - never the warehouse. */
  const kitchenLayout=()=>town.built.bakery&&town.sites?.bakery?bakeryLayout(town.sites.bakery):null;
  const clinicLayout=()=>town.built.infirmary&&town.sites?.infirmary?infirmaryLayout(town.sites.infirmary):null;
  /** Food for someone starving, from the warehouse pantry: walks there first; {item,count} once in hand, else null. */
  async function fetchFood(id,self){
    const item=FOODS.find(f=>(town.stock.items[f]??0)>0);if(!item)return null;
    if(!await goToWarehouse(id,self))return null;
    const got=await withdraw(id,item,4);return got?{item,count:got}:null;
  }
  /** The bank's vault box (the plugin keeps the coins in its chests) and counter; before it stands, the strongbox and the warehouse door. */
  const bankVault=()=>town.built.bank&&town.sites?.bank?{x:town.sites.bank.x+1,y:town.sites.bank.y+1,z:town.sites.bank.z+1,width:7,height:1,depth:2}:null;
  const bankCounter=()=>town.built.bank&&town.sites?.bank?{x:town.sites.bank.x+4.5,z:town.sites.bank.z+5.5}:{x:280.5,z:107.5};
  function maybeConflict(){
    // Rivals occasionally clash over something; the governor gets a conflict to resolve.
    const pairs=(intel()?.social.pairsAbove(40)??[]).filter(p=>p.score<=-2).map(p=>[p.pair.replace(' & ','|'),p.score]).sort((a,b)=>a[1]-b[1]);
    const pick=pairs[0]??(Math.random()<0.25?[`${ids[Math.floor(Math.random()*ids.length)]}|${ids[Math.floor(Math.random()*ids.length)]}`,0]:null);
    if(!pick)return;const [a,b]=pick[0].split('|');if(a===b||town.conflicts.some(x=>!x.resolved&&x.a===a&&x.b===b))return;
    const topics=['who gets the warehouse bread first','noise from the workshop at night','credit for the last building','a borrowed tool that came back broken'];
    const topic=topics[Math.floor(Math.random()*topics.length)],justice=d.justice?.();
    if(justice){const k=justice.openConflict({a,b,reason:topic});befriend(a,b,-1);ledger(a,`argued with ${nameOf(b)} about ${topic} (${k.conflict_id})`);justice.maybeComplain(k);return;}
    const conflict={id:String(town.conflicts.length+1),a,b,topic,day:town.day,resolved:false};
    town.conflicts.push(conflict);befriend(a,b,-1);ledger(a,`argued with ${b} about ${conflict.topic}`);log('conflict',conflict);
  }
  // ---------- the town hall's meeting table: 18 chairs around a 7 x 2 table (council, town meetings, court) ----------
  // The hall as built (x339-351, z26-36; floor one above the site's y; double door in the west wall at z33-34) has an
  // 11 x 9 room. The table runs down the middle (x+3..x+9, z+4..z+5: spruce fence legs, pressure-plate top); a chair
  // (spruce stairs, back to the wall side) stands at every place: seven along each long side, two at each end. The
  // south side (z+7..z+9) stays free as the walkway from the door. Each chair has the floor cell behind it to walk to.
  function hallLayout(){
    const s=town.sites?.town_hall;if(!town.built.town_hall||!s)return null;
    const ox=s.x,oz=s.z,fy=(s.y??64)+1,table=[],seats=[];
    for(let x=ox+3;x<=ox+9;x++)for(const z of [oz+4,oz+5])table.push({x,z});
    const seat=(x,z,facing,ax,az)=>seats.push({x,z,facing,approach:{x:ax+0.5,z:az+0.5}});
    seat(ox+2,oz+4,'WEST',ox+1,oz+4);seat(ox+2,oz+5,'WEST',ox+1,oz+5);              // the head of the table (by the door)
    for(let x=ox+3;x<=ox+9;x++)seat(x,oz+3,'NORTH',x,oz+2);                          // the north side
    for(let x=ox+3;x<=ox+9;x++)seat(x,oz+6,'SOUTH',x,oz+7);                          // the south side
    seat(ox+10,oz+4,'EAST',ox+11,oz+4);seat(ox+10,oz+5,'EAST',ox+11,oz+5);          // the far end
    return {ox,oz,fy,table,seats};
  }
  /** Bram (the repair crew) builds the table and chairs once; afterwards the hall is ready for seated meetings. */
  function furnishHall(){
    const L=hallLayout();if(!L||town.hallFurnished)return;
    for(const t of L.table){requestFurnish({x:t.x,y:L.fy,z:t.z,block:'SPRUCE_FENCE',for:'town_hall',quiet:true});requestFurnish({x:t.x,y:L.fy+1,z:t.z,block:'SPRUCE_PRESSURE_PLATE',for:'town_hall',quiet:true});}
    for(const st of L.seats)requestFurnish({x:st.x,y:L.fy,z:st.z,block:'SPRUCE_STAIRS',facing:st.facing,for:'town_hall',quiet:true});
    town.hallFurnished=Date.now();log('hall_furnishing_requested',{table:L.table.length,chairs:L.seats.length});
    ledger(byRole('builder')?.id??'town',`the town hall is getting a meeting table with ${L.seats.length} chairs`);
  }
  // The crafter knows every recipe in the game: the server's recipe book is read at start (page by page) and the
  // supply planner falls back to it for anything the town's hand-written recipes do not cover.
  (async function loadRecipes(tries=0){
    const id=anyOnline();if(!id){if(tries<20)setTimeout(()=>loadRecipes(tries+1),15000).unref?.();return;}
    try{const all=[];let off=0,total=1;
      while(off<total){const r=await act(id,{type:'allrecipes',x:off,y:0,z:0,count:300});total=r?.total??0;all.push(...(r?.recipes??[]));off+=300;if(!(r?.recipes??[]).length)break;}
      const n=setServerRecipes(all);log('recipes_loaded',{recipes:all.length,items:n});
    }catch(error){log('recipes_error',{message:error.message});if(tries<20)setTimeout(()=>loadRecipes(tries+1),30000).unref?.();}
  })();
  // Every few minutes: Marlo's market (set up once, stock re-read) and name signs for buildings and homes without one.
  setInterval(()=>{shopsTick().catch(e=>log('market_error',{message:e.message}));postAllSigns().catch(e=>log('signs_error',{message:e.message}));},180000).unref?.();
  setTimeout(()=>{try{furnishHall();postSigns();}catch(error){log('hall_error',{message:error.message});}},20000).unref?.();
  // A demolition the mayor ordered does not wait for the builder's current project: done straight away, then dropped from the list.
  setTimeout(async()=>{const l=town.priorityBuilds??[],b=byRole('builder');for(const item of l.filter(x=>x.startsWith('demolish:'))){
    try{if(b&&await demolishWork(b,item.slice(9),true)==='done')town.priorityBuilds=(town.priorityBuilds??[]).filter(x=>x!==item);}catch(error){log('demolish_error',{what:item,message:error.message});}}},40000).unref?.();
  // The mayor's order (2026-10-03): finish the jail where it stands, then build the courthouse - before more homes.
  if(!town.priorityV1){town.priorityV1=true;town.priorityBuilds=['finish:jail','courthouse'];log('priority_builds',{list:town.priorityBuilds});}
  // The pond south of the town hall (x328-348, z45-53, 4+ deep): citizens walking to the hall waded in and had to be
  // pulled out (36 times in 90 minutes). A 2-wide plank bridge at water level (x339-340) with fence railings, built by
  // the repair crew (2026-10-03).
  if(!town.hallBridgeV1){town.hallBridgeV1=true;setTimeout(()=>{
    for(let z=45;z<=53;z++){for(const x of [339,340])requestFurnish({x,y:62,z,block:'SPRUCE_PLANKS',for:'bridge:hall pond',quiet:true});
      for(const x of [338,341])requestFurnish({x,y:63,z,block:'SPRUCE_FENCE',for:'bridge:hall pond',quiet:true});}
    log('bridge_requested',{where:'hall pond',x:[339,340],z:[45,53]});},25000).unref?.();}
  // The lake north of the village street: a 4-block water gap (x297-300, z66-67) between the east bank (stand 63) and
  // the west bank (stand 65) - citizens bound north waded in. An earth causeway stepping up one block at a time.
  if(!town.northCausewayV1){town.northCausewayV1=true;setTimeout(()=>{
    const top={300:62,299:62,298:63,297:64};
    for(const [x,t] of Object.entries(top))for(const z of [66,67])for(let y=62;y<=t;y++)requestFurnish({x:Number(x),y,z,block:'DIRT',for:'causeway:north lake',quiet:true});
    log('bridge_requested',{where:'north lake causeway',x:[297,300],z:[66,67]});},26000).unref?.();}
  // The sandstone walkway along the pond's north shore (z43-44) and the stream (x330-331) lies over the water: citizens
  // slipped off its open edge and drifted underneath. Fences in the water along those edges (the walkway untouched).
  if(!town.walkwayRailV1){town.walkwayRailV1=true;setTimeout(()=>{
    for(let x=330;x<=337;x++)requestFurnish({x,y:62,z:45,block:'SPRUCE_FENCE',for:'rail:hall walkway',quiet:true});
    for(let z=34;z<=44;z++)requestFurnish({x:329,y:62,z,block:'SPRUCE_FENCE',for:'rail:hall walkway',quiet:true});
    log('bridge_requested',{where:'walkway railings by the hall pond',fences:19});},27000).unref?.();}
  // Then the bakery (Chef Antoine's kitchen) and the infirmary (Rosa's clinic), after the jail and courthouse.
  // The jail entry was consumed without a trace once (no finish_* log): put it back in front.
  if(!town.priorityV3){town.priorityV3=true;const l=town.priorityBuilds??=[];if(!l.includes('finish:jail'))l.unshift('finish:jail');}
  // The mayor's order (2026-10-04, v6): the priest's house already stands on its lot (294,121, floor 67); the home Bram
  // was raising on its roof (floor 74) comes down, and the priest's home counts as built.
  if(!town.priestRoofV1){town.priestRoofV1=true;
    (memory.data.village.built??={}).priest=true;
    const b=stateOf(byRole('builder')?.id??'');if(b?.project?.homeFor==='priest'){log('project_cancelled',{agent:'builder',name:b.project.name,why:'the priest\'s house already stands; this one was on its roof'});b.project=null;}
    (town.priorityBuilds??=[]).unshift('demolish:roof:294,121,74,67,east');}
  // The mayor's order (2026-10-04, v5): clear the abandoned attempts; then complete the buildings that stand with gaps.
  // (v7, 2026-10-06) the three frames by the shrine become workshops: registered at the frames as they stand (floor
  // heights measured), finished by the builder; the two-row start beside them comes down.
  const WORKSHOPS={herb_shed:{role:'herbalist',y:69,stations:['CAULDRON','BARREL']},carpenter:{role:'crafter',y:69,stations:['CRAFTING_TABLE','BARREL']},fishmonger:{role:'fisher',y:67,stations:['BARREL','CAULDRON']}};
  if(!town.priorityV7){town.priorityV7=true;
    for(const [id,w] of Object.entries(WORKSHOPS)){(town.sites??={})[id]={x:SITES[id].x,y:w.y,z:SITES[id].z,at:Date.now()};
      if(!(town.priorityBuilds??=[]).includes('finish:'+id))town.priorityBuilds.push('finish:'+id);}
    town.priorityBuilds.unshift('demolish:abandoned3');log('priority_builds',{list:town.priorityBuilds});}
  // (v7c) the perimeter walls are not wanted: the wall project, parked or in hand, is cancelled and its funding dropped.
  if(!town.wallsRetiredV1){town.wallsRetiredV1=true;
    const isWall=p=>/^(north|east|south|west) wall$/.test(p?.name??'');
    town.parkedProjects=(town.parkedProjects??[]).filter(x=>!isWall(x.project));
    for(const a of Object.values(memory.data.agents??{}))if(isWall(a?.project))a.project=null;
    town.plan.funded=(town.plan.funded??[]).filter(x=>!/^wall_/.test(x));
    log('plan_retired',{plan:'perimeter wall',why:'not requested by the mayor'});}
  // (v7b) the north wall (far north, 0 of 26 placed for a day, waiting on stone brick walls) is set aside so the
  // workshops go first; it is picked up again in two hours, or as soon as its materials are in.
  {const b=byRole('builder'),st=b&&memory.data.agents?.[b.id];
    if(!town.northWallParkV1&&st?.project?.name==='north wall'&&!st.project.placed){town.northWallParkV1=true;
      st.project.blocker={kind:'materials',phase:'Walls',missing:{STONE_BRICK_WALL:12},text:'Walls paused: waiting for 12 stone brick walls; the workshops go first.',nextCheck:Date.now()+7200000};
      (town.parkedProjects??=[]).push({builder:b.id,project:st.project,nextCheck:Date.now()+7200000});st.project=null;
      log('project_parked',{agent:b.id,project:'north wall',why:'set aside for the workshops (0/26 placed, waiting on stone brick walls)'});}}
  // (v6, 2026-10-05) two more abandoned frames north of the forge (an early town hall start, an early pavilion) come down too.
  if(!town.priorityV6){town.priorityV6=true;(town.priorityBuilds??=[]).unshift('demolish:abandoned2');log('priority_builds',{list:town.priorityBuilds});}
  if(!town.priorityV5){town.priorityV5=true;const l=town.priorityBuilds??=[];l.unshift('demolish:abandoned');for(let i=0;i<9;i++)l.push('complete:'+i);log('priority_builds',{list:l});}
  // The mayor's order (2026-10-04): two half-built libraries - keep the first (294,65,154: 421 of 425 blocks standing,
  // its floor already laid), take the second (290,67,174) down for parts.
  if(!town.libraryFixV1){town.libraryFixV1=true;
    town.sites.library={x:294,z:154,y:65,at:Date.now(),kept:'first library'};if(SITES.library){SITES.library.x=294;SITES.library.z=154;}
    town.built.library=true;(town.finishedSites??={}).library=Date.now();
    town.parkedProjects=(town.parkedProjects??[]).filter(x=>x.project?.publicWork!=='library');
    town.requests=(town.requests??[]).filter(x=>x!=='library');
    setTimeout(()=>requestFurnish({x:299,y:69,z:158,block:'LANTERN',for:'library lantern',quiet:true}),28000).unref?.();
    (town.priorityBuilds??=[]).unshift('demolish:library-b');
    log('library_kept',{site:'294,65,154',demolish:'290,67,174'});}
  // One-time: torches the lighting crew set where the last floor tile of the courthouse (313,64,98) and the infirmary
  // (274,70,155) goes - taken out (citizens' torches only), so the parked projects can lay the tile and finish.
  if(!town.torchFixV1){town.torchFixV1=true;setTimeout(async()=>{const b=byRole('builder')??configs[0];
    const r=await act(b.id,{type:'demolish',x:0,y:0,z:0,blocks:[[313,64,98],[274,70,155]]}).catch(e=>({error:e.message}));
    log('demolished',{agent:b.id,what:'torches on unfinished floors',result:r});
    for(const x of town.parkedProjects??[])if(/courthouse|infirmary/.test(x.project?.name??''))x.nextCheck=Date.now();},42000).unref?.();}
  // The mayor's order (2026-10-04): take down the mistaken second storey on the fisher's house first.
  if(!town.priorityV4){town.priorityV4=true;(town.priorityBuilds??=[]).unshift('demolish:fisher-upper');}
  if(!town.priorityV2){town.priorityV2=true;const l=town.priorityBuilds??=[];for(const id of ['bakery','infirmary'])if(!town.built[id]&&!l.includes(id))l.push(id);log('priority_builds',{list:l});}   // not only at dawn: right after a start too
  const hallReady=()=>!!hallLayout()&&!!town.hallFurnished&&!(town.damage.furnish??[]).some(f=>f.for==='town_hall');
  /** At a meeting in the hall: to one's own chair (the governor at the head), and sit. Full house: stand nearby. */
  /**
   * The floor to stand on at x,z when it lies inside one of the town's buildings (the standing height: floor + 1), or
   * null. A ground survey there returns the roof - a walk sent to the roof top never arrives (the governor shuttled
   * between a goal "at the town hall" (y75, its roof) and his farm plot, stalling in doorways on the way).
   */
  function floorAt(x,z){
    const L=hallLayout();if(L&&x>=L.ox&&x<=L.ox+12&&z>=L.oz&&z<=L.oz+10)return L.fy;
    for(const [k,at] of Object.entries(town.sites??{})){
      if(!town.built[k]||!SITES[k]||!Number.isFinite(at.y))continue;
      let fp;try{fp=siteFootprint(SITES[k],at.x,at.z);}catch{continue;}
      if(x>=fp.x1&&x<=fp.x2&&z>=fp.z1&&z<=fp.z2)return at.y+1;
    }
    return null;
  }
  const hallShift=new Map();
  /** Inside the town hall (its room). */
  const inHall=p=>{const L=hallLayout();return !!L&&p.x>=L.ox+1&&p.x<L.ox+12&&p.z>=L.oz+1&&p.z<L.oz+10;};
  async function hallSeat(c,self,fallback){
    // Own chair by order (the governor at the head); taken by someone else: the next one along (hallSeatShift).
    const L=hallLayout(),gov=governorOf()?.id,order=[...(gov?[gov]:[]),...ids.filter(x=>x!==gov)],shift=hallShift.get(c.id)??0,i=order.indexOf(c.id)<0?-1:(order.indexOf(c.id)+shift)%(L?.seats.length||1),st=L?.seats[i];
    if(!st)return gather(c,self,fallback,5);
    if(self.sitting&&Math.hypot(self.x-(st.x+0.5),self.z-(st.z+0.5))<1.2)return;
    const ap=st.approach;
    if(Math.hypot(self.x-ap.x,self.z-ap.z)<=1.3){
      if(ready(`hall-sit:${c.id}`,8000))await act(c.id,{type:'sit',x:st.x,y:L.fy,z:st.z,seat:true}).then(()=>log('took_seat',{agent:c.id,seat:i+1})).catch(e=>{log('hall_sit_failed',{agent:c.id,seat:i+1,error:e.message});if(/sitting there/.test(e.message))hallShift.set(c.id,shift+1);});
      return;
    }
    if(self.pathing)return;
    if(dist(self,ap)<=14)await walk(c.id,{type:'pathfind',x:ap.x,y:L.fy,z:ap.z}).catch(()=>{});
    else await travel(c.id,self,{x:ap.x,y:L.fy,z:ap.z}).catch(()=>{});
  }
  /** Court in the hall (no courthouse yet): the judge at the far end, jurors along the north side, the parties on the
   *  south side, the witness at the head; they stand behind their chair and sit down (main.mjs maybeSit). */
  function hallCourt(){
    if(town.built.courthouse||!hallReady())return null;
    const L=hallLayout(),p=(x,z)=>({x:L.ox+x+0.5,y:L.fy,z:L.oz+z+0.5});
    return {bench:p(11,4),jury:[4,5,6,7,8].map(x=>p(x,2)),stands:{plaintiff:p(4,7),defendant:p(8,7),witness:p(1,4),sheriff:p(11,7)},place:p(6,8)};
  }
  async function gather(c,self,place,radius=4){
    const i=ids.indexOf(c.id),angle=2*Math.PI*i/ids.length;
    const spot={x:place.x+Math.cos(angle)*radius,z:place.z+Math.sin(angle)*radius};
    if(dist(self,spot)<2.8||self.pathing)return;
    const ground=await act(c.id,{type:'survey',x:Math.floor(spot.x),y:0,z:Math.floor(spot.z),width:1,depth:1}).catch(()=>null);
    const y=Number.isFinite(ground?.heights?.[0])?ground.heights[0]+1:Math.round(self.y);
    await travel(c.id,self,{x:Math.floor(spot.x)+0.5,y,z:Math.floor(spot.z)+0.5}).catch(()=>{});
  }
  function scheduleTick(){
    const snap=getSnapshot();if(!snap)return;
    const phase=dayPhase(snap.worldTime);
    // The last phase is remembered across restarts so a restart at dawn does not skip the new day.
    lastPhase??=town.lastPhase??null;
    if(lastPhase&&phase!==lastPhase)onPhaseChange(phase,lastPhase);
    lastPhase=phase;town.lastPhase=phase;
    // A dusk curfew never outlasts the night.
    if(town.alert?.reason==='dusk'&&phase==='day'){town.alert=null;const g=byRole('guardian');if(g)say(g.id,'Morning! The curfew is lifted - back to work, everyone.');}
    const m=town.meeting;
    if(m&&m.day===town.day){
      const age=Date.now()-m.start;
      if(age>45000&&!m.spoke&&governorOf()){m.spoke=true;tasks.unshift({id:governorOf().id,kind:'meeting'});}
      if(!m.rang&&governorOf()){m.rang=true;(async()=>{for(let i=0;i<3;i++){await sound(governorOf().id,'block.bell.use',3);await new Promise(r=>setTimeout(r,1200));}})();}
      if(age>120000)town.meeting=null;
    }
    const f=town.festival;
    if(f&&phase==='evening'&&!f.held&&f.day<=town.day){f.held=true;f.start=Date.now();
      for(const c of configs.slice(0,4))tasks.push({id:c.id,kind:'festival'});
      const host=governorOf()??configs[0];if(host)sound(host.id,'music_disc.chirp',3);
      const builder=byRole('builder');if(builder)tasks.push({id:builder.id,kind:'decorate'});}
    if(f?.held&&Date.now()-f.start>240000)town.festival=null;
    if(town.market&&!town.market.announced&&phase==='day'&&byRole('merchant')){town.market.announced=true;tasks.push({id:byRole('merchant').id,kind:'market'});}
    // Raids: many monsters near town at once. Readiness: red (raid), yellow (monsters about), green (calm).
    const hostiles=hostilesNearTown(snap);
    raid.active=hostiles.length>=4;
    if(hostiles.length)town.lastThreat=Date.now();
    town.readiness=readiness({hostilesNow:hostiles.length,recentThreat:Date.now()-town.lastThreat<600000,storm:!!snap.weather?.thunder,killsToday:town.today.kills});
    if(raid.active&&town.alert?.level!=='red')raiseAlert('red','raid');
    // A daytime raid alert ends once the town has been quiet for two minutes.
    if(town.alert?.level==='red'&&!raid.active&&phase==='day'&&Date.now()-town.lastThreat>120000){town.alert=null;const g=byRole('guardian');if(g)say(g.id,'The raid is over. All clear!');}
    // The council meets around midday on council days.
    const cm=town.councilMeeting;
    if(cm&&cm.day===town.day){
      if(!cm.start&&phase==='day'&&(snap.worldTime%24000)>=5000){cm.start=Date.now();startCouncil();}
      if(cm.start){
        const age=Date.now()-cm.start;
        if(age>40000&&!cm.spoke&&governorOf()){cm.spoke=true;tasks.unshift({id:governorOf().id,kind:'council'});}
        if(age>100000&&!cm.decided){cm.decided=true;decideCouncil();}
        if(age>150000)town.councilMeeting=null;
      }
    }else if(cm&&cm.day<town.day)town.councilMeeting=null;
    if(raid.active&&Date.now()-raid.warned>180000){town.weekThreats=(town.weekThreats??0)+1;
      raid.warned=Date.now();const g=byRole('guardian');
      const cx=hostiles.reduce((s,e)=>s+e.x,0)/hostiles.length,cz=hostiles.reduce((s,e)=>s+e.z,0)/hostiles.length;
      const dir=Math.abs(cx-SQUARE.x)>Math.abs(cz-SQUARE.z)?(cx>SQUARE.x?'east':'west'):(cz>SQUARE.z?'south':'north');
      if(g){sound(g.id,'event.raid.horn',4);say(g.id,`Raid! ${hostiles.length} monsters coming from the ${dir}. Stay close to me!`);if(g.protect)act(g.id,{type:'whisper',x:0,y:0,z:0,to:g.protect,text:`Raid warning: ${hostiles.length} monsters to the ${dir} of the square.`}).catch(()=>{});}
      ledger(g?.id??'guardian',`raid of ${hostiles.length} monsters from the ${dir}`);
    }
  }

  async function toolPickupJob(c,s,self,order){
    if((self.inventory?.[order]??0)>0){await act(c.id,{type:'equip',x:0,y:0,z:0,target:order}).catch(()=>{});delete town.toolOrders[c.id];return;}
    if(!await goToWarehouse(c.id,self))return;
    if(await withdraw(c.id,order,1)){await act(c.id,{type:'equip',x:0,y:0,z:0,target:order}).catch(()=>{});ledger(c.id,`picked up a new ${order.toLowerCase().replace(/_/g,' ')} from the warehouse`);}
    delete town.toolOrders[c.id];
  }
  // ---------- alerts: the curfew bell and shelters ----------
  function raiseAlert(level,reason){
    if(town.alert&&(town.alert.level==='red'||level!=='red'))return;
    town.alert={level,reason,since:Date.now(),day:town.day};
    const g=byRole('guardian')??configs[0];
    (async()=>{for(let i=0;i<3;i++){await sound(g.id,'block.bell.use',4);await new Promise(r=>setTimeout(r,900));}await sound(g.id,'block.bell.resonate',3);})();
    const text=level==='red'?'Raid! Everyone into the nearest shelter, now!':'Curfew bell! Monsters are about tonight - everyone into the nearest shelter.';
    say(g.id,text);ledger(g.id,`rang the town bell (${level} alert: ${reason})`);log('alert',{level,reason});
    intel()?.onAlert(level,governorOf()?.id,byRole('guardian')?.id);
  }
  const SHELTER_SITES=['warehouse','town_hall','library','forge','mayor_house','watchtower'];
  const shelterFloors=new Map();let shelterCache={time:0,list:[]};
  /** Enclosed buildings and built homes, with a point outside each to measure the ground (the roof hides the floor). */
  function shelterList(){
    if(Date.now()-shelterCache.time<60000)return shelterCache.list;
    const out=[];
    for(const id of SHELTER_SITES)if(town.built[id]){
      const site=SITES[id];
      try{const b=blueprint({shape:site.shape,door:site.door,...(site.spec??{})},site.x,0,site.z),xs=b.map(p=>p.x),zs=b.map(p=>p.z);
        const x1=Math.min(...xs),x2=Math.max(...xs),z1=Math.min(...zs),z2=Math.max(...zs);
        out.push({id,x:(x1+x2)/2+0.5,z:(z1+z2)/2+0.5,probe:{x:x1-2,z:Math.floor((z1+z2)/2)}});}catch{}
    }
    for(const c of configs){const h=homeOf(c.id);if(h&&homeBuilt(c.id))out.push({id:`home:${c.id}`,x:h.cx,z:h.cz,probe:{x:h.x-2,z:h.z+2}});}
    shelterCache={time:Date.now(),list:out};return out;
  }
  /**
   * Where a citizen takes shelter: their own home (if built and not far), else the nearest public shelter - never a
   * neighbour's house. In a home the spot is the free floor beside the bed (main.mjs sleepSpot): the old spot (the
   * house centre, nudged by the citizen's number) often fell on the table in the middle or the bed, and the citizen
   * pressed at it from the doorway for the whole curfew - the "spinning at their own front door".
   */
  function shelterFor(c,self){
    const h=homeOf(c.id),own=h&&homeBuilt(c.id)?shelterList().find(x=>x.id===`home:${c.id}`):null;
    const pub=nearestShelter(self,shelterList().filter(x=>!x.id.startsWith('home:')));
    if(own&&(!pub||dist(self,own)<=Math.max(48,dist(self,pub)+24)))return {sh:own,spot:h.spot??{x:own.x,z:own.z},home:true};
    return pub?{sh:pub,spot:null,home:false}:null;
  }
  async function shelterJob(c,s,self){
    const f=shelterFor(c,self);if(!f)return;const sh=f.sh;
    const i=ids.indexOf(c.id),L=sh.id==='town_hall'?hallLayout():null;
    // In the town hall: the free floor behind a chair (its centre is the meeting table now).
    const spot=f.spot??(L?L.seats[i%L.seats.length].approach:{x:sh.x+((i%3)-1)*0.9,z:sh.z+((Math.floor(i/3)%3)-1)*0.9});
    // Home: inside the house is enough (the plugin steps them out of the doorway); the hall and the like: near the spot.
    if(f.home?dist(self,spot)<=1.5||(homeOf(c.id)&&d.insideHome?.(homeOf(c.id),self)&&!self.pathing):dist(self,spot)<=2.6){if(s.sheltered!==sh.id){s.sheltered=sh.id;log('sheltered',{agent:c.id,in:sh.id});}
      // Sheltering at home after dark is bedtime too (the curfew used to keep them standing about indoors all night).
      if(f.home&&dayPhase(getSnapshot()?.worldTime)==='night')await d.bedtime?.(c,s,self);
      return;}
    s.sheltered=null;if(self.pathing)return;
    if(!shelterFloors.has(sh.id))shelterFloors.set(sh.id,await act(c.id,{type:'survey',x:Math.floor(sh.probe.x),y:0,z:Math.floor(sh.probe.z),width:1,depth:1})
      .then(r=>Number.isFinite(r?.heights?.[0])?r.heights[0]+2:undefined).catch(()=>undefined));
    await travel(c.id,self,{x:spot.x,y:shelterFloors.get(sh.id)??Math.round(self.y),z:spot.z}).catch(()=>{});
  }

  // ---------- climate: seasons and droughts ----------
  let climateSent=0;
  function climateDawn(){
    const season=seasonOf(town.day),cl=town.climate,farmer=byRole('farmer')??configs[0];
    if(cl.drought&&town.day>cl.drought.until){cl.drought=null;ledger(farmer.id,'the drought broke; the fields are green again');say(farmer.id,'Rain at last! The drought is over and the wheat is growing again.');}
    else if(!cl.drought){
      const days=rollDrought(season);
      if(days){cl.drought={start:town.day,until:town.day+days-1};ledger(farmer.id,`a drought began; crops will grow slowly for about ${days} days`);
        say(farmer.id,`A drought has set in. The wheat will grow slowly for a few days - we'll lean on Finley's fish and the warehouse.`);}
    }
    if(cl.season!==season&&cl.season){ledger('scribe',`${season} has come to the town`);}
    cl.season=season;climateSent=0;
  }
  async function sendClimate(){
    const cl=town.climate,season=seasonOf(town.day),growth=growthRate(season,!!cl.drought);
    cl.season??=season;cl.growth=growth;cl.lean=!!cl.drought||season==='winter';
    const any=getSnapshot()?.agents?.[0];if(!any)return;
    if(await act(any.id,{type:'climate',x:0,y:0,z:0,count:growth}).then(()=>true).catch(()=>false))climateSent=Date.now();
  }

  // ---------- town council ----------
  function pantryStatus(){const p=pantryPoints(town.stock.items);return p<60?'critical':p<120?'low':'healthy';}
  function councilMetrics(){
    return {pantryPoints:pantryPoints(town.stock.items),pantryStatus:pantryStatus(),treasury:town.stock.items.EMERALD??0,threats:(town.weekThreats??0)+Math.floor(town.kills/10),
      homes:Object.values(memory.data.village?.built??{}).filter(Boolean).length,openQuests:intel()?.board.open().length??0,
      season:seasonOf(town.day),drought:!!town.climate.drought,readiness:town.readiness??'green',bread:town.stock.items.BREAD??0};
  }
  function councilCandidates(){
    const funded=town.plan.funded,done=town.plan.done;
    const stages=openStages([...done,...funded]);
    const planned=new Set(MASTER_PLANS.flatMap(p=>p.stages.map(s=>s.site)).filter(Boolean));
    const buildings=town.unlocked.filter(id=>!town.built[id]&&SITES[id]&&!planned.has(id)&&!funded.includes(`site:${id}`)).map(id=>({plan:'building',planName:'Public building',kind:'building',stage:`site:${id}`,name:MILESTONES.find(m=>m.id===id)?.name.toLowerCase()??id}));
    return [...stages,...buildings];
  }
  const councilPlace=()=>{const h=shelterList().find(x=>x.id==='town_hall');return h?{x:h.x,z:h.z}:SQUARE;};
  function startCouncil(){
    const gov=governorOf();if(!gov)return;
    town.councilMeeting.candidates=councilCandidates();town.councilMeeting.playerVotes={};
    (async()=>{for(let i=0;i<2;i++){await sound(gov.id,'block.bell.use',3);await new Promise(r=>setTimeout(r,1200));}})();
    const list=town.councilMeeting.candidates.map(c=>c.stage.startsWith('site:')?c.name:`${c.name} (${c.planName.toLowerCase()})`).join('; ');
    say(gov.id,`Town council is in session! ${list?`Projects on the table: ${list}. Mayor, vote with /sid council <number>.`:'No new building projects this week.'}`);
    setTimeout(()=>tableProposal('council').catch(error=>log('proposal_error',{message:error.message})),8000);
    town.councilMeeting.candidates.forEach((c,i)=>c.number=i+1);
    ledger(gov.id,'opened the town council');log('council_started',{day:town.day});
  }
  async function decideCouncil(){
    const m=town.councilMeeting,gov=governorOf()??configs[0],metrics=councilMetrics();
    const voters=configs.filter(c=>c.id!=='visitor').map(c=>({id:c.id,role:roleOf(c)}));
    const result=councilVote(voters,m.candidates??[],metrics);
    // The mayor's (player's) vote counts three times.
    for(const stage of Object.values(m.playerVotes??{}))if(result.tally[stage]!==undefined)result.tally[stage]+=3;
    const winner=(m.candidates??[]).slice().sort((a,b)=>(result.tally[b.stage]??0)-(result.tally[a.stage]??0))[0]??null;
    const minutes={day:town.day,metrics,tally:result.tally,votes:result.votes,playerVotes:m.playerVotes,winner:winner&&{stage:winner.stage,name:winner.name},emergency:null};
    if(winner){town.plan.funded.push(winner.stage);intel()?.onStageFunded(winner.stage,winner.name,gov.id,byRole('builder')?.id);ledger(gov.id,`the council voted to fund the ${winner.name} (${result.tally[winner.stage]} votes)`);}
    const plan=emergencyPlan(metrics);
    if(plan){
      town.emergency={until:town.day+plan.days-1};town.prices=null;updatePrices();
      let paid=0;for(const role of plan.to){const who=byRole(role);if(who&&await act(gov.id,{type:'wage',x:0,y:0,z:0,to:who.id,target:'EMERALD',count:plan.grant}).then(()=>true).catch(()=>false))paid+=plan.grant;}
      minutes.emergency={grant:plan.grant,paid,days:plan.days};
      ledger(gov.id,`declared a food emergency: ${paid} emeralds to the food producers and higher food prices for ${plan.days} days`);
    }
    town.council.history.push(minutes);town.council.history=town.council.history.slice(-12);town.council.last=town.day;town.weekThreats=0;
    log('council_decided',{winner:winner?.stage,tally:result.tally,emergency:!!plan});
    const text=`The council has decided: ${winner?`we build the ${winner.name} next`:'no new project this time'}.${plan?` Food emergency: extra pay for food for ${plan.days} days.`:''} Pantry ${metrics.pantryStatus}, treasury ${metrics.treasury} emeralds.`;
    await say(gov.id,text);conversation({from:gov.id,kind:'council',text});
  }

  // ---------- model tasks (run by the main loop between turns) ----------
  const today=(s)=>s.episodes.filter(e=>Date.now()-e.time<30*60000);
  async function runTask(task){
    const c=configs.find(x=>x.id===task.id),s=stateOf(task.id);if(!c||!s)return;
    const persona={name:c.id,role:c.role,personality:s.personality??c.personality,mood:s.mood};
    if(task.kind==='diary'){
      const events=today(s).slice(-20).map(e=>e.reply?`talked with ${e.reply.to}`:e.project?e.project:e.defeated?`defeated a ${e.defeated}`:e.action?`${e.action.type}${e.action.text?': '+e.action.text:''}`:null).filter(Boolean);
      const mine=memory.data.ledger.filter(l=>l.by===c.id&&Date.now()-l.time<30*60000).map(l=>l.text);
      const raw=(await lm.callUtilityTask('diary_generation','Write a short first-person diary entry (2-3 sentences, under 280 characters) for this Minecraft villager about their day: what happened, who they met, how they feel. Plain text only.',{...persona,day:town.day,happened:[...mine,...events].slice(-15),relations:relationsOf(town.affinity,c.id)}));
      const text=cleanDiaryText(raw).slice(0,300);if(!text)return;
      s.diary=[...(s.diary??[]),{day:town.day,text}].slice(-30);log('diary',{agent:c.id,day:town.day,text});
    }
    if(task.kind==='chronicle'){
      const entries=memory.data.ledger.filter(l=>Date.now()-l.time<30*60000).map(l=>`${l.by}: ${l.text}`).slice(-40);
      const text=(await lm.callUtilityTask('town_chronicle_summaries','You are the town scribe. Write the chronicle entry for today (3-4 sentences, under 400 characters), in a warm historical voice, naming who did what. Plain text only.',{day:town.day,ledger:entries})).replace(/\s+/g,' ').trim().slice(0,420);
      town.chronicle.push({day:town.day,text});town.chronicle=town.chronicle.slice(-60);ledger(c.id,`wrote the chronicle for day ${town.day}`);
      conversation({from:c.id,kind:'chronicle',text});log('chronicle',{day:town.day,text});
    }
    if(task.kind==='meeting'){
      const agenda={yesterday:town.chronicle.at(-1)?.text,openProposals:memory.data.charter.proposals.map(p=>p.text),quests:(intel()?.board.open()??[]).map(o=>`${o.issuer_name} needs ${o.quantity-o.delivered} ${o.target_item??o.order_type}`),
        conflicts:town.conflicts.filter(x=>!x.resolved).map(x=>`${x.a} and ${x.b}: ${x.topic}`),nextBuild:town.unlocked.find(id=>!town.built[id])??(town.roadsDone<ROADS.length?ROADS[town.roadsDone].name:null),marketDay:isMarketDay(town.day)};
      const mayorHere=town.mayor&&playerByName(town.mayor);
      const text=await lm.speak({...persona,occasion:`morning meeting of day ${town.day} at the town square`,agenda,season:seasonOf(town.day),
        instruction:`Open the meeting: greet everyone, sum up the agenda in one or two sentences.${mayorHere?` Then ask Mayor ${town.mayor} (a player, present) for their opinion on what the town should do next.`:''}`},'town_speech');
      await say(c.id,text);
    }
    if(task.kind==='council'){
      const m=town.councilMeeting;if(!m)return;
      const text=await lm.speak({...persona,occasion:`town council meeting (day ${town.day}) at the ${town.built.town_hall?'town hall':'square'}`,metrics:councilMetrics(),
        choices:(m.candidates??[]).map(x=>`${x.number}. ${x.name}`),lastCouncil:town.council.history.at(-1)?.winner?.name,
        instruction:'Open the council: report the pantry, treasury and safety in one sentence, then list the numbered choices and ask everyone (and the Mayor, with /sid council <number>) to vote.'},'town_speech');
      await say(c.id,text);conversation({from:c.id,kind:'council',text});
    }
    if(task.kind==='market'){
      const text=await lm.speak({...persona,occasion:'market day at the market stall',wares:Object.keys(getSnapshot()?.agents.find(a=>a.id===c.id)?.inventory??{}),instruction:'Announce that the market is open and what you are trading today; invite players to right-click you to trade.'},'town_speech');
      await say(c.id,text);
    }
    if(task.kind==='festival'){
      const f=town.festival;if(!f)return;
      const text=await lm.speak({...persona,occasion:`${f.kind} for ${f.reason}`,instruction:'Say one joyful line for the celebration.'},'town_speech');await say(c.id,text);
    }
    if(task.kind==='decorate'){
      const f=town.festival;if(!f)return;
      const flowers=['POPPY','DANDELION','CORNFLOWER','POPPY','DANDELION','CORNFLOWER','LANTERN','LANTERN'];
      const snap=getSnapshot(),self=snap?.agents.find(a=>a.id===c.id);if(!self)return;
      let placed=0;
      for(let i=0;i<flowers.length;i++){
        const r=(f.radius??5)+1,a=2*Math.PI*i/flowers.length,x=Math.floor(f.place.x+Math.cos(a)*r),z=Math.floor(f.place.z+Math.sin(a)*r);
        const g=await act(c.id,{type:'survey',x,y:0,z,width:1,depth:1}).catch(()=>null);const y=g?.heights?.[0];if(!Number.isFinite(y))continue;
        if(await act(c.id,{type:'place',x,y:y+1,z,target:flowers[i]}).then(()=>true).catch(()=>false))placed++;
      }
      if(placed)ledger(c.id,`decorated for the ${f.kind}`);
    }
  }

  async function command(data,args){
    const verb=String(args[0]??'').toLowerCase(),snap=getSnapshot();
    const near=snap?.agents.slice().sort((a,b)=>Math.hypot(a.x-data.x,a.z-data.z)-Math.hypot(b.x-data.x,b.z-data.z))[0]?.id??configs[0].id;
    const tell=async(id,text)=>act(id,{type:'whisper',x:0,y:0,z:0,to:data.player,text}).catch(()=>{});
    if(verb==='build'){
      const b=byRole('builder')?.id??near,what=args.slice(1).join(' ').toLowerCase();
      const site=Object.keys(SITE_WORDS).find(k=>SITES[k]&&(SITE_WORDS[k].test(what)||SITE_WORDS[k].test(`the ${what}`)||k.replace(/_/g,' ')===what));
      if(!site){const open=Object.keys(SITES).filter(k=>!town.built[k]&&k!=='warehouse').map(siteName);
        await tell(b,`Use /sid build <name>. Not built yet: ${open.join(', ')||'nothing'}.${town.requests?.length?` Queued: ${town.requests.map(siteName).join(', ')}.`:''}`);return true;}
      await requestBuild(site,data.player);return true;
    }
    if(verb==='farm'){
      const f=byRole('farmer')?.id??near,sub=String(args[1]??'list').toLowerCase();
      if(sub==='scan'||sub==='here'){const r=await scanFarms(f);if(!r){await tell(f,'I could not look over the fields just now.');return true;}
        const p=sub==='here'?plotAt(data.x,data.z):null;
        await tell(f,sub==='here'?(p?`Got it: the plot at ${p.x1},${p.z1}-${p.x2},${p.z2} (${p.cells} blocks of farmland) is ours to tend.`:'I see no farmland where you stand. Till a patch (hoe) and try again.')
          :`Found ${town.farmPlots.length} farm plot(s), ${town.farmPlots.reduce((n,p)=>n+p.cells,0)} blocks of farmland. We'll tend them.`);return true;}
      if(sub==='forget'){const p=plotAt(data.x,data.z);if(!p){await tell(f,'Stand in the plot you want us to leave alone, then /sid farm forget.');return true;}
        const cells=[];for(let x=p.x1;x<=p.x2;x++)for(let z=p.z1;z<=p.z2;z++)cells.push([x,z]);
        town.farmIgnore=[...new Set([...(town.farmIgnore??[]),...cells.map(([x,z])=>`${x},${z}`)])];
        await act(f,{type:'adoptfarm',x:0,y:0,z:0,cells,remove:true}).catch(()=>{});
        town.farmPlots=town.farmPlots.filter(x=>x!==p);await tell(f,`Understood - we'll leave the plot at ${p.x1},${p.z1} alone.`);return true;}
      const list=(town.farmPlots??[]).map(p=>`${p.x1},${p.z1}-${p.x2},${p.z2} ${p.tiles[0]?.crop.toLowerCase()??''} (${p.cells})`);
      await tell(f,list.length?`Farm plots we tend: ${list.join('; ')}`.slice(0,240):'No farm plots yet. Till farmland in town, then /sid farm scan (or stand in it: /sid farm here).');return true;
    }
    if(verb==='prices'){
      const m=byRole('merchant')?.id??near,p=prices();
      const top=Object.entries(p).filter(([k])=>PRICE_BOOK[k].food||['IRON_INGOT','COAL','OAK_PLANKS'].includes(k)).slice(0,10)
        .map(([k,v])=>`${k.toLowerCase().replace(/_/g,' ')} ${v.factor>=1.4?'↑':v.factor<=0.8?'↓':''}${Math.round(payoutFor({[k]:16},p)*10)/10}`);
      await tell(m,`Warehouse buying prices (emeralds per 16): ${top.join(', ')}${emergencyActive()?' - FOOD EMERGENCY: food pays extra':''}`);
      return true;
    }
    if(verb==='council'){
      const gov=governorOf()?.id??near,m=town.councilMeeting,n=Number(args[1]);
      if(String(args[1]).toLowerCase()==='call'){town.council.called=true;await say(gov,`${data.player} has called a council meeting. We meet tomorrow at midday.`);return true;}
      if(m?.start&&!m.decided&&Number.isInteger(n)){
        const choice=(m.candidates??[]).find(c=>c.number===n);
        if(!choice){await tell(gov,`Pick a number from 1 to ${m.candidates?.length??0}.`);return true;}
        m.playerVotes[data.player]=choice.stage;await say(gov,`The Mayor, ${data.player}, votes for the ${choice.name}.`);return true;
      }
      const last=town.council.history.at(-1),next=(town.council.last??0)+COUNCIL_EVERY;
      await tell(gov,m?.start?`Council in session: ${(m.candidates??[]).map(c=>`${c.number}. ${c.name}`).join(' | ')} - vote with /sid council <number>.`
        :`Next council on day ${next} (today is day ${town.day}). Last time: ${last?.winner?.name??'nothing decided yet'}. /sid council call to meet sooner.`);
      return true;
    }
    if(verb==='alert'){
      const g=byRole('guardian')?.id??near;
      await tell(g,`Readiness: ${(town.readiness??'green').toUpperCase()}${town.alert?` - ${town.alert.level} alert (${town.alert.reason}), townsfolk are in shelter`:''}.`);
      return true;
    }
    if(verb==='plans'){
      const gov=governorOf()?.id??near;
      for(const p of planProgress(town.plan.done))await tell(gov,`${p.name}: ${p.done}/${p.total} (${p.stages.map(s=>(s.done?'✔ ':'')+s.name).join(', ')})`);
      if(town.plan.funded.length)await tell(gov,`Funded and next up: ${town.plan.funded.map(id=>stageOf(id)?.stage.name??id.replace('site:','')).join(', ')}`);
      return true;
    }
    return false;
  }

  const footprints=(()=>{return ()=>[...Object.values(SITES).map(site=>{try{const b=blueprint({shape:site.shape,door:site.door,...(site.spec??{})},site.x,0,site.z),xs=b.map(p=>p.x),zs=b.map(p=>p.z);
      return {x1:Math.min(...xs)-1,x2:Math.max(...xs)+1,z1:Math.min(...zs)-1,z2:Math.max(...zs)+1};}catch{return null;}}).filter(Boolean),
      ...configs.map(c=>homeOf(c.id)).filter(Boolean).map(h=>({x1:h.x-1,x2:h.x+5,z1:h.z-1,z2:h.z+5}))];})();
  const city=createCityBoard({state:town.city??={},sites:SITES,town,save:()=>memory.flush(),start:startBuilding,finish:finishBuilding,projects:()=>Object.values(memory.data.agents).map(s=>s.project).filter(Boolean)});
  const community=createCommunityBoard({state:town.community??={},configs,
    save:()=>memory.flush(),stock:()=>town.stock.items,act,log,ledger,goToWarehouse,withdraw,deposit:(id,item,n)=>deposit(id,item,n,id,{strict:true}),travel,
    land:()=>({zones:town.zones,footprints:footprints(),roads:ROADS,farms:(town.farmPlots??[]).flatMap(p=>p.tiles??[]),playerEdits:T.playerEdits,protectedAt:noTouch})});

  return {
    SITES,ROADS,
    communityJob:(c,s,self)=>community.job(c,s,self),
    tasks,runTask,award,befriend,levelFor,checkBlueprint,checkFarm,proposeZone,onProposalResolved,onProjectDone,postQuest,
    batchFor:id=>batchFor(levelFor(id)),
    /** Until the warehouse exists there is nowhere to fetch materials from, so building is free. */
    economyReady:()=>!!town.built.warehouse,
    raidActive:()=>raid.active,
    // Shared helpers for role modules (e.g. roles/fisher.mjs).
    workshopSpot,goToWarehouse,deposit,withdraw,ready,traderJob,traderOnDuty,stockMarket,marketSpot,runnerDue:()=>!!(supplyErrand()||nextDelivery(town.deliveries??[],town.stock.items)||(shopReady('merchant')||shopReady('chef'))&&Object.values(town.marketQueue??{}).some(n=>n>0)),scoutJob,scouting:()=>town.scouting??null,shopFor,shopReady,trimShelves,queueForMarket:(item,n)=>{const q=town.marketQueue??={};q[item]=(q[item]??0)+n;},hasRunner:()=>!!byRole('courier'),marketReady:()=>shopReady('merchant'),shopStock:shop=>shopState(shop).stock?.items??{},marketView:()=>Object.fromEntries(Object.keys(SHOPS).map(k=>[k,{name:SHOPS[k].name,open:shopReady(k),spot:shopSpot(k),stock:shopState(k).stock??null}])),postAllSigns,supplyDemand,minerOrders,standing,counter:()=>town.counter,surveyWarehouse,reachChest,warehouseDirectory:()=>town.warehouseDirectory??null,warehouseMap:()=>wmap,noteChest,getMaterialLocation,refreshStock,notePlayerEdit,terrainView:()=>({pending:T.fills.length,found:T.found,filled:T.filled,next:T.next}),woodWanted:()=>standing().some(o=>o.role==='lumberjack'),reservationsView:()=>reservations.view(),
    governorOf,prices,pantryStatus,shelterList,rewardFor,leavePickup,buildSite,stockItems:()=>town.stock.items,eatJob,warehouseExit,doorwayExit,warehouseFloor:()=>town.warehouseFloor,onPlayerChat,requestBuild,plotJob,scanFarms,scheduleFestival,sites:SITES,
    /** Footprints (with a 1-block margin) of the town's buildings and homes: logs there are timber, not trees. */
    footprints,
    /** An agent sheltering from an alert stays put (no crowd shuffling). */
    prepareProject,requestFurnish,hallLayout,hallReady,inHall,floorAt,hallCourt,furnishHall,onDamage,repairsOpen:()=>repairList.length,tableProposal,proposalContext,serviceWork,jailSite,courtLayout,infirmaryLayout:clinicLayout,bakeryLayout:kitchenLayout,fetchFood,dawnQuests,bankVault,bankCounter,levelFor,tavernSpot:()=>town.built.tavern&&town.sites?.tavern?{x:town.sites.tavern.x+4.5,y:town.sites.tavern.y+1,z:town.sites.tavern.z+5.5}:null,
    /** Town layers for the map: building sites and finished buildings, homes, farm plots and recent damage. */
    mapLayers(){
      const nameOf=id=>configs.find(c=>c.id===id)?.name??id,places=[],points=[];
      for(const [id,st] of Object.entries(SITES)){
        const built=!!town.built[id],chosen=town.sites?.[id];if(!built&&!chosen)continue;
        const fp=siteFootprint(st),design=town.designs?.[id];
        places.push({id:`site-${id}`,kind:built?'built':'site',label:siteName(id),detail:(built?'Built':'Building site')+(design?.label?` - ${design.label} design`:''),x1:fp.x1,z1:fp.z1,x2:fp.x2,z2:fp.z2,...(chosen?.y?{y:chosen.y}:{})});
      }
      for(const [id,lot] of Object.entries(memory.data.village?.homes??{}))
        places.push({id:`home-${id}`,kind:'home',label:`${nameOf(id)}'s home`,detail:memory.data.village?.built?.[id]?'Home':'Home (not built yet)',x1:lot.x,z1:lot.z,x2:lot.x+4,z2:lot.z+4});
      (town.farmPlots??[]).forEach((p,i)=>{const t=p.tiles??[];if(!t.length)return;
        places.push({id:`farm-${i}`,kind:'farm',label:'Farm plot',detail:`${p.cells??''} cells${t[0].crop?` of ${String(t[0].crop).toLowerCase()}`:''}`,
          x1:Math.min(...t.map(x=>x.x1)),z1:Math.min(...t.map(x=>x.z1)),x2:Math.max(...t.map(x=>x.x2)),z2:Math.max(...t.map(x=>x.z2))});});
      for(const s of town.damage?.sites??[])if(Date.now()-s.at<3600000)
        points.push({id:`dmg-${s.at}`,kind:'damage',label:`${String(s.cause).toLowerCase()} damage`,detail:`${s.built} building and ${s.ground} ground blocks - ${repairList.some(b=>Math.hypot(b.x-s.x,b.z-s.z)<10)?'being repaired':'repaired'}`,x:s.x,y:s.y,z:s.z});
      return {places,points};
    },
    sheltering:id=>!!town.alert&&!ALERT_EXEMPT.has(roleOf(configs.find(c=>c.id===id)??{id})),
    placeToolOrder(agent,tool){town.toolOrders[agent]=tool;},
    commands:['prices','council','alert','plans','build','farm'],
    command:(data,args)=>command(data,args),
    /** Called every worker tick before per-agent jobs. */
    async tick(){
      if(ready('farmscan',600000)){const snap=getSnapshot(),who=byRole('farmer')?.id;const agent=snap?.agents.find(a=>a.id===who)?.id??snap?.agents[0]?.id;if(agent)scanFarms(agent).catch(error=>log('farm_scan_error',{message:error.message}));}
      tick++;updateAllNeeds();scheduleTick();
      await community.tick();
      await city.tick();
      if(Date.now()-lastDamagePoll>(repairList.length||!lastDamagePoll?20000:300000))pollDamage().catch(error=>log('repair_error',{message:error.message}));
      sweepTerrain().catch(error=>log('terrain_error',{message:error.message}));
      if(Date.now()-lastStock>30000){lastStock=Date.now();refreshStock();}
      if(ready('prices',300000))updatePrices().catch(()=>{});
      if(Date.now()-climateSent>600000&&ready('climate',30000))sendClimate().catch(()=>{});
      const snap=getSnapshot();
      if(snap&&town.unlocked.length<MILESTONES.length){
        const status={homes:Object.values(memory.data.village?.built??{}).filter(Boolean).length,stock:town.stock.items,kills:town.kills,ledger:memory.data.ledger.length};
        for(const m of newlyUnlocked(status,town.unlocked)){
          town.unlocked.push(m.id);ledger('scribe',`milestone reached (${m.need}): the ${m.name.toLowerCase()} can now be built`);
          const scribe=byRole('scribe');if(scribe)say(scribe.id,`Hear ye! ${m.need} - the town may now build a ${m.name.toLowerCase()}!`);
        }
      }
    },
    /** True when a tired or hungry agent should skip this tick. */
    skip(c){const s=stateOf(c.id);return paceOf(s?.needs??NEEDS_START,levelFor(c.id))===2&&tick%2===1;},
    /** Jobs that come before normal work: eating, the guardian's retreat, meetings and festivals, fetching materials, deputy duty. */
    urgentJob(c,s,self,guardStep){
      // One job owner per citizen: a builder on a project or a miner on a dig is interrupted only by emergencies;
      // ordinary needs and duties wait for a breakpoint (a layer done, a scaffold down, a blocker) - or a deadline.
      const owner=s.project&&s.project.status!=='PARKED'?'build':s.dig?'dig':null;
      const atBreak=!owner||(owner==='build'?!!d.construction?.()?.breakpoint(s.project):false);
      const meal=mealDecision(needsOf(s.needs),{owner:!!owner,breakpoint:atBreak,hungrySince:s.hungrySince,now:Date.now()});
      s.hungrySince=meal.hungrySince;
      // A meal that found no food (warehouse unreachable or empty) is not retried every 15 s: work goes on for two
      // minutes first (the builder broke off the library every tick, walking at a warehouse he could not reach).
      // A meal trip under way (walking to the warehouse counter) carries on until they get there (2 minutes at most):
      // it used to be one try per tick - the first tick only started the walk, was counted as "no food reached", and
      // the builder went back to the site for two minutes, never arriving, never eating.
      const trip=s.mealTrip&&Date.now()-s.mealTrip<120000;
      if(meal.eat&&(trip||Date.now()-(s.mealFailAt??0)>120000&&ready(`eat:${c.id}`,15000))){
        if(owner&&!trip)log('meal_break',{agent:c.id,job:owner,reason:meal.reason});
        return async()=>{const before=needsOf(s.needs).hunger;const r=await eatJob(c,s,self);
          if(r==='walking'){s.mealTrip??=Date.now();return;}
          s.mealTrip=null;
          // needsOf: hunger 0 (full) .. 1 (starving); a meal lowers it.
          if(needsOf(s.needs).hunger>=before){s.mealFailAt=Date.now();log('meal_failed',{agent:c.id,why:'no food reached; back to work, trying again in 2 minutes'});}
          else s.mealFailAt=0;
          if(s.project){s.project.atBreak=false;s.project.placedSinceBreak=0;}};
      }
      if(meal.wait&&owner&&ready(`meal-wait:${c.id}`,600000))log('meal_deferred',{agent:c.id,job:owner,until:'next breakpoint'});
      if(roleOf(c)==='guardian'&&self.health<8)return async()=>{if(!await guardianOverride(c,s,self))await guardStep(c,self);};
      // Curfew or raid: everyone but the guard goes to the nearest shelter and stays inside (not those far away on a trip).
      if(town.alert&&!ALERT_EXEMPT.has(roleOf(c))&&!s.angler?.trip){const f=shelterFor(c,self);if(f&&dist(self,f.sh)<90)return ()=>shelterJob(c,s,self);}
      if(s.sheltered&&!town.alert)s.sheltered=null;
      // Meetings sit at the town hall's table once it is furnished (council and town meetings alike).
      if(town.councilMeeting?.start&&!town.councilMeeting.decided&&!s.dig&&atBreak&&roleOf(c)!=='guardian'&&!s.angler?.trip)return hallReady()?()=>hallSeat(c,self,councilPlace()):()=>gather(c,self,councilPlace(),5);
      if(town.meeting&&town.meeting.day===town.day&&!s.dig&&atBreak&&roleOf(c)!=='guardian')return hallReady()?()=>hallSeat(c,self,SQUARE):()=>gather(c,self,SQUARE,4);
      // Festivals: everyone nearby joins; a miner down the shaft or a woodsman deep in the forest keeps working.
      if(town.festival?.held&&!owner&&roleOf(c)!=='guardian'&&self.y>=60&&dist(self,town.festival.place)<80)return ()=>gather(c,self,town.festival.place,town.festival.radius??5);
      // The warehouse chest upgrade comes before any other building work.
      if(roleOf(c)==='builder'&&atBreak&&town.built.warehouse&&(town.largeChests?.length??0)<LARGE_CHESTS.length&&dayPhase(getSnapshot()?.worldTime)!=='night'&&ready('large-chests',20000))return ()=>largeChestJob(c,self);
      if(!owner&&(town.lampPosts??[]).some(p=>p.owner===c.id&&p.status==='building')&&lightingWanted(c,s,self))return ()=>lightingJob(c,s,self);
      if(repairCrew(c,s,self))return ()=>repairJob(c,s,self);
      if(!owner&&lightingWanted(c,s,self))return ()=>lightingJob(c,s,self);
      if(s.project?.waiting&&Date.now()>(s.project.waitUntil??0))return ()=>fetchForProject(c,s,self);
      if(roleOf(c)==='crafter'&&town.built.warehouse&&dayPhase(getSnapshot()?.worldTime)!=='night'&&(s.supply||(ready(`supply-check:${c.id}`,15000)&&supplyDemand().length)))return ()=>supplyJob(c,s,self);
      if(town.built.warehouse&&!s.dig&&atBreak&&dayPhase(getSnapshot()?.worldTime)!=='night'&&!raid.active&&dropOffItems(self.inventory,roleOf(c)).length&&haulsOwnGoods(c,self.inventory)&&ready(`dropoff:${c.id}`,45000))
        return ()=>dropOffJob(c,s,self);
      // The smith left a replacement tool in the warehouse: fetch it and put it to use.
      const pickup=(town.pickups?.[c.id]??[])[0];
      if(pickup&&town.built.warehouse&&dayPhase(getSnapshot()?.worldTime)!=='night'&&ready(`pickup:${c.id}`,15000))return async()=>{
        if(!await goToWarehouse(c.id,self))return;
        const got=await withdraw(c.id,pickup.item,pickup.count);town.pickups[c.id].shift();
        if(got)ledger(c.id,`picked up ${got} ${pickup.item.toLowerCase().replace(/_/g,' ')} left for them at the warehouse`);
      };
      const order=town.toolOrders[c.id];
      if(order&&town.built.warehouse&&dayPhase(getSnapshot()?.worldTime)!=='night'&&ready(`tool:${c.id}`,8000))return ()=>toolPickupJob(c,s,self,order);
      return null;
    },
    nightChore,
    /** Routine jobs when nothing else is going on in daylight. */
    routineJob(c,s,self,night,nextHome){
      if(night)return null;
      if(roleOf(c)==='builder'&&!s.project)return async()=>{if(!await builderWork(c,s,nextHome))await d.idle(c,self);};
      if(roleOf(c)==='crafter'&&town.built.warehouse&&Date.now()>(s.nextProduction??0))return ()=>productionJob(c,s,self);
      if(roleOf(c)==='merchant'){const t=traderJob(c,s,self,night);if(t)return t;}
      if(roleOf(c)==='merchant'&&town.market?.day===town.day&&dist(self,MARKET)>3)return ()=>gather(c,self,MARKET,0.5);
      if(town.built.warehouse&&courierId()===c.id&&(s.errand||Date.now()>(s.nextErrand??0)))return ()=>courierJob(c,s,self);
      // Food is hauled early (12+ crops); other goods once there is a real load (48+).
      const surplus=surplusOf(c,self.inventory),food=surplus.filter(([k])=>CROPS.has(k)).reduce((n,[,k])=>n+k,0);
      if(s.sellAtMarket?.length&&!s.project&&!s.dig&&roleOf(c)!=='merchant')return ()=>haulJob(c,s,self);   // goods the warehouse would not take, to sell
      if(town.built.warehouse&&roleOf(c)!=='merchant'&&!s.project&&!s.dig&&haulsOwnGoods(c,self.inventory)&&(food>=12||surplus.reduce((n,[,k])=>n+k,0)>=48))return ()=>haulJob(c,s,self);
      return null;
    },
    markWaiting(project){project.waiting=true;},
    guardianOverride,
    onTrade(data){
      if(data.kind==='tool_broke'){town.toolBreaks=[...(town.toolBreaks??[]),{agent:data.agent,tool:data.item,time:Date.now()}].slice(-20);ledger(data.agent,`wore out a ${String(data.item).toLowerCase().replace(/_/g,' ')}`);return;}
      if(data.kind==='received'&&data.from&&!ids.includes(data.from))deliver(data.agent,data.from,data.item,data.count);
      if(data.kind==='traded')for(const [item,n] of Object.entries(data.received??{}))deliver(data.agent,data.player,item,n);
      if(data.kind==='give'&&ids.includes(data.to)){befriend(data.agent,data.to,1);award(data.agent,'trade');}
      if(data.kind==='traded'||data.kind==='received')award(data.agent,'trade',0.5);
    },
    onKill(id){town.kills++;town.today.kills++;award(id,'kill');},
    onHarvest(id,n){town.today.harvested+=n;award(id,'harvest',n);},
    onTell(from,to){befriend(from,to,0.2);},
    onSeparate(a,b){if(ids.includes(a)&&ids.includes(b)&&ready(`bump:${[a,b].sort().join('|')}`,1800000))intel()?.social.adjustPair(a,b,EFFECTS_BUMP,'bumped','kept standing in the way');},
    /** Model-issued deposit/withdraw: only inside the warehouse. */
    async warehouseAction(id,action,self){
      const w=warehouse();if(!w)throw Error('The warehouse is not built yet');
      if(dist(self,w)>3)throw Error(`Walk into the warehouse first (${Math.floor(w.x)},${Math.floor(w.z)})`);
      const item=action.target.toUpperCase(),n=action.count||64;
      const got=action.type==='deposit'?await deposit(id,item,Math.min(n,self.inventory?.[item]??0)):await withdraw(id,item,n);
      if(!got)throw Error(action.type==='deposit'?`You have no ${item}`:`The warehouse has no ${item}`);
      return {[action.type==='deposit'?'deposited':'withdrew']:got,item};
    },
    questsText(){const open=intel()?.board.active()??[];return open.length?open.slice(0,6).map(o=>`#${o.number} ${intel().nameOf(o.issuer_name)}: ${o.quantity-o.delivered} ${String(o.target_item??o.order_type).toLowerCase().replace(/_/g,' ')} for ${o.reward_emeralds} emeralds`):['No open work orders right now.'];},
    async mediate(id,action){
      const [a,b]=String(action.target).split(/[,\s]+/);
      const conflict=town.conflicts.find(x=>!x.resolved&&((x.a===a&&x.b===b)||(x.a===b&&x.b===a)));
      if(!conflict)throw Error('No open conflict between those two');
      conflict.resolved=true;conflict.resolution=action.text;befriend(a,b,2.5);befriend(id,a,0.5);befriend(id,b,0.5);
      ledger(id,`settled the dispute between ${a} and ${b}: ${action.text}`);return {resolved:conflict.id};
    },
    /** Extra planning context for the model. */
    context(c,s){
      const lvl=levelFor(c.id),rel=relations(c.id);
      return {
        needs:{...(s.needs??NEEDS_START),feeling:wellbeing(s.needs??NEEDS_START)},skill:{level:lvl,title:TITLES[lvl-1],xp:s.xp??0},
        diary:(s.diary??[]).slice(-3),friends:rel.friends.slice(0,3),rivals:rel.rivals.slice(0,3),
        town:{logistics:byRole('courier')?`${nameOf(byRole('courier').id)} handles all citizen item and food fetch requests and carries deliveries. ${nameOf(byRole('clerk')?.id??'clerk')} stays in the warehouse sorting, filing and consolidating chests. Ask the runner for deliveries, not the clerk.`:'Collect goods at the warehouse counter.',day:town.day,phase:dayPhase(getSnapshot()?.worldTime),marketDay:isMarketDay(town.day),warehouse:town.built.warehouse?{x:SITES.warehouse.x+4,z:SITES.warehouse.z+3,...(town.warehouseDirectory?{chests:`The chests are in the walls - ${town.warehouseDirectory}.${wmap.retiredLeft(town.stock?.chests??[]).length?" The old floor chests in the middle are being emptied: never put anything in them.":""}`}:{}),knownStock:d.knownStock?.(c.id),stock:d.knownStock?undefined:Object.fromEntries(Object.entries(town.stock.items).sort((a,b)=>b[1]-a[1]).slice(0,20))}:'not built yet',
          zones:town.zones.filter(z=>z.status==='adopted').map(z=>`${z.id} ${z.name} (${z.kind}) ${z.x1},${z.z1}-${z.x2},${z.z2}`),
          quests:(intel()?.board.open()??[]).slice(0,6).map(o=>`#${o.number} ${o.issuer_name} needs ${o.quantity-o.delivered} ${o.target_item??o.order_type} (reward ${o.reward_emeralds} emeralds)`),
          milestones:MILESTONES.map(m=>({name:m.name,unlocked:town.unlocked.includes(m.id),built:!!town.built[m.id]})),
          conflicts:(roleOf(c)==='governor'||town.governor===c.id)?town.conflicts.filter(x=>!x.resolved).map(x=>({between:`${x.a},${x.b}`,topic:x.topic})):undefined,
          economy:'Placing blocks uses items from your inventory; fetch them from the warehouse (withdraw) or ask the crafter, merchant or miner.',
          hauling:byRole('courier')?(roleOf(c)==='courier'?'Hauling goods to the warehouse and fetching supplies for others is your job.':`Hauling goods and fetching supplies is ${byRole('courier').name??byRole('courier').id} the courier's job - there is nothing to argue about; just let them know what you need.`):undefined,
          scarce:scarceFood(prices()),alert:town.alert?`${town.alert.level} alert: stay in shelter`:undefined,readiness:town.readiness,
          climate:{season:seasonOf(town.day),drought:!!town.climate.drought,cropGrowth:`${town.climate.growth??100}%`},
          plans:{funded:town.plan.funded.map(id=>stageOf(id)?.stage.name??id),nextCouncilDay:(town.council.last??0)+COUNCIL_EVERY,lastDecision:town.council.history.at(-1)?.winner?.name},
          building:(pantryStatus()==='healthy'?'Allowed.':`Food first: the pantry is ${pantryStatus()}.`)+' Designs (materials, size) are decided by the citizens\' vote and building sites are surveyed and levelled automatically: never ask players for specs, sizes or materials.',
          designs:Object.entries(town.designs??{}).map(([k,v])=>`${siteName(k)}: ${v.option} (${v.about})`),
          ...(roleOf(c)==='builder'?{buildQueue:{requestedByPlayers:(town.requests??[]).map(siteName),next:town.unlocked.filter(id=>!town.built[id]&&SITES[id]).map(siteName).slice(0,4),
            note:'Buildings are started for you from this queue (site survey, clearing and building happen on their own); in chat, tell people what you are building.'}}:{})}};
    },
    /** Dashboard view of the settlement. */
    view(){
      const status={homes:Object.values(memory.data.village?.built??{}).filter(Boolean).length,stock:town.stock.items,kills:town.kills,ledger:memory.data.ledger.length};
      return {day:town.day,phase:dayPhase(getSnapshot()?.worldTime),marketDay:isMarketDay(town.day),stock:town.stock.items,warehouseBuilt:!!town.built.warehouse,
        community:community.view(),city:{...city.view(),recovery:(town.buildingRecovery??[]).map(r=>{const p=[...Object.values(memory.data.agents).map(s=>s.project),...(town.parkedProjects??[]).map(s=>s.project)].find(p=>p?.completionPlan===r.index);return {...r,status:town.completionInspections?.[r.index]?.verified?'completed':p?'in_progress':'pending',placed:p?.placed,total:p?.total,detail:p?.blocker?.text};})},
        milestones:MILESTONES.map(m=>{const [have,need]=m.progress(status);return {id:m.id,name:m.name,need:m.need,have:Math.min(have,need),goal:need,unlocked:town.unlocked.includes(m.id),built:!!town.built[m.id]};}),
        roads:{done:town.roadsDone,total:ROADS.length,next:ROADS[town.roadsDone]?.name},buildNeeds:town.buildNeeds??[],priorityBuilds:(town.priorityBuilds??[]).map(x=>x.startsWith('complete:')?'complete the '+(completeNames[Number(x.slice(9))]??'#'+x.slice(9)):x),
        zones:town.zones,quests:(intel()?.board.list({limit:20})??[]).map(o=>({id:String(o.number),by:o.issuer_name,item:o.target_item??o.order_type,count:o.quantity,delivered:o.delivered,reward:{item:'EMERALD',count:o.reward_emeralds},note:o.note,status:{OPEN:'open',CLAIMED:'claimed',DELIVERED:'done',VERIFIED:'done'}[o.status]??String(o.status).toLowerCase()})),chronicle:town.chronicle.slice(-10).reverse(),conflicts:town.conflicts.slice(-10).reverse(),
        festival:town.festival,meeting:town.meeting,raid:raid.active,
        buildRequests:(town.requests??[]).map(siteName),
        farms:{plots:(town.farmPlots??[]).length,cells:(town.farmPlots??[]).reduce((n,p)=>n+p.cells,0),tiles:(town.farmPlots??[]).flatMap(p=>p.tiles).map(t=>({x1:t.x1,z1:t.z1,x2:t.x2,z2:t.z2,crop:t.crop,last:t.last??0}))},
        market:{prices:prices(),owed:town.owed,emergency:emergencyActive()?town.emergency:null},
        plans:{progress:planProgress(town.plan.done),funded:town.plan.funded.map(id=>stageOf(id)?.stage.name??id.replace('site:',''))},
        council:{next:(town.council.last??0)+COUNCIL_EVERY,meeting:town.councilMeeting&&{start:town.councilMeeting.start,candidates:town.councilMeeting.candidates,decided:!!town.councilMeeting.decided},history:town.council.history.slice(-5).reverse()},
        climate:{...town.climate,season:seasonOf(town.day)},readiness:town.readiness??'green',alert:town.alert,toolBreaks:(town.toolBreaks??[]).slice(-6).reverse(),toolOrders:town.toolOrders,
        affinity:intel()?.social.pairsAbove(12)??[]};
    },
    agentView(c,s){const lvl=levelFor(c.id);return {needs:s.needs??NEEDS_START,feeling:wellbeing(s.needs??NEEDS_START),level:lvl,title:TITLES[lvl-1],xp:s.xp??0,diary:(s.diary??[]).slice(-5).reverse()};},
  };
}




