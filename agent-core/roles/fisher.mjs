// Finley the Angler: the settlement's fisher and wild forager.
//
// Self-contained role module. It declares the agent (identity, prompt instructions, plugin settings),
// a pure decision function (the behaviour state machine), the behaviour loops (fishing, foraging trips,
// cooking, deliveries, rod care, the wild garden), event handlers, /sid commands, a status line and the
// dashboard/API view. main.mjs registers it; plugin v1.8.0+ provides fish/forage/smelt/expedition support.
//
// Loops (see decide()):
//   rest      night: camp by the water (energy recovers), safe inside town
//   rod       no fishing rod: craft one (3 sticks + 2 string), take one from the warehouse, or ask
//   cook      8+ raw fish: smoke them into cooked cod/salmon; brew mushroom stew when possible
//   deliver   a load of food (or evening): carry it to the warehouse pantry, post an update/alert
//   trip      once a day around midday in clear weather: forage in the flower forest / riverside
//   garden    after a trip: plant berry bushes and oak saplings by the lake (local foraging later)
//   fish      default: fish from the lakeside spot north of spawn
import {dayPhase} from '../town.mjs';

// ---------- identity and settings ----------
export const AGENT={
  id:'fisher',role:'fisher',name:'Finley the Angler',every:2,camp:true,post:[276,84],
  personality:'Patient, calm and observant. Loves quiet riversides, lake docks and foraging in nearby woods. Speaks in a tranquil, measured tone.',
  goal:'Keep the town fed from the water and the wild. Your helpers already fish at the lake, forage on day trips, cook fish and deliver food to the warehouse pantry; in your own turns, talk calmly with townsfolk and players, tell them about the pantry, invite people on foraging trips, and coordinate with the farmer and merchant about what food is needed.',
};
// Plugin config this role needs (merged into plugin-config.yml at deploy time).
export const PLUGIN_SETTINGS={
  'display-names':{fisher:'Finley the Angler'},uniforms:{fisher:'#1E88E5'},
  'starter-items':{fisher:['FISHING_ROD:2','STRING:4','STICK:6','OAK_PLANKS:6','COAL:8','BREAD:6','BOWL:2']},
  'expedition-agents':['fisher'],'forager-agents':['fisher'],'expedition-radius':150,'rod-durability':64,
};
// Places. The lake lies north of spawn (x 267-288, z 70-82, water surface y 62).
export const PLACES={
  lake:{x:276.5,z:80.5},
  // Walk to the south shore (dry land), never to the middle of the lake.
  shore:{x:276.5,z:84.5},
  // Day-trip destinations beyond the town (located with /locate): foraging grounds and alternatives.
  grounds:[{name:'the flower forest',x:368.5,z:160.5},{name:'the riverside',x:336.5,z:160.5}],
};
const RAW_FISH=['COD','SALMON'];
const DELIVER=['COOKED_COD','COOKED_SALMON','SWEET_BERRIES','APPLE','MUSHROOM_STEW','RED_MUSHROOM','BROWN_MUSHROOM','PUFFERFISH','TROPICAL_FISH',
  'LILY_PAD','STRING','LEATHER','BONE','INK_SAC','NAME_TAG','SADDLE','NAUTILUS_SHELL','BOW','BOOK','TRIPWIRE_HOOK','BOWL','LEATHER_BOOTS'];
const FOOD_POINTS={BREAD:5,COOKED_COD:5,COOKED_SALMON:6,BAKED_POTATO:5,APPLE:4,SWEET_BERRIES:2,MUSHROOM_STEW:6,PUMPKIN_PIE:8,CARROT:3,COOKED_BEEF:8,COD:2,SALMON:2};
const PANTRY_LOW=120;   // food points in the warehouse below which Finley raises an alert and fishes longer

// ---------- the state machine (pure, unit-tested) ----------
/**
 * Picks Finley's current activity.
 * ctx: {phase, raining, inventory, tripDoneToday, onTrip, pantryPoints, worldTime, gardenDue, escort, hasPantry, lean}
 */
