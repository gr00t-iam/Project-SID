// Acceptance test: a citizen completes a house - roof included - starting with too few materials, gets supplies
// through other citizens, takes a meal break, resumes after a runtime restart and passes the final blueprint
// inspection. Runs the real construction controller (construction.mjs), placement rules (worker.mjs), reservations
// (reservations.mjs), meal policy (skills/needs.mjs), traits (skills/traits.mjs), the miner's survey/expansion
// planner (roles/miner.mjs) and dig rules, against a simulated block world that enforces reach, materials and space.
//   node agent-core/test-construction-pipeline.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {blueprint,digPlan} from './blueprints.mjs';
import {newProject,nextBuildStep,recordPlacements,newDig,nextDigStep,recordDig} from './worker.mjs';
import {createConstruction} from './construction.mjs';
import {createReservations,requestPhase,MINED} from './reservations.mjs';
import {supplySteps,recipeFor} from './materials.mjs';
import {needsOf,mealDecision} from './skills/needs.mjs';
import {traitsFor} from './skills/traits.mjs';
import {surveyNextSite,mineLayout,MINE} from './roles/miner.mjs';
import {openDatabase} from './intel/db.mjs';
import {createSocial} from './intel/social.mjs';
import {phaseOf} from './construction.mjs';

const REACH=7;   // the plugin's build reach in this world (construction plans with REACH-3)
const key=(x,y,z)=>`${x},${y},${z}`;

