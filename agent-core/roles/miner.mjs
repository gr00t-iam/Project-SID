import {capOf} from '../skills/supply.mjs';
// Dorn the Miner: the town's ore supply, on his own (until now mining only happened when his model chose to dig,
// and twice in a day is not a mine). Daytime routine:
//
//   pickaxe     carry one (iron > stone > wood); else take one from the warehouse or craft one
//   descend     walk down the staircase west of spawn to the mine hub at its foot (y 47)
//   branch-mine tunnels from the hub: a main gallery west in 12-block legs, side branches north and south every
//               4 blocks (16 long) - the classic strip-mine; each tunnel is a normal dig (worker.mjs) with torches
//   follow veins every few seconds underground, ore showing within 4 blocks of him is dug out
//   surface     carrying 128+ ore and stone (or at dusk): back up to the pithead, where the courier collects
// The layout and progress live in town.mine; the plan functions are pure (tested in tests/miner.test.mjs).
//
// When the planned tunnels run out the mine is not "finished": SURVEY -> EXPANSION -> EXCAVATION.
//   SURVEY      choose the next site: a clay pit when a builder is short of clay (bricks), otherwise the next level
//               down (12 blocks below the current hub; sideways 64 blocks once 40 below sea level)
//   EXPANSION   dig the access: a staircase down to the new level (a normal dig), or register the clay pit with the
//               plugin as an excavation site (mining above y=50 is only allowed in registered sites)
//   EXCAVATION  the strip-mine of the new level (same layout around the new hub), or the clay dug out of the pit
// Supply orders (reservations.mjs: cobblestone, clay...) take the haul straight to the warehouse, where the builder's
// reservation picks it up; the delivery counts toward the miner's promise.
import {digPlan} from '../blueprints.mjs';
import {newDig} from '../worker.mjs';

export const MINE={hub:{x:240,y:47,z:112},pithead:{x:263,y:68,z:112},   // pithead: standing height (the ground is at 67; 69 was a block in the air)
  legLength:12,branchEvery:4,branchLength:16,maxLegs:6};
export const ORES=['COAL_ORE','IRON_ORE','COPPER_ORE','GOLD_ORE','REDSTONE_ORE','LAPIS_ORE','DIAMOND_ORE','EMERALD_ORE',
  'DEEPSLATE_COAL_ORE','DEEPSLATE_IRON_ORE','DEEPSLATE_COPPER_ORE','DEEPSLATE_GOLD_ORE','DEEPSLATE_REDSTONE_ORE','DEEPSLATE_LAPIS_ORE','DEEPSLATE_DIAMOND_ORE'];
// Everything he brings up: ore and the stone itself (andesite, diorite, granite and tuff were never counted, so the
// warehouse saw no stone for days while he carried 160 blocks of it).
const LOAD=/^(RAW_|COAL$|DIAMOND$|EMERALD$|REDSTONE$|LAPIS_LAZULI$|COBBLESTONE$|COBBLED_DEEPSLATE$|STONE$|ANDESITE$|DIORITE$|GRANITE$|TUFF$|DEEPSLATE$|CALCITE$|GRAVEL$|FLINT$|COPPER_ORE$|IRON_ORE$|AMETHYST_SHARD$)/;
export const PICKAXES=['NETHERITE_PICKAXE','DIAMOND_PICKAXE','IRON_PICKAXE','STONE_PICKAXE','WOODEN_PICKAXE'];

/**
 * The strip-mine as a list of tunnels from the hub: main legs west, then for each leg, branches north and south
 * every `branchEvery` blocks along it. Tunnel i is {x,y,z (where he stands to start), direction, length}.
 */