export function decide(ctx){
  const inv=ctx.inventory??{},n=k=>inv[k]??0;
  const raw=RAW_FISH.reduce((s,k)=>s+n(k),0),load=DELIVER.reduce((s,k)=>s+n(k),0);
  if(ctx.phase==='night')return ctx.onTrip?'return':'rest';
  if(ctx.onTrip)return ctx.phase==='evening'||ctx.raining?'return':'trip';
  if(ctx.escort)return 'escort';
  if(!n('FISHING_ROD'))return 'rod';
  if(raw>=8||(ctx.phase==='evening'&&raw>0))return 'cook';
  if(n('RED_MUSHROOM')&&n('BROWN_MUSHROOM')&&(n('BOWL')||n('OAK_PLANKS')>=3))return 'cook';
  // Without a warehouse there is nowhere to deliver: keep fishing (the catch stays in his basket).
  if(ctx.hasPantry!==false&&(load>=16||(ctx.phase==='evening'&&load>0)))return 'deliver';
  if(ctx.gardenDue)return 'garden';
  const midday=ctx.worldTime>=3000&&ctx.worldTime<=6000;
  // Lean times (drought, winter): the town relies on the lake, so he only forages when the pantry is well stocked.
  if(midday&&!ctx.raining&&!ctx.tripDoneToday&&ctx.pantryPoints>=(ctx.lean?PANTRY_LOW*2:PANTRY_LOW/2))return 'trip';
  return 'fish';
}
export const pantryPoints=stock=>Object.entries(FOOD_POINTS).reduce((s,[k,v])=>s+(stock?.[k]??0)*v,0);