export async function simulate({maxTicks=4000}={}){
  const failures=[],steps=[],events=[];const check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=Date.parse('2026-10-03T08:00:00Z');const now=()=>t;
  // ---------- the world (the server: survives the runtime restart) ----------
  const world={blocks:new Map(),warehouse:{x:140.5,y:65,z:100.5},stock:{OAK_PLANKS:60,DIRT:64,LANTERN:1}};
  const solid=(x,y,z)=>y<=64||world.blocks.has(key(x,y,z));
  const builder={id:'builder',x:120.5,y:65,z:100.5,inventory:{OAK_PLANKS:20,COBBLESTONE:10},needs:{hunger:13,energy:90}};
  const eye=p=>({x:p.x,y:p.y+1.6,z:p.z});
  const near=(b,p)=>Math.hypot(b.x+0.5-eye(p).x,b.y+0.5-eye(p).y,b.z+0.5-eye(p).z)<=REACH;
  const take=(inv,item,n)=>{if((inv[item]??0)<n)return false;inv[item]-=n;if(!inv[item])delete inv[item];return true;};
  async function act(id,a){
    const p=builder;
    switch(a.type){
      case 'place':{
        if(world.blocks.has(key(a.x,a.y,a.z))||a.y<=64)throw Error('Space occupied; place only into air or grass');
        if(!near(a,p))throw Error('Target outside allowed range');
        if(!take(p.inventory,a.target,1))throw Error(`Out of ${a.target}`);
        world.blocks.set(key(a.x,a.y,a.z),a.target);return {placed:a.target};
      }
      case 'break':case 'clear':{world.blocks.delete(key(a.x,a.y,a.z));(p.inventory.DIRT??=0);p.inventory.DIRT++;return {};}
      case 'climb':{if(solid(Math.floor(a.x),Math.floor(a.y),Math.floor(a.z))||!solid(Math.floor(a.x),Math.floor(a.y)-1,Math.floor(a.z)))throw Error('No room to stand there');Object.assign(p,{x:a.x,y:a.y,z:a.z});return {};}
      case 'scan':{const cells=[];for(const [k,type] of world.blocks){const [x,y,z]=k.split(',').map(Number);
        if(x>=a.x&&x<a.x+a.width&&y>=a.y&&y<a.y+a.height&&z>=a.z&&z<a.z+a.depth)cells.push([x,y,z,type,true,false,false]);}return {cells};}
      case 'unstick':{Object.assign(p,{x:world.warehouse.x,y:65,z:world.warehouse.z});return {};}
      default:return {};
    }
  }
  async function walk(id,a){
    const fx=Math.floor(a.x),fy=Math.floor(a.y),fz=Math.floor(a.z);
    if(solid(fx,fy,fz)||solid(fx,fy+1,fz))throw Error('Destination obstructed');
    if(!solid(fx,fy-1,fz))throw Error('Destination obstructed');   // nothing to stand on
    Object.assign(builder,{x:a.x,y:a.y,z:a.z});return {};
  }
  // ---------- the town: reservations, social memory, the stub civic services ----------
  const db=openDatabase(':memory:'),social=createSocial(db,{now});
  let memory={data:{town:{},agents:{builder:{}},village:{built:{}}}};
  const onPromise=(b,p)=>{if(p.state==='kept')social.mark(b,p.who,'favor',`brought ${p.item} on time`,0.15);if(p.state==='broken')social.mark(b,p.who,'grudge',`promised ${p.item} and did not bring it`,0.2);};
  let reservations=createReservations(memory.data.town.reservations={},{now,onPromise});
  const finished=[];
  const civic={batchFor:()=>8,economyReady:()=>true,award:()=>{},
    async goToWarehouse(){Object.assign(builder,{x:world.warehouse.x,y:65,z:world.warehouse.z});return true;},
    async withdraw(id,item,n){const k=Math.min(n,reservations.availableFor(id,item,world.stock),world.stock[item]??0);if(k>0){world.stock[item]-=k;builder.inventory[item]=(builder.inventory[item]??0)+k;}return k;},
    onProjectDone(c,p,ok){finished.push({name:p.name,ok});}};
  const traits=traitsFor('builder',{craftsmanship:0.9,tradition:0.6,selfPreservation:0.4,curiosity:0.5,community:0.6,sociability:0.4},'Methodical, proud of his work');
  const makeConstruction=()=>createConstruction({act,walk,placeAll,nextBuildStep,recordPlacements,civic:()=>civic,memory,log:(type,data)=>events.push({type,...data}),
    ledger:()=>{},say:async()=>{},reach:REACH,travel:async(id,self,dest)=>walk(id,dest).catch(()=>Object.assign(builder,{x:dest.x,y:65,z:dest.z})),now,traits:()=>traits});
  async function placeAll(id,blocks){const out=[];for(const block of blocks){try{await act(id,{type:'place',x:block.x,y:block.y,z:block.z,target:block.block});out.push({block,ok:true});}catch(e){out.push({block,ok:false,error:e.message});}}return out;}
  let construction=makeConstruction();
  // ---------- the house: 7 x 7, cobblestone walls, plank floor and roof ----------
  const bp=blueprint({shape:'house',width:7,depth:7,height:4,material:'COBBLESTONE',trim:'COBBLESTONE',roof:'OAK_PLANKS',floor:'OAK_PLANKS',door:'south',windows:false,bed:false},100,65,100);
  const state={project:{...newProject('test house',bp),baseY:65}};
  const need={};for(const b of bp)need[b.block]=(need[b.block]??0)+1;
  steps.push(`house: ${bp.length} blocks (${Object.entries(need).map(([k,n])=>`${n} ${k.toLowerCase()}`).join(', ')}); builder carries ${JSON.stringify(builder.inventory)}, warehouse ${JSON.stringify(world.stock)}`);
  // ---------- the miner and the courier ----------
  const mine={hub:{...MINE.hub},level:0,next:mineLayout().length,phase:'EXCAVATION'};   // the planned tunnels are dug out
  const miner={x:MINE.hub.x+0.5,y:MINE.hub.y,z:MINE.hub.z+0.5,inventory:{},dig:null};
  const minerOrders=()=>{const out={};for(const r of reservations.requests())for(const [item,n] of Object.entries(r.short)){const plan=supplySteps(item,n,{...world.stock});
    for(const [raw,k] of Object.entries(plan.short))if(MINED.has(raw)){(out[raw]??={key:r.key,item:raw,count:0}).count+=k;}}return Object.values(out);};
  function minerTick(){
    const orders=minerOrders();
    if(!orders.length&&!miner.dig)return;
    if(!miner.dig&&mine.phase==='EXCAVATION'&&mine.next>=mineLayout({...MINE,hub:mine.hub}).length){
      const site=surveyNextSite(mine,{orders});events.push({type:'mine_survey',site});
      mine.phase='EXPANSION';mine.expansion={from:site.from,to:site.to};
      miner.dig=newDig('stairs down',digPlan({shape:'stairs',direction:'west',length:site.from.y-site.to.y},site.from.x,site.from.y,site.from.z),{...site.from});miner.dig.expansion=true;return;
    }
    if(!miner.dig&&mine.phase==='EXCAVATION'){const tun=mineLayout({...MINE,hub:mine.hub})[mine.next++];miner.dig=newDig('tunnel',digPlan({shape:'tunnel',direction:tun.direction,length:tun.length},tun.x,tun.y,tun.z),{x:tun.x,y:tun.y,z:tun.z});return;}
    const st=nextDigStep(miner.dig,miner,5);
    if(st.kind==='move'){Object.assign(miner,{x:st.x,y:st.y,z:st.z});return;}
    if(st.kind==='mine'){recordDig(miner.dig,st.blocks.map(b=>({block:b,ok:true,result:{drops:{COBBLESTONE:1}}})));miner.inventory.COBBLESTONE=(miner.inventory.COBBLESTONE??0)+st.blocks.length;}
    if(st.kind==='torch'){st.step.torchPlaced=true;}
    if(st.kind==='done'||nextDigStep(miner.dig,miner,5).kind==='done'){
      if(miner.dig.expansion){mine.hub={...mine.expansion.to};mine.level++;mine.next=0;mine.phase='EXCAVATION';events.push({type:'mine_expanded',hub:mine.hub});}
      miner.dig=null;
    }
    // A load for the order: to the warehouse; the deposit confirms the miner's promise.
    for(const o of orders)if((miner.inventory[o.item]??0)>=Math.min(32,o.count)){
      const n=miner.inventory[o.item];delete miner.inventory[o.item];world.stock[o.item]=(world.stock[o.item]??0)+n;
      for(const r of Object.values(memory.data.town.reservations.list))if(r.promises.some(p=>p.state==='open'&&p.who==='miner'&&p.item===o.item))reservations.delivered(r.key,o.item,n,'miner');
      events.push({type:'miner_delivered',item:o.item,count:n});
    }
  }
  function crafterTick(){   // the crafter fells and crafts what was promised (16 planks a visit), into the warehouse
    for(const r of Object.values(memory.data.town.reservations.list))for(const p of r.promises.filter(p=>p.state==='open'&&p.who==='crafter')){
      world.stock[p.item]=(world.stock[p.item]??0)+16;reservations.delivered(r.key,p.item,16,'crafter');events.push({type:'crafter_delivered',item:p.item,count:16});
    }
  }
  function courierTick(){   // the courier brings what is reserved to the builder; each give is confirmed
    for(const r of Object.values(memory.data.town.reservations.list)){
      const items=Object.entries(r.reserved??{}).filter(([,n])=>n>0);if(!items.length)continue;
      for(const [item,n] of items){const k=Math.min(n,world.stock[item]??0);if(k<1)continue;world.stock[item]-=k;builder.inventory[item]=(builder.inventory[item]??0)+k;reservations.delivered(r.key,item,k,'courier');}
      reservations.delivered(r.key,'*reserved',1,'courier');events.push({type:'courier_delivered',items:Object.fromEntries(items)});
    }
  }
  function supply(s){   // civic.fetchForProject's request, through the same requestPhase
    const p=s.project,pending=p.queue.filter(b=>!b.clear);if(!pending.length){p.waiting=false;return;}
    const phase=phaseOf(p,Math.min(...pending.map(b=>b.y)));
    const want={};for(const b of pending.filter(b=>phaseOf(p,b.y)===phase))want[b.block]=(want[b.block]??0)+1;
    const r=requestPhase(reservations,{key:'builder:test house',builder:'builder',project:p.name,phase,need:want,stock:world.stock,have:builder.inventory,roles:{crafter:'crafter',miner:'miner',courier:'courier'},dueMs:600000},{supplySteps,recipeFor});
    p.materials={missing:{...r.missing,...r.unsupplied},assigned:r.assigned,nextCheck:now()+30000};
    p.waiting=r.waiting;p.waitUntil=now()+30000;
    if(Object.keys(r.missing).length)events.push({type:'shortage',phase,missing:r.missing,assigned:r.assigned});
  }
  // ---------- the day ----------
  let hungrySince=null,lunches=0,restarted=false,firstBlocker=null,sawScaffold=false;
  const cfg={id:'builder',role:'builder'};
  for(let tick=0;tick<maxTicks;tick++){
    t+=5000;
    // A parked project comes back at its next check (builderWork does this in town).
    if(!state.project){if(!(memory.data.town.parkedProjects??[]).length)break;if(!construction.resumeParked(cfg,state))continue;events.push({type:'resumed'});}
    builder.needs.hunger=Math.max(0,builder.needs.hunger-5/70);   // heavy work
    const p=state.project;
    const meal=mealDecision(needsOf(builder.needs),{owner:true,breakpoint:construction.breakpoint(p),hungrySince,now:now()});
    hungrySince=meal.hungrySince;
    if(meal.eat){builder.needs.hunger=20;lunches++;events.push({type:'meal_break',reason:meal.reason,placed:p.placed,phase:phaseOf(p,p.queue[0]?.y??65)});p.atBreak=false;p.placedSinceBreak=0;hungrySince=null;continue;}
    if(p.waiting&&now()>=(p.waitUntil??0))supply(state);
    if(p.blocker&&!firstBlocker)firstBlocker=p.blocker.text;
    await construction.step(cfg,state,builder);
    if(state.project?.blocker&&!firstBlocker)firstBlocker=state.project.blocker.text;
    if(state.project?.scaffold)sawScaffold=true;
    minerTick();if(tick%6===0)crafterTick();if(tick%3===0)courierTick();reservations.expire();
    // The runtime restarts in the middle of the roof: everything in memory goes through JSON and is rebuilt.
    if(!restarted&&sawScaffold&&state.project&&!state.project.scaffold&&state.project.placed>bp.length*0.6){
      restarted=true;
      const saved=JSON.parse(JSON.stringify({memory:memory.data,state}));
      memory={data:saved.memory};Object.assign(state,saved.state);
      reservations=createReservations(memory.data.town.reservations,{now,onPromise});
      construction=makeConstruction();
      events.push({type:'restart',placed:state.project.placed,queue:state.project.queue.length});
    }
  }
  // ---------- checks ----------
  const done=events.find(e=>e.type==='project_done');
  const shortageText=events.find(e=>e.type==="build_blocked_status"&&/missing \d+ cobblestone/.test(e.text))?.text;
  check(shortageText&&/Miner|digging/.test(shortageText)&&/Next check in \d+ seconds/.test(shortageText),`the shortage is reported as a blocker that names it (${shortageText})`);
  check(/courier is bringing/.test(firstBlocker??""),`waiting for a delivery says so (${firstBlocker})`);
  check(events.some(e=>e.type==='shortage'&&e.missing.COBBLESTONE&&e.assigned.miner==='miner'),'the cobblestone shortage is promised by the miner');
  check(events.some(e=>e.type==='shortage'&&e.assigned.courier==='courier')||events.some(e=>e.type==='courier_delivered'),'a courier is assigned to carry the reserved goods');
  check(events.some(e=>e.type==='mine_survey'&&e.site.kind==='level')&&events.some(e=>e.type==='mine_expanded'),'the miner surveys and opens a new level instead of stopping');
  check(events.some(e=>e.type==='miner_delivered'&&e.item==='COBBLESTONE'),'the miner delivers cobblestone to the warehouse');
  check(events.some(e=>e.type==='courier_delivered'),'the courier delivers to the builder');
  check(social.relationship('builder','miner').favors.length>0||social.relationship('builder','courier').favors.length>0,'kept promises become favours in the builder\'s memory');
  check(lunches>=1&&events.some(e=>e.type==='meal_break'&&/natural break|overdue/.test(e.reason)),`the builder takes a meal at a sensible point (${lunches} meals)`);
  check(sawScaffold&&events.some(e=>e.type==='scaffold_planned'),'the roof is reached with scaffolding planned per section');
  check(restarted,'the runtime restarted in the middle of the build');
  check(!!done&&finished.some(f=>f.ok),'the house is finished after the restart');
  const insp=events.filter(e=>e.type==='build_inspection').at(-1);
  check(insp&&insp.pct===100&&insp.matched===insp.total,`the final inspection matches the blueprint 100% (${insp?.matched}/${insp?.total})`);
  const missingNow=bp.filter(b=>world.blocks.get(key(b.x,b.y,b.z))!==b.block);
  check(missingNow.length===0,`every blueprint block is in the world (${missingNow.length} missing)`);
  check(!events.some(e=>e.type==='project_done'&&!e.verified),'nothing was reported done without the inspection');
  steps.push(`blockers: "${firstBlocker}" / "${shortageText}"`);
  steps.push(`supply: ${events.filter(e=>/delivered/.test(e.type)).length} deliveries; mine level ${mine.level} at y=${mine.hub.y}; meals ${lunches}; scaffolds ${events.filter(e=>e.type==='scaffold_planned').length}; restart at ${events.find(e=>e.type==='restart')?.placed} placed`);
  steps.push(`inspection: ${insp?.matched}/${insp?.total} (${insp?.pct}%) after ${insp?.pass} pass(es); deferred blocks retried: ${events.filter(e=>e.type==='build_access_deferred').length}`);
  return {failures,steps,events};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();
  for(const s of r.steps)console.log('-',s);
  if(r.failures.length){console.log('\nFAILED:\n - '+r.failures.join('\n - '));process.exit(1);}
  console.log('\nAll checks passed: short of materials -> blocker, reservation, miner expansion, deliveries, meal break, scaffolds, restart, 100% inspection.');
}