export function mineLayout(m=MINE){
  const out=[];
  for(let leg=0;leg<m.maxLegs;leg++){
    const x0=m.hub.x-leg*m.legLength;
    out.push({x:x0,y:m.hub.y,z:m.hub.z,direction:'west',length:m.legLength,kind:'gallery'});
    for(let k=m.branchEvery;k<=m.legLength;k+=m.branchEvery)
      for(const direction of ['north','south'])out.push({x:x0-k,y:m.hub.y,z:m.hub.z,direction,length:m.branchLength,kind:'branch'});
  }
  return out;
}
/** Weight of goods a miner carries up (ore, raw metals, stone). */
export const loadOf=inv=>Object.entries(inv??{}).filter(([k])=>LOAD.test(k)).reduce((n,[,v])=>n+v,0);
export const bestPickaxe=(held,inv={})=>PICKAXES.includes(held)?held:PICKAXES.find(p=>(inv[p]??0)>0)??null;

/**
 * The next level: 12 below and 12 west of the current hub (the staircase runs west); sideways only at the bottom of the
 * world - the miner may go as deep as he likes, down to just above the bedrock (y=-58).
 */
export function nextLevelHub(hub,{drop=12,minY=-58}={}){
  if(hub.y-drop<minY)return {x:hub.x-64,y:hub.y,z:hub.z,sideways:true};
  return {x:hub.x-drop,y:hub.y-drop,z:hub.z};
}
/** Where to dig next, given the open supply orders: {kind:'clay', centre} or {kind:'level', from, to}. */
export function surveyNextSite(mine,{orders=[],clayCentre={x:276,z:83}}={}){
  const hub=mine.hub??MINE.hub;
  if(orders.some(o=>o.item==='CLAY_BALL')&&!(mine.claySites??[]).some(s=>s.exhausted&&s.x===clayCentre.x&&s.z===clayCentre.z))
    return {kind:'clay',centre:clayCentre,box:{x1:clayCentre.x-12,z1:clayCentre.z-12,x2:clayCentre.x+12,z2:clayCentre.z+12}};
  return {kind:'level',from:hub,to:nextLevelHub(hub)};
}