// ---------- the running role ----------
export function createFisher(d){
  const {memory,act,say,walk,clampMove,log,ledger,conversation,getSnapshot,lm,travel,playerByName}=d;
  const town=memory.data.town??={};
  town.fishing??={};
  const me=()=>memory.data.agents[AGENT.id];
  const selfNow=()=>getSnapshot()?.agents.find(a=>a.id===AGENT.id);
  const stock=()=>town.stock?.items??{};
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const book=s=>s.angler??={mode:'fish',day:0,today:{caught:{},foraged:{},delivered:{}},totals:{caught:0,foraged:0,delivered:0,trips:0},garden:[]};
  const count=(o,k,n=1)=>{o[k]=(o[k]??0)+n;};
  const sum=o=>Object.values(o).reduce((a,b)=>a+b,0);
  const nice=k=>k.toLowerCase().replace(/_/g,' ');
  const list=o=>Object.entries(o).filter(([,v])=>v>0).map(([k,v])=>`${v} ${nice(k)}`).join(', ')||'nothing';

  async function ground(x,z){
    const r=await act(AGENT.id,{type:'survey',x:Math.floor(x),y:0,z:Math.floor(z),width:1,depth:1}).catch(()=>null);
    return {y:r?.heights?.[0],water:!!r?.liquid?.[0]};
  }
  async function goTo(self,dest){
    if(dist(self,dest)<=2)return true;
    if(!self.pathing){const g=await ground(dest.x,dest.z);await travel(AGENT.id,self,{x:dest.x,y:Number.isFinite(g.y)?g.y+1:Math.round(self.y),z:dest.z});}
    return false;
  }

  // --- fishing spot: a land column right next to open water, found once and remembered ---
  async function findSpot(self){
    if(!(await goTo(self,PLACES.shore)))return null;
    const water=await act(AGENT.id,{type:'find',x:0,y:0,z:0,target:'WATER',count:12}).catch(()=>[]);
    for(const w of water.slice(0,8)){
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2]]){
        const g=await ground(w.x+dx,w.z+dz);
        if(Number.isFinite(g.y)&&!g.water&&g.y>=w.y&&g.y<=w.y+2){
          town.fishing={stand:{x:w.x+dx+0.5,y:g.y+1,z:w.z+dz+0.5},water:{x:w.x,y:w.y,z:w.z}};
          ledger(AGENT.id,`found a good fishing spot at ${w.x+dx},${w.z+dz} by the lake`);
          return town.fishing;
        }
      }
    }
    return null;
  }

  // --- loops ---
  async function fishLoop(s,self){
    const a=book(s);
    const spot=town.fishing?.stand?town.fishing:await findSpot(self);
    if(!spot)return;
    if(!(await goTo(self,spot.stand)))return;
    if(self.held!=='FISHING_ROD')await act(AGENT.id,{type:'equip',x:0,y:0,z:0,target:'FISHING_ROD'}).catch(()=>{});
    if(Date.now()<(a.nextCast??0))return;
    const r=await act(AGENT.id,{type:'fish',x:0,y:0,z:0}).catch(e=>({error:e.message}));
    if(r?.error){log('fish_error',{message:r.error});if(/water/.test(r.error))town.fishing={};a.nextCast=Date.now()+10000;return;}
    if(r.cast||r.waiting){a.nextCast=Date.now()+Math.max(700,r.waitMs??1000);return;}
    count(a.today.caught,r.caught);a.totals.caught++;d.award?.(AGENT.id,'harvest');
    if(r.kind==='treasure'){ledger(AGENT.id,`reeled in a ${nice(r.caught)} from the lake`);await say(AGENT.id,`Well now... a ${nice(r.caught)}. The lake is generous today.`);}
    if(r.rodBroke){ledger(AGENT.id,'wore out a fishing rod');await say(AGENT.id,'My rod has given out. Time to mend my gear.');}
    a.nextCast=Date.now()+1500;
  }
  async function rodLoop(s,self){
    const inv=self.inventory??{};
    if((inv.STICK??0)>=3&&(inv.STRING??0)>=2){
      if(await act(AGENT.id,{type:'craft',x:0,y:0,z:0,target:'FISHING_ROD',count:1}).then(()=>true).catch(()=>false)){ledger(AGENT.id,'crafted a new fishing rod');return;}
    }
    // The warehouse may hold a rod (or string from earlier catches): take them from the pantry stock.
    for(const [item,n] of [['FISHING_ROD',1],['STRING',2],['STICK',3]]){
      if((stock()[item]??0)>=n&&(inv[item]??0)<n)await act(AGENT.id,{type:'wage',x:0,y:0,z:0,to:AGENT.id,target:item,count:n}).catch(()=>{});
    }
    if(!(stock().FISHING_ROD||(stock().STRING??0)>=2))await d.postQuest?.(AGENT.id,'STRING',4,'to make a new fishing rod');
  }
  async function cookLoop(s,self){
    const inv=self.inventory??{},a=book(s);
    for(const fish of RAW_FISH){
      const n=Math.min(64,inv[fish]??0);if(!n)continue;
      const r=await act(AGENT.id,{type:'smelt',x:0,y:0,z:0,target:fish,count:n}).catch(e=>({error:e.message}));
      if(r?.error){
        // No fuel: ask the warehouse for coal (or planks), then try again next time.
        if(/fuel/.test(r.error))for(const f of ['COAL','CHARCOAL','OAK_PLANKS','SPRUCE_PLANKS'])if((stock()[f]??0)>=4){await act(AGENT.id,{type:'wage',x:0,y:0,z:0,to:AGENT.id,target:f,count:8}).catch(()=>{});break;}
        log('cook_error',{fish,message:r.error});continue;
      }
      await act(AGENT.id,{type:'sound',x:0,y:0,z:0,target:'block.campfire.crackle'}).catch(()=>{});
      d.award?.(AGENT.id,'smelt',n);log('cooked',{fish,count:n});
    }
    if((inv.RED_MUSHROOM??0)&&(inv.BROWN_MUSHROOM??0)){
      if(!inv.BOWL&&(inv.OAK_PLANKS??0)>=3)await act(AGENT.id,{type:'craft',x:0,y:0,z:0,target:'BOWL',count:1}).catch(()=>{});
      const stews=Math.min(inv.RED_MUSHROOM,inv.BROWN_MUSHROOM);
      const r=await act(AGENT.id,{type:'craft',x:0,y:0,z:0,target:'MUSHROOM_STEW',count:stews}).catch(()=>null);
      if(r?.times){count(a.today.foraged,'MUSHROOM_STEW',r.times);ledger(AGENT.id,`cooked ${r.times} mushroom stew`);}
    }
  }
  async function deliverLoop(s,self){
    const a=book(s);
    if(!(await d.goToWarehouse?.(AGENT.id,self)))return;
    const inv=self.inventory??{},given={};
    for(const item of DELIVER){const n=inv[item]??0;if(n>0&&await d.deposit?.(AGENT.id,item,n))count(given,item,n);}
    if(!sum(given))return;
    for(const [k,v] of Object.entries(given)){count(a.today.delivered,k,v);a.totals.delivered+=v;}
    const pts=pantryPoints(stock());
    ledger(AGENT.id,`delivered ${list(given)} to the pantry (pantry: ${pts} food points)`);
    await act(AGENT.id,{type:'sound',x:0,y:0,z:0,target:'block.chest.open'}).catch(()=>{});
    if(pts<PANTRY_LOW&&d.ready?.('pantry-alert',600000)){ledger(AGENT.id,`pantry alert: only ${pts} food points left in the warehouse`);await say(AGENT.id,`The pantry is running low. I'll stay at the water a little longer today.`);}
    else if(sum(given)>=8)await say(AGENT.id,`Brought ${list(given)} to the pantry. Eat well, friends.`);
  }
  async function tripLoop(s,self){
    const a=book(s),trip=a.trip;
    const ground0=PLACES.grounds[trip.ground]??PLACES.grounds[0];
    if(!trip.arrived){
      if(dist(self,ground0)>14){if(!self.pathing)await walk(AGENT.id,clampMove({type:'pathfind',x:ground0.x,y:Math.round(self.y),z:ground0.z},self)).catch(async()=>{
        // Blocked on the way: step up a little and try again next tick.
        const g=await ground(self.x+(ground0.x>self.x?4:-4),self.z+(ground0.z>self.z?4:-4));
        if(Number.isFinite(g.y))await walk(AGENT.id,{type:'pathfind',x:self.x+(ground0.x>self.x?4:-4),y:g.y+1,z:self.z+(ground0.z>self.z?4:-4)}).catch(()=>{});
      });return;}
      trip.arrived=Date.now();ledger(AGENT.id,`reached ${ground0.name} to forage`);
    }
    // Look for something to forage nearby; if nothing, wander a little further in the woods.
    if(!trip.targets?.length){
      trip.targets=[];
      for(const kind of ['SWEET_BERRY_BUSH','RED_MUSHROOM','BROWN_MUSHROOM','OAK_LEAVES','DARK_OAK_LEAVES']){
        const found=await act(AGENT.id,{type:'find',x:0,y:0,z:0,target:kind,count:16}).catch(()=>[]);
        trip.targets.push(...found.slice(0,kind.endsWith('LEAVES')?4:6).map(p=>({...p,kind})));
      }
      if(!trip.targets.length){
        trip.searches=(trip.searches??0)+1;
        if(trip.searches>4){a.trip.done=true;return;}
        const g0=PLACES.grounds[trip.ground];
        await walk(AGENT.id,clampMove({type:'pathfind',x:g0.x+(Math.random()*40-20),y:Math.round(self.y),z:g0.z+(Math.random()*40-20)},self)).catch(()=>{});
        return;
      }
    }
    const t=trip.targets[0];
    if(Math.hypot(self.x-t.x,self.z-t.z)>4){
      if(!self.pathing)await walk(AGENT.id,clampMove({type:'pathfind',x:t.x+1.5,y:t.y,z:t.z+0.5},self)).catch(()=>{trip.targets.shift();});
      return;
    }
    const r=await act(AGENT.id,{type:'forage',x:t.x,y:t.y,z:t.z}).catch(()=>null);
    trip.targets.shift();
    for(const [k,v] of Object.entries(r?.foraged??{})){count(a.today.foraged,k,v);a.totals.foraged+=v;}
    if(sum(a.today.foraged)>=40)a.trip.done=true;
  }
  async function returnLoop(s,self){
    const a=book(s);
    if(await goTo(self,PLACES.shore)){
      a.trip=null;a.totals.trips++;a.gardenDue=true;
      ledger(AGENT.id,`came back from foraging with ${list(a.today.foraged)}`);
      await say(AGENT.id,`Back from the woods. The forest was kind: ${list(a.today.foraged)}.`);
    }
  }
  async function gardenLoop(s,self){
    // Replant a little of what was gathered by the lake, so food grows closer to town over time.
    const a=book(s),inv=self.inventory??{};
    const plants=[['SWEET_BERRIES','SWEET_BERRY_BUSH',Math.min(3,(inv.SWEET_BERRIES??0)-2)],['OAK_SAPLING','OAK_SAPLING',Math.min(2,inv.OAK_SAPLING??0)]];
    let planted=0;
    for(const [item,block,n] of plants)for(let i=0;i<n;i++){
      const spot={x:Math.floor(PLACES.lake.x+(Math.random()*18-9)),z:Math.floor(PLACES.lake.z+10+Math.random()*4)};
      const g=await ground(spot.x,spot.z);if(!Number.isFinite(g.y)||g.water)continue;
      if(Math.hypot(self.x-spot.x,self.z-spot.z)>8){await walk(AGENT.id,clampMove({type:'pathfind',x:spot.x+1.5,y:g.y+1,z:spot.z+0.5},self)).catch(()=>{});continue;}
      if(await act(AGENT.id,{type:'place',x:spot.x,y:g.y+1,z:spot.z,target:block}).then(()=>true).catch(()=>false)){planted++;a.garden.push({x:spot.x,y:g.y+1,z:spot.z,block,day:town.day});}
    }
    a.garden=a.garden.slice(-40);a.gardenDue=false;
    if(planted)ledger(AGENT.id,`planted ${planted} wild plants by the lake`);
  }
  async function restLoop(s,self){
    const spot=town.fishing?.stand??{x:AGENT.post[0]+0.5,z:AGENT.post[1]+0.5};
    await goTo(self,spot);
  }
  async function escortLoop(s,self){
    // A player asked Finley to forage with them: stay close and forage whatever is near them.
    const a=book(s),p=playerByName(a.escort.player);
    if(!p||Date.now()>a.escort.until){await say(AGENT.id,`Thank you for the walk${p?`, ${a.escort.player}`:''}. I'll head back to the water.`);a.escort=null;return;}
    if(dist(self,p)>4){if(!self.pathing)await walk(AGENT.id,clampMove({type:'pathfind',x:p.x+1.5,y:Math.round(p.y),z:p.z+1.5},self)).catch(()=>{});return;}
    if(!d.ready?.('escort-forage',8000))return;
    for(const kind of ['SWEET_BERRY_BUSH','RED_MUSHROOM','BROWN_MUSHROOM','OAK_LEAVES']){
      const near=(await act(AGENT.id,{type:'find',x:0,y:0,z:0,target:kind,count:6}).catch(()=>[]))[0];
      if(near&&Math.hypot(self.x-near.x,self.z-near.z)<=5){const r=await act(AGENT.id,{type:'forage',x:near.x,y:near.y,z:near.z}).catch(()=>null);
        for(const [k,v] of Object.entries(r?.foraged??{}))count(a.today.foraged,k,v);return;}
    }
  }

  function newDay(s){
    const a=book(s);
    if(a.day===town.day)return;
    if(a.day&&(sum(a.today.caught)||sum(a.today.foraged))){
      ledger(AGENT.id,`day ${a.day} report: caught ${list(a.today.caught)}; foraged ${list(a.today.foraged)}; delivered ${sum(a.today.delivered)} items`);
    }
    a.day=town.day;a.today={caught:{},foraged:{},delivered:{}};a.tripDay=null;
  }

  return {
    AGENT,
    /** Finley's job for this worker tick, or null to let the shared town routines run. */
    job(c,s,self,night){
      if(c.id!==AGENT.id)return null;
      newDay(s);
      const a=book(s),snap=getSnapshot();
      if(a.trip?.done&&!a.trip.returning)a.trip.returning=true;
      const mode=decide({phase:night?'night':dayPhase(snap?.worldTime),raining:!!snap?.weather?.storm,inventory:self.inventory,
        tripDoneToday:a.tripDay===town.day,onTrip:!!a.trip,pantryPoints:pantryPoints(stock()),worldTime:(snap?.worldTime??0)%24000,
        gardenDue:a.gardenDue,escort:!!a.escort,hasPantry:!!town.built?.warehouse,lean:!!town.climate?.lean});
      const effective=mode==='trip'&&a.trip?.returning?'return':mode;
      if(effective==='trip'&&!a.trip){a.trip={ground:Math.floor(Math.random()*PLACES.grounds.length),start:Date.now()};a.tripDay=town.day;
        ledger(AGENT.id,`set out to forage in ${PLACES.grounds[a.trip.ground].name}`);say(AGENT.id,`I'm off to ${PLACES.grounds[a.trip.ground].name} to forage. Back before dusk.`);}
      if(a.mode!==effective){a.mode=effective;a.since=Date.now();log('fisher_mode',{mode:effective});}
      const loops={fish:fishLoop,rod:rodLoop,cook:cookLoop,deliver:deliverLoop,trip:tripLoop,return:returnLoop,garden:gardenLoop,rest:restLoop,escort:escortLoop};
      const loop=loops[effective];
      return loop?()=>loop(s,self):null;
    },
    status(s){const a=book(s);return {fish:'fishing at the lake',rod:'mending fishing gear',cook:'smoking fish',deliver:'bringing food to the pantry',trip:'foraging in the woods',
      return:'walking back from the woods',garden:'planting a wild garden',rest:'resting by the water',escort:'foraging with a friend'}[a.mode]??'by the water';},
    context(c,s){
      // Food numbers only for those whose work they are (or when food is short): otherwise everyone talks about the pantry.
      if(c.id!==AGENT.id){const p=this.pantry();return p.status==='healthy'&&!['farmer','courier','governor','crafter','merchant'].includes(c.role??c.id)?{}:{pantry:p};}
      const a=book(s);
      return {pantry:this.pantry(),angler:{mode:a.mode,today:a.today,totals:a.totals,fishingSpot:town.fishing?.stand,grounds:PLACES.grounds.map(g=>g.name)},
        roleGuide:'You are Finley. Fishing, foraging, cooking and deliveries happen on their own; in your turns speak calmly and briefly, share pantry numbers when asked, invite people to forage with you (players can use /sid forage), and ask the farmer or merchant what food the town needs.'};
    },
    pantry(){
      const st=stock(),items=Object.fromEntries(Object.keys(FOOD_POINTS).filter(k=>st[k]).map(k=>[k,st[k]]));
      const pts=pantryPoints(st);
      return {items,foodPoints:pts,status:pts<PANTRY_LOW/2?'critical':pts<PANTRY_LOW?'low':'healthy'};
    },
    /** /sid food and /sid forage. Returns true when handled. */
    async command(data,args){
      const verb=String(args[0]??'').toLowerCase();
      if(verb==='food'){
        const p=this.pantry(),a=book(me()??{});
        const lines=[`Pantry: ${p.status} (${p.foodPoints} food points). ${list(p.items)}.`,
          `Today I caught ${list(a.today?.caught??{})} and foraged ${list(a.today?.foraged??{})}.`];
        for(const text of lines)await act(AGENT.id,{type:'whisper',x:0,y:0,z:0,to:data.player,text}).catch(()=>{});
        return true;
      }
      if(verb==='forage'){
        const a=book(me());
        if(isNightNow()){await act(AGENT.id,{type:'whisper',x:0,y:0,z:0,to:data.player,text:'The woods are no place for us at night. Ask me again in the morning.'}).catch(()=>{});return true;}
        a.escort={player:data.player,until:Date.now()+10*60000};
        await say(AGENT.id,`Gladly, ${data.player}. Lead the way and I'll gather what we find.`);
        ledger(AGENT.id,`went foraging with ${data.player}`);
        return true;
      }
      return false;
    },
    commands:['food','forage'],
    view(){
      const s=me();if(!s)return null;const a=book(s);
      return {name:AGENT.name,mode:a.mode,status:this.status(s),today:a.today,totals:a.totals,pantry:this.pantry(),fishingSpot:town.fishing?.stand??null,garden:a.garden.length,trip:a.trip?{to:PLACES.grounds[a.trip.ground]?.name,arrived:!!a.trip.arrived}:null};
    },
  };
  function isNightNow(){return dayPhase(getSnapshot()?.worldTime)==='night';}
}