export function createMiner(d){
  const {memory,configs,act,say,log,ledger,getSnapshot,travel,civic=()=>null,now=()=>Date.now(),random=Math.random}=d;
  const town=memory.data.town??={};
  const mine=town.mine??={next:0,tunnels:0,ore:{},blocked:[]};
  mine.hub??={...MINE.hub};mine.level??=0;mine.phase??='EXCAVATION';
  const layoutFor=hub=>mineLayout({...MINE,hub});
  let layout=layoutFor(mine.hub);
  // One-time repair (v1): unfinished staircases and unreached tunnels used to count as done, so the mine "expanded"
  // to levels nobody reached (down to y=11 in an hour). Back to the last level really worked; the staircase is dug
  // again from there (blocks already dug count as done) and every tunnel now has to be finished to count.
  if(!mine.levelFixV1){mine.levelFixV1=true;
    if(mine.level>0){log('mine_level_reset',{from:mine.hub,level:mine.level});mine.hub={...MINE.hub};mine.level=0;layout=layoutFor(mine.hub);}
    if(mine.next>=layout.length){mine.phase='EXPANSION';mine.expansion={from:{...mine.hub},to:nextLevelHub(mine.hub)};}else mine.phase='EXCAVATION';
    mine.retry={};}
  // One-time (deep v1): he was stuck a day and a half on his own torch in a sideways gallery at y=23 (fixed in
  // worker.mjs recordDig) after the staircase down "failed" on the same torch. Back to going down from the hub.
  if(!mine.deepV1){mine.deepV1=true;
    if(mine.expansion?.to?.sideways&&mine.hub.y-12>=-58){mine.expansion={from:{...mine.hub},to:nextLevelHub(mine.hub)};mine.expansionFails=0;mine.phase='EXPANSION';
      const st=memory.data.agents?.miner;if(st?.dig?.expansion)st.dig=null;
      log('mine_go_deeper',{from:mine.hub,to:mine.expansion.to});}}
  // One-time (deep v2): the stairs down failed on his own cobblestone floor patch (now broken and taken, main.mjs
  // digStep) and the sideways gallery runs into water at x=199: down again from the hub.
  if(!mine.deepV2){mine.deepV2=true;
    if(mine.expansion?.to?.sideways&&mine.hub.y-12>=-58){mine.expansion={from:{...mine.hub},to:nextLevelHub(mine.hub)};mine.expansionFails=0;mine.phase='EXPANSION';
      const st=memory.data.agents?.miner;if(st?.dig?.expansion)st.dig=null;log('mine_go_deeper',{from:mine.hub,to:mine.expansion.to,v:2});}}
  // One-time repair (v2): retries were shared between levels, so level 2's tunnels were set aside after a single
  // failure. Start the current level's tunnels afresh (dug blocks count as done).
  if(!mine.levelFixV2){mine.levelFixV2=true;mine.retry={};mine.blocked=[];if(mine.phase==='EXCAVATION')mine.next=0;log('mine_retries_reset',{level:mine.level,hub:mine.hub});}
  const said=new Map(),ready=(k,ms)=>{const t=said.get(k)??0;if(now()-t<ms)return false;said.set(k,now());return true;};
  const underground=self=>self.y<MINE.pithead.y-8;
  /**
   * The way down (or up) goes hub by hub: the pithead, then each level's hub down its staircase. One walk from the
   * first level to the third (30 across, 27 down) stalled every time and the dig was given up on the way.
   */
  function via(self,dest){
    const hubs=[{...MINE.pithead}];let h={...MINE.hub};
    for(let i=0;i<=(mine.level??0)+1&&i<12;i++){hubs.push(h);const n=nextLevelHub(h);if(n.sideways)break;h=n;}
    // Above ground and heading down: the mine entrance first (the hub lies under the market hall, not reachable from above).
    const onStairs=Math.abs(self.z-(MINE.hub.z+0.5))<3&&self.x<=MINE.pithead.x+1&&self.x>=MINE.hub.x-40&&self.y<MINE.pithead.y-1;   // already on the way down
    if(dest.y<self.y-2&&!underground(self)&&!onStairs&&Math.hypot(self.x-(MINE.pithead.x+0.5),self.z-(MINE.pithead.z+0.5))>3)return {x:MINE.pithead.x+0.5,y:MINE.pithead.y,z:MINE.pithead.z+0.5};
    // On the way down: 4 steps at a time along the staircase (every flight runs west along z=112, one block down per
    // step); a long pathfind took him over the surface to the spot above the hub instead.
    if(dest.y<self.y-2&&Math.abs(self.z-(MINE.hub.z+0.5))<3){
      const lower=hubs.filter(p=>p.y<self.y-1&&p.y>=dest.y-1).sort((a,b)=>b.y-a.y)[0];
      if(lower&&self.x>lower.x+1.5){const nx=Math.max(lower.x,Math.floor(self.x)-3);return {x:nx+0.5,y:lower.y+(nx-lower.x),z:lower.z+0.5,hop:true};}
    }
    if(dest.y>self.y+2&&Math.abs(self.z-(MINE.hub.z+0.5))<3){
      const upper=hubs.filter(p=>p.y>self.y+1&&p.y<=dest.y+1).sort((a,b)=>a.y-b.y)[0];
      if(upper&&self.x<upper.x-1.5){const below=hubs.filter(p=>p.y<upper.y).sort((a,b)=>b.y-a.y)[0]??{x:Math.floor(self.x),y:Math.floor(self.y)};
        const nx=Math.min(upper.x,Math.floor(self.x)+3);return {x:nx+0.5,y:Math.min(upper.y,below.y+(nx-below.x)),z:upper.z+0.5,hop:true};}
    }
    if(dest.y<self.y-2){const next=hubs.filter(p=>p.y<self.y-2&&p.y>=dest.y-1).sort((a,b)=>b.y-a.y)[0];if(next)return {x:next.x+0.5,y:next.y,z:next.z+0.5};}
    if(dest.y>self.y+2){const next=hubs.filter(p=>p.y>self.y+2&&p.y<=dest.y+1).sort((a,b)=>a.y-b.y)[0];if(next)return {x:next.x+0.5,y:next.y,z:next.z+0.5};}
    return dest;
  }
  // A hop down the stairs stands on the real step: the column is scanned and the feet put on the nearest step (the
  // entrance flight is a block lower than the level flights).
  async function go(c,self,dest){
    if(self.pathing)return;
    const w=via(self,dest);
    if(w.hop){
      const r=await act(c.id,{type:'scan',x:Math.floor(w.x),y:w.y-4,z:Math.floor(w.z),width:1,height:8,depth:1}).catch(()=>null);
      const solid=new Set((r?.cells??[]).filter(q=>q[4]).map(q=>q[1]));
      const feet=[0,-1,1,-2,2,-3].map(o=>w.y+o).find(y=>!solid.has(y)&&!solid.has(y+1)&&solid.has(y-1));
      if(Number.isFinite(feet)){w.y=feet;
        // Three steps down (or up) the flight at once: the pathfinder would not take the narrow covered stairs.
        if(await act(c.id,{type:'climb',x:w.x,y:w.y,z:w.z}).then(()=>true).catch(()=>false))return;}
    }
    await travel(c.id,self,{x:w.x,y:w.y,z:w.z}).catch(()=>{});
  }
  const nearHub=self=>Math.hypot(self.x-(mine.hub.x+0.5),self.z-(mine.hub.z+0.5))<5&&Math.abs(self.y-mine.hub.y)<3;
  const orders=()=>d.orders?.()??[];   // open supply orders for dug materials: [{key,item,count}]

  /** Dig out ore within 4 blocks of him (veins showing in the tunnel walls). Returns how many were mined. */
  async function followVeins(c,self){
    let got=0;
    for(const ore of ORES.filter(o=>!o.startsWith('DEEPSLATE')||self.y<8)){
      const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:ore,count:4}).catch(()=>[]);
      for(const b of (found??[]).filter(b=>Math.hypot(b.x+0.5-self.x,b.y+0.5-self.y,b.z+0.5-self.z)<=4.5).slice(0,6)){
        const r=await act(c.id,{type:'mine',x:b.x,y:b.y,z:b.z}).catch(()=>null);
        if(r){got++;for(const [k,n] of Object.entries(r.drops??{}))mine.ore[k]=(mine.ore[k]??0)+n;}
      }
    }
    if(got){log('vein_mined',{agent:c.id,blocks:got,at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)}});
      if(ready('vein-say',300000))say(c.id,random()<0.5?'Struck a vein! The rock gives up its treasure.':'Ore in the wall - and now it is in my pack.');}
    return got;
  }

  async function step(c,s,self,dusk){
    const inv=self.inventory??{};
    // Pickaxe first.
    const pick=bestPickaxe(self.held,inv);
    if(!pick){
      if(!civic()?.goToWarehouse)return;
      if(!await civic().goToWarehouse(c.id,self))return;
      for(const p of ['IRON_PICKAXE','STONE_PICKAXE','WOODEN_PICKAXE'])if(await civic().withdraw(c.id,p,1)){await act(c.id,{type:'equip',x:0,y:0,z:0,target:p}).catch(()=>{});return;}
      // None stored: craft a wooden one from planks and sticks.
      await civic().withdraw(c.id,'STICK',2);for(const p of ['OAK_PLANKS','BIRCH_PLANKS','SPRUCE_PLANKS'])if(await civic().withdraw(c.id,p,3))break;
      await act(c.id,{type:'craft',x:0,y:0,z:0,target:'WOODEN_PICKAXE',count:1}).then(()=>act(c.id,{type:'equip',x:0,y:0,z:0,target:'WOODEN_PICKAXE'})).catch(error=>log('miner_error',{agent:c.id,message:error.message}));
      return;
    }
    if(self.held!==pick)await act(c.id,{type:'equip',x:0,y:0,z:0,target:pick}).catch(()=>{});
    // Loaded up, or the day is ending: up to the pithead, where the courier picks up the ore.
    // A supply order for what he carries: straight to the warehouse (the builder's reservation is waiting for it).
    // (only what he mines - never the dirt he carries to climb out with, or his tools and planks)
    const ordered=orders().filter(o=>LOAD.test(o.item)&&o.item!=='DIRT'&&(inv[o.item]??0)>0);
    if(ordered.length&&(loadOf(inv)>=Math.min(64,ordered[0].count)||dusk)&&civic()?.goToWarehouse){
      if(!await civic().goToWarehouse(c.id,self))return;
      for(const o of ordered){const n=await civic().deposit(c.id,o.item,Math.min(inv[o.item],o.count+32),c.id);if(n){d.onDelivered?.(o.key,o.item,n,c.id);log('miner_delivered',{agent:c.id,item:o.item,count:n,for:o.key});}}
      if(ready('deliver-say',600000))await say(c.id,`Dropped ${ordered.map(o=>label(o.item)).join(' and ')} at the warehouse for the builder.`).catch(()=>{});
      return;
    }
    const useful=Object.entries(inv).filter(([k,n])=>LOAD.test(k)&&n>0&&(town.stock?.items?.[k]??0)<capOf(k)).reduce((a,[,n])=>a+n,0);
    if(useful>=128||dusk){
      // Up out of the mine; once on the surface he goes on to the warehouse (going back to the pithead after each
      // step toward the warehouse had him walking between the two for an hour).
      if(underground(self)){await go(c,self,{x:MINE.pithead.x+0.5,y:MINE.pithead.y,z:MINE.pithead.z+0.5});return;}
      // Up top with a load: straight to the warehouse with it (the courier's pickups only ever took cobblestone).
      // What the warehouse is full of (over its cap) goes to a passing caravan at the pithead, not back down the mine.
      if(!underground(self)){const sold={};for(const [k,n] of Object.entries(inv))if(LOAD.test(k)&&n>0&&(town.stock?.items?.[k]??0)>=capOf(k)){const r=await act(c.id,{type:'caravan',x:0,y:0,z:0,target:k,count:n}).catch(()=>null);if(r?.sold)sold[k]=r.sold;}
        if(Object.keys(sold).length)log('caravan_sold',{agent:c.id,items:sold,from:'pithead'});}
      // (only what the warehouse still has room for: over its cap it would be carried back and forth forever)
      const wanted=Object.entries(inv).filter(([k,n])=>LOAD.test(k)&&n>0&&(town.stock?.items?.[k]??0)<capOf(k)).reduce((a,[,n])=>a+n,0);
      if(wanted>=32&&civic()?.goToWarehouse){
        // At the warehouse door he hands it in (into the chests; Jasper files it) - the counter hand-off never came
        // off for him (the doorway rule, a busy counter), so a full pack sent him up and down the stairs all day.
        const wd=town.warehouseRoom?.door,near=wd&&Math.hypot(self.x-wd.x,self.z-(wd.z1??wd.z))<=10;
        if(!near){if(!self.pathing)await civic().goToWarehouse(c.id,self);return;}
        const put={};for(const [k,n] of Object.entries(inv))if(LOAD.test(k)&&n>0&&(town.stock?.items?.[k]??0)<capOf(k)){
          let left=Math.min(n,capOf(k)-(town.stock?.items?.[k]??0));
          while(left>0){const r=await act(c.id,{type:'pay',x:0,y:0,z:0,target:k,count:Math.min(64,left)}).catch(()=>null);if(!r?.paid)break;put[k]=(put[k]??0)+r.paid;left-=r.paid;}
          if(put[k])town.stock.items[k]=(town.stock.items[k]??0)+put[k];}
        if(Object.keys(put).length){log('miner_delivered',{agent:c.id,items:put});ledger(c.id,`brought up ${Object.entries(put).map(([k,v])=>`${v} ${label(k)}`).join(', ')} from the mine to the warehouse`);}
        if(ready('surface-say',600000))await say(c.id,`Up from the deep - ${Object.values(put).reduce((a,b)=>a+b,0)} blocks of stone and ore for the warehouse.`).catch(()=>{});
      }
      return;
    }
    // Underground: veins first, then the next tunnel.
    if(underground(self)&&ready(`veins:${c.id}`,8000)&&await followVeins(c,self))return;
    // The clay pit (EXCAVATION of a surface site).
    if(mine.phase==='CLAY')return clayStep(c,s,self);
    // The planned tunnels are dug out: SURVEY the next site and start the EXPANSION.
    if(mine.next>=layout.length&&mine.phase==='EXCAVATION')return survey(c,s,self);
    if(mine.phase==='EXPANSION')return expand(c,s,self);
    const t=layout[mine.next];
    // Walk down the staircase to the hub before the first tunnel of the day.
    if(!underground(self)&&!nearHub(self)){await go(c,self,{x:mine.hub.x+0.5,y:mine.hub.y,z:mine.hub.z+0.5});return;}
    s.dig=newDig(`${t.kind} ${t.direction} from ${t.x},${t.y},${t.z}`,digPlan({shape:'tunnel',direction:t.direction,length:t.length},t.x,t.y,t.z),{x:t.x+0.5,y:t.y,z:t.z+0.5});
    s.dig.mineTunnel=mine.next;mine.next++;mine.tunnels++;
    log('dig_started',{agent:c.id,name:s.dig.name,tunnel:s.dig.mineTunnel});
    if(ready('tunnel-say',900000))say(c.id,random()<0.5?`Off down the ${t.kind} ${t.direction}. Lamp lit, pick sharp.`:`Another ${t.length} blocks of good rock to the ${t.direction}. Let's see what she hides.`);
  }

  const label=k=>String(k).toLowerCase().replace(/_/g,' ');
  /** SURVEY: pick the next site from the open orders and the mine's state. */
  async function survey(c,s,self){
    const site=surveyNextSite(mine,{orders:orders()});
    mine.survey={...site,time:now()};
    if(site.kind==='clay'){
      // Mining above y=50 needs a registered excavation site: register the pit with the plugin.
      const b=site.box,r=await act(c.id,{type:'site',x:b.x1,y:50,z:b.z1,width:b.x2-b.x1+1,height:30,depth:b.z2-b.z1+1,text:'register'}).catch(e=>({error:e.message}));
      if(r?.error){log('mine_survey_failed',{agent:c.id,site:'clay',reason:r.error});mine.claySites=[...(mine.claySites??[]),{x:site.centre.x,z:site.centre.z,exhausted:true,why:r.error}];return;}
      mine.phase='CLAY';mine.clay={centre:site.centre,dug:0,misses:0};
      log('mine_survey',{agent:c.id,site:'clay pit',at:site.centre});ledger(c.id,`surveyed a clay pit by the lake (${site.centre.x},${site.centre.z}) for the builder's bricks`);
      await say(c.id,'The builder needs clay for bricks - opening a clay pit by the lake.').catch(()=>{});
      return;
    }
    mine.phase='EXPANSION';mine.expansion={from:site.from,to:site.to};
    log('mine_survey',{agent:c.id,site:'level',from:site.from,to:site.to});
    ledger(c.id,`surveyed the next mine level at y=${site.to.y} (from the hub at y=${site.from.y})`);
    await say(c.id,`This level is worked out. Surveyed the next one, ${site.from.y-site.to.y||0} blocks down - starting the stairs.`).catch(()=>{});
  }
  /** EXPANSION: dig the staircase down to the new level (or the sideways gallery), then mine it. */
  async function expand(c,s,self){
    const {from,to}=mine.expansion;
    // At the hub first (the dig used to start on the way down, at y=52, and give up before he got there).
    if(!(Math.hypot(self.x-(from.x+0.5),self.z-(from.z+0.5))<4&&Math.abs(self.y-from.y)<3)){await go(c,self,{x:from.x+0.5,y:from.y,z:from.z+0.5});return;}
    const length=to.sideways?from.x-to.x:from.y-to.y;
    s.dig=newDig(to.sideways?`gallery west to a new mine site`:`stairs down to mine level ${mine.level+1}`,digPlan({shape:to.sideways?'tunnel':'stairs',direction:'west',length},from.x,from.y,from.z),{x:from.x+0.5,y:from.y,z:from.z+0.5});
    s.dig.expansion=true;
    log('dig_started',{agent:c.id,name:s.dig.name,expansion:true});
  }
  /** EXCAVATION of the clay pit: find clay near the lake, dig it, deliver it; a pit with no clay left is closed. */
  async function clayStep(c,s,self){
    const cl=mine.clay,ctr=cl.centre;
    if(Math.hypot(self.x-ctr.x,self.z-ctr.z)>6){await travel(c.id,self,{x:ctr.x+0.5,y:64,z:ctr.z+0.5}).catch(()=>{});return;}
    const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:'CLAY',count:8}).catch(()=>[]);
    const near=(found??[]).filter(b=>Math.hypot(b.x-ctr.x,b.z-ctr.z)<=12).slice(0,6);
    if(!near.length||!orders().some(o=>o.item==='CLAY_BALL')){
      cl.misses++;
      if(cl.misses>=3||!orders().some(o=>o.item==='CLAY_BALL')){
        mine.claySites=[...(mine.claySites??[]),{x:ctr.x,z:ctr.z,exhausted:!near.length,dug:cl.dug}];mine.phase='EXCAVATION';mine.clay=null;
        log('mine_site_closed',{agent:c.id,site:'clay pit',dug:cl.dug,reason:near.length?'order filled':'no clay left'});
        ledger(c.id,near.length?`closed the clay pit: ${cl.dug} clay dug`:`closed the clay pit: no clay left near the lake (${cl.dug} dug)`);
      }
      return;
    }
    for(const b of near){
      const close=Math.hypot(b.x+0.5-self.x,b.y+0.5-self.y,b.z+0.5-self.z)<=4.5;
      if(!close){await travel(c.id,self,{x:b.x+1.5,y:b.y+1,z:b.z+0.5}).catch(()=>{});return;}
      const r=await act(c.id,{type:'mine',x:b.x,y:b.y,z:b.z}).catch(e=>({error:e.message}));
      if(r&&!r.error){cl.dug++;for(const [k,n] of Object.entries(r.drops??{}))mine.ore[k]=(mine.ore[k]??0)+n;}
    }
  }
  return {
    /** Daytime: the mine routine whenever no dig is under way (the dig itself runs in main's digStep). */
    job(c,s,self,night){
      if((c.role??c.id)!=='miner'||night||s.resting||s.project)return null;
      const dusk=['evening','dusk'].includes(d.dayPhase?.(getSnapshot()?.worldTime));
      if(s.dig&&!dusk){
        // Mid-tunnel: pause now and then to dig out ore showing in the walls.
        return underground(self)&&ready(`veins:${c.id}`,8000)?()=>followVeins(c,self):null;
      }
      // Day is ending: put the tunnel down (it is resumed tomorrow - dug blocks count as done) and head up.
      if(s.dig&&dusk){if(s.dig.mineTunnel!=null)mine.next=Math.min(mine.next,s.dig.mineTunnel);s.dig=null;}
      // Dirt to climb out of a hole with (main.mjs climbOut): 32 in the pack, topped up from the warehouse when up top.
      if(!underground(self)&&(self.inventory?.DIRT??0)<8&&(town.stock?.items?.DIRT??0)>=32&&civic()?.withdraw&&!dusk&&(mine.dirtAt??0)<now()-600000)
        return async()=>{mine.dirtAt=now();const got=await civic().withdraw(c.id,'DIRT',32,{procure:false}).catch(()=>0);if(got)log('miner_dirt',{agent:c.id,got});};
      return ()=>step(c,s,self,dusk);
    },
    onDigDone(id,dig,text){
      const finished=text==='finished';
      if(dig?.expansion&&!finished&&!/stopped safely/.test(text)){
        // Not there yet (could not walk on, had to stop): the staircase is resumed later; three tries, then sideways.
        mine.expansionFails=(mine.expansionFails??0)+1;
        log('mine_expansion_incomplete',{agent:id,why:text,attempt:mine.expansionFails});
        if(mine.expansionFails>=3){const from=mine.expansion.from;mine.expansion={from,to:{x:from.x-64,y:from.y,z:from.z,sideways:true}};mine.expansionFails=0;}
        return;
      }
      if(dig?.mineTunnel!=null&&!finished&&!/stopped safely/.test(text)){
        // A tunnel he never got into is not dug: put it back (up to three tries), then set it aside with the reason.
        const k=dig.mineTunnel,n=((mine.retry??={})[k]=(mine.retry[k]??0)+1);mine.tunnels=Math.max(0,mine.tunnels-1);
        if(n<3){mine.next=Math.min(mine.next,k);log('mine_tunnel_retry',{agent:id,tunnel:k,why:text,attempt:n});}
        else{(mine.blocked??=[]).push({tunnel:k,why:text});log('mine_tunnel_blocked',{agent:id,tunnel:k,why:text});}
        return;
      }
      if(dig?.expansion){
        mine.expansionFails=0;
        if(/stopped safely/.test(text)){(mine.blocked??=[]).push({expansion:mine.expansion,why:text});
          // Water or lava in the way: survey again from a level sideways.
          mine.expansion={from:mine.expansion.from,to:{...nextLevelHub(mine.expansion.from,{minY:Infinity}),x:mine.expansion.from.x-64,y:mine.expansion.from.y,sideways:true}};return;}
        mine.hub={...mine.expansion.to};delete mine.hub.sideways;mine.level++;mine.next=0;mine.phase='EXCAVATION';mine.expansion=null;layout=layoutFor(mine.hub);
        mine.retry={};mine.blocked=[];   // a new level: the old level's tunnel numbers and failures do not carry over
        log('mine_expanded',{agent:id,level:mine.level,hub:mine.hub});ledger(id,`opened mine level ${mine.level} (hub at ${mine.hub.x},${mine.hub.y},${mine.hub.z})`);
        say(id,`New level open at y=${mine.hub.y}. Fresh rock, fresh ore.`).catch(()=>{});return;
      }
      if(dig?.mineTunnel==null)return;if(/stopped safely/.test(text))(mine.blocked??=[]).push({tunnel:dig.mineTunnel,why:text});},
    context(c){return (c.role??c.id)==='miner'?{mine:{tunnelsDug:mine.tunnels,next:layout[mine.next]??null,ore:mine.ore,hub:mine.hub,level:mine.level,phase:mine.phase,pithead:MINE.pithead},
      roleGuide:'Your strip-mine runs on its own: down the staircase to the hub, tunnels west with branches north and south, ore dug from the walls, and the haul brought up to the pithead for the courier. In your turns, talk about what the rock gave up today.'}:{};},
    view(){return {tunnels:mine.tunnels,next:mine.next,of:layout.length,ore:mine.ore,level:mine.level,hub:mine.hub,phase:mine.phase,survey:mine.survey??null};},
  };
}
