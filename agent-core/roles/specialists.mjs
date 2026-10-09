// Three specialist citizens: Barnaby the Runner (courier), Vulcan the Smith (tools) and Rosa the Herbalist (potions).
//
// Like roles/fisher.mjs this module declares the agents and returns a job for each worker tick. The courier's
// daytime rounds live in civic.mjs (it shares the warehouse logistics); here it only camps by the warehouse at night.
//   smith      keeps every worker equipped: replaces missing or worn-out pickaxes, swords, hoes and axes (hands them
//              over, or leaves them in the warehouse for miners underground), smelts Dorn's iron, keeps spare tools
//   herbalist  gathers flowers, mushrooms, berries and cane; brews healing, swiftness, night-vision and splash
//              remedies; treats the hurt, and doses Sir Aldric with swiftness and night vision at dusk
import {dayPhase} from '../town.mjs';
import {toolNeeds,smithStep,bestTool,brewNext,patientsOf,needsHerbs,herbCount} from '../plans.mjs';

export const AGENTS=[
  {id:'courier',role:'courier',name:'Barnaby the Runner',every:3,camp:true,post:[277,113],
    personality:'Quick, cheerful and tireless. Knows everyone by name, loves a good route and always has a ration of bread in the satchel.',
    goal:'Keep goods moving. Your rounds already run on their own: you patrol the farm, the fishing dock and the mine, carry their harvest to the warehouse, feed hungry workers on the spot and deliver quest goods. In your own turns, chat briefly and warmly, pass on news between citizens, and tell players what the warehouse needs.'},
  {id:'smith',role:'smith',name:'Vulcan the Smith',every:3,camp:true,post:[243,90],
    personality:'Broad-shouldered, proud of honest work, gruff but generous. Speaks of metal, fire and good tools.',
    goal:'Keep every worker equipped. Your forge work runs on its own: you replace missing or worn tools, smelt iron from Dorn the Miner and keep spare pickaxes and swords. In your own turns, talk shop with the miner and guardian, ask for iron and coal when short, and offer to fix players\' gear.'},
  {id:'herbalist',role:'herbalist',name:'Rosa the Herbalist',every:3,camp:true,post:[252,94],
    personality:'Gentle, curious and wise about plants. Speaks softly, notices when someone looks tired or hurt.',
    goal:'Keep the town healthy. Your herb work runs on its own: you gather flowers, mushrooms and berries, brew healing, swiftness and night-vision remedies, tend the injured and prepare Sir Aldric for his night watch. In your own turns, share remedies and plant lore, and tell players they can ask for healing with /sid heal.'},
];
export const PLUGIN_SETTINGS={
  'display-names':{courier:'Barnaby the Runner',smith:'Vulcan the Smith',herbalist:'Rosa the Herbalist'},
  uniforms:{courier:'#FF7043',smith:'#37474F',herbalist:'#7CB342'},
  'starter-items':{courier:['BREAD:12','APPLE:4'],smith:['IRON_INGOT:6','STICK:8','COAL:16','IRON_PICKAXE:1','BREAD:6'],
    herbalist:['SWEET_BERRIES:8','POPPY:4','DANDELION:4','SUGAR_CANE:4','CARROT:4','BREAD:6']},
  'expedition-agents':['herbalist'],'forager-agents':['herbalist'],
};
// Where the herbalist looks for ingredients (block names for the plugin's find action), in order.
const HERB_BLOCKS=['POPPY','DANDELION','CORNFLOWER','OXEYE_DAISY','AZURE_BLUET','ALLIUM','RED_TULIP','ORANGE_TULIP','WHITE_TULIP','PINK_TULIP',
  'LILY_OF_THE_VALLEY','BLUE_ORCHID','RED_MUSHROOM','BROWN_MUSHROOM','SWEET_BERRY_BUSH','SUGAR_CANE'];
const HERB_GROUND={name:'the flower forest',x:368.5,z:160.5};

export function createSpecialists(d){
  const {memory,act,say,walk,clampMove,log,ledger,getSnapshot,travel,playerByName,configs}=d;
  const town=memory.data.town??={};
  const ids=new Set(AGENTS.map(a=>a.id));
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const nice=k=>String(k).toLowerCase().replace(/_/g,' ');
  const first=id=>configs.find(c=>c.id===id)?.name?.split(' ')[0]??id;
  const roleView=snap=>snap.agents.map(a=>({...a,role:configs.find(c=>c.id===a.id)?.role??a.id}));
  const phaseNow=()=>dayPhase(getSnapshot()?.worldTime);

  async function ground(id,x,z){
    const r=await act(id,{type:'survey',x:Math.floor(x),y:0,z:Math.floor(z),width:1,depth:1}).catch(()=>null);
    return r?.heights?.[0];
  }
  async function goTo(id,self,dest,near=2.5){
    if(dist(self,dest)<=near)return true;
    if(!self.pathing){const y=Number.isFinite(dest.y)?dest.y:await ground(id,dest.x,dest.z);await travel(id,self,{x:dest.x,y:Number.isFinite(y)?(Number.isFinite(dest.y)?y:y+1):Math.round(self.y),z:dest.z}).catch(()=>{});}
    return false;
  }
  // Rosa's post is the infirmary once it stands (her place by the beds); otherwise the configured spot.
  const postOf=c=>{const r=c.role==='herbalist'?d.infirmaryLayout?.():null;return r?{x:r.medic.x,y:r.medic.y,z:r.medic.z}:{x:c.post[0]+0.5,z:c.post[1]+0.5};};   // the floor height: the highest block there is the roof
  async function restLoop(c,s,self){await goTo(c.id,self,postOf(c));}

  // ---------------- smith ----------------
  const smithBook=s=>s.smith??={made:0,delivered:0,orders:0,job:null,history:[]};
  async function smithLoop(c,s,self){
    const snap=getSnapshot();if(!snap)return;
    const b=smithBook(s),inv=self.inventory??{};
    const needs=toolNeeds(roleView(snap)).filter(n=>n.agent!==c.id||n.kind==='PICKAXE');
    // Keep working on the current job while it is still needed.
    if(b.job&&!needs.some(n=>n.agent===b.job.agent&&n.kind===b.job.kind))b.job=null;
    b.job??=needs.find(n=>!town.toolOrders?.[n.agent])??null;
    if(b.job)return serveTool(c,s,self,b.job);
    return forgeWork(c,s,self);
  }
  async function serveTool(c,s,self,job){
    const b=smithBook(s),inv=self.inventory??{};
    const step=smithStep(inv,job.kind);
    if(step.step==='give'){
      const t=getSnapshot()?.agents.find(a=>a.id===job.agent);if(!t){b.job=null;return;}
      // Underground or far away: leave it in the warehouse and let them know.
      if(t.y<58||dist(self,t)>60){
        if(!await d.goToWarehouse(c.id,self))return;
        if(await d.deposit(c.id,step.item,1,c.id)){d.placeToolOrder(job.agent,step.item);b.orders++;
          ledger(c.id,`left a new ${nice(step.item)} for ${job.agent} in the warehouse`);
          await say(c.id,`@${job.agent}: your new ${nice(step.item)} is waiting in the warehouse, ${first(job.agent)}.`);}
        b.job=null;return;
      }
      if(!await goTo(c.id,self,{x:t.x+1,z:t.z+1},3))return;
      if(await act(c.id,{type:'give',x:0,y:0,z:0,target:step.item,count:1,to:job.agent}).then(()=>true).catch(()=>false)){
        await act(job.agent,{type:'equip',x:0,y:0,z:0,target:step.item}).catch(()=>{});
        b.delivered++;b.history=[{time:Date.now(),to:job.agent,tool:step.item,reason:job.reason},...b.history].slice(0,12);
        await act(c.id,{type:'sound',x:0,y:0,z:0,target:'block.anvil.use'}).catch(()=>{});
        ledger(c.id,`gave ${job.agent} a new ${nice(step.item)} (${job.reason==='worn'?'the old one was worn out':'they had none'})`);
        await say(c.id,job.reason==='worn'?`${first(job.agent)}, your old ${nice(job.kind)} is nearly done for. Take this one - fresh from the anvil.`:`${first(job.agent)}, you can't work without a ${nice(job.kind)}. Here, take this.`);
        d.award?.(c.id,'craft');
      }
      b.job=null;return;
    }
    if(step.step==='craft'||step.step==='smelt'){
      if(!await goTo(c.id,self,postOf(c),6))return;
      const r=await act(c.id,step.step==='craft'?{type:'craft',x:0,y:0,z:0,target:step.item,count:step.count}:{type:'smelt',x:0,y:0,z:0,target:step.item,count:step.count}).catch(e=>({error:e.message}));
      if(r?.error){if(/fuel/i.test(r.error))await fetch(c,s,self,{COAL:8});else{log('smith_error',{step,message:r.error});b.job=null;}return;}
      await act(c.id,{type:'sound',x:0,y:0,z:0,target:step.step==='craft'?'block.anvil.use':'block.grindstone.use'}).catch(()=>{});
      if(step.step==='craft'&&/_(PICKAXE|AXE|SWORD|HOE|SHOVEL)$/.test(step.item)){b.made++;log('smith_made',{item:step.item});}
      return;
    }
    // Short of materials: Dorn first (if he is up top), then the warehouse, then a quest.
    return gatherMetal(c,s,self,step.item,step.count);
  }
  async function fetch(c,s,self,want){
    if(!await d.goToWarehouse(c.id,self))return 0;
    let got=0;for(const [item,n] of Object.entries(want))got+=await d.withdraw(c.id,item,n);
    return got;
  }
  async function gatherMetal(c,s,self,item,count){
    const b=smithBook(s),miner=configs.find(x=>x.role==='miner');
    const m=miner&&getSnapshot()?.agents.find(a=>a.id===miner.id);
    const spare=m&&(m.inventory?.RAW_IRON??0)+(m.inventory?.IRON_INGOT??0)>=3&&m.y>=58;
    if(spare&&(item==='IRON_INGOT'||item==='RAW_IRON')){
      if(!await goTo(c.id,self,{x:m.x+1,z:m.z+1},3))return;
      for(const k of ['RAW_IRON','IRON_INGOT','COAL']){const n=Math.min(k==='COAL'?16:32,m.inventory?.[k]??0);if(n)await act(miner.id,{type:'give',x:0,y:0,z:0,target:k,count:n,to:c.id}).catch(()=>{});}
      ledger(c.id,`collected iron from ${miner.id} for the forge`);return;
    }
    const alts=item==='STICK'?{STICK:4,OAK_PLANKS:4}:item==='IRON_INGOT'?{IRON_INGOT:count,RAW_IRON:count}:{[item]:count};
    const stock=town.stock?.items??{};
    if(Object.keys(alts).some(k=>(stock[k]??0)>0)){
      const got=await fetch(c,s,self,Object.fromEntries(Object.entries(alts).filter(([k])=>(stock[k]??0)>0).slice(0,1)));
      if(got||!town.built?.warehouse)return;
    }
    // Stone tools need only cobblestone: take some so there is always a fallback.
    if(item==='IRON_INGOT'&&(stock.COBBLESTONE??0)>=3&&(self.inventory?.COBBLESTONE??0)<3){await fetch(c,s,self,{COBBLESTONE:8});return;}
    if(d.ready?.(`smith-quest:${item}`,1200000)){
      await d.postQuest?.(c.id,item==='STICK'?'OAK_PLANKS':'IRON_INGOT',item==='STICK'?16:8,'for the forge');
      if(miner)await say(c.id,`@${miner.id}: the forge is out of iron. Bring me what you dig up, Dorn.`);
    }
    b.job=null;s.smithIdleUntil=Date.now()+60000;
  }
  async function forgeWork(c,s,self){
    const inv=self.inventory??{};
    // Smelt raw iron as it arrives, keep a spare pickaxe and sword ready, otherwise tend the forge.
    if((inv.RAW_IRON??0)>=1){
      if(await goTo(c.id,self,postOf(c),6)){
        const r=await act(c.id,{type:'smelt',x:0,y:0,z:0,target:'RAW_IRON',count:Math.min(32,inv.RAW_IRON)}).catch(e=>({error:e.message}));
        if(r?.error&&/fuel/i.test(r.error))await fetch(c,s,self,{COAL:8});
        else if(!r?.error){await act(c.id,{type:'sound',x:0,y:0,z:0,target:'block.grindstone.use'}).catch(()=>{});ledger(c.id,`smelted ${r.count} iron ingots`);}
      }
      return;
    }
    for(const kind of ['PICKAXE','SWORD']){
      if(bestTool(inv,kind))continue;
      const step=smithStep(inv,kind);
      if(step.step==='craft'||step.step==='smelt'){if(await goTo(c.id,self,postOf(c),6))await act(c.id,step.step==='craft'?{type:'craft',x:0,y:0,z:0,target:step.item,count:step.count}:{type:'smelt',x:0,y:0,z:0,target:step.item,count:step.count}).catch(()=>{});return;}
    }
    if(Date.now()<(s.smithIdleUntil??0))return goTo(c.id,self,postOf(c));
    // Surplus tools beyond one spare each go to the Supplies & Tools chest.
    const extra=Object.entries(inv).filter(([k,n])=>/_(PICKAXE|AXE|SWORD|HOE|SHOVEL)$/.test(k)&&n>1);
    if(extra.length&&town.built?.warehouse){if(await d.goToWarehouse(c.id,self))for(const [k,n] of extra)await d.deposit(c.id,k,n-1,c.id);return;}
    s.smithIdleUntil=Date.now()+45000;
    await goTo(c.id,self,postOf(c));
  }
  async function smithNight(c,s,self){
    await restLoop(c,s,self);
    // Indoor work at the forge after dark: smelt ore and forge spares.
    if(!d.ready?.(`smith-night:${c.id}`,60000))return;
    const inv=self.inventory??{};
    if((inv.RAW_IRON??0)>0)await act(c.id,{type:'smelt',x:0,y:0,z:0,target:'RAW_IRON',count:Math.min(32,inv.RAW_IRON)}).then(r=>log('night_chore',{agent:c.id,chore:`smelted ${r.count} iron`})).catch(()=>{});
    else for(const kind of ['PICKAXE','SWORD','HOE','AXE']){if((inv[`IRON_${kind}`]??0)<1&&(inv.IRON_INGOT??0)>=3&&(inv.STICK??0)>=2){await act(c.id,{type:'craft',x:0,y:0,z:0,target:`IRON_${kind}`,count:1}).then(()=>log('night_chore',{agent:c.id,chore:`forged an iron ${kind.toLowerCase()}`})).catch(()=>{});break;}}
  }

  // ---------------- herbalist ----------------
  const herbBook=s=>s.herbs??={brewed:0,treated:0,gathered:0,trip:null,tripDay:0,guardDay:0,call:null,history:[]};
  async function herbalistLoop(c,s,self){
    const snap=getSnapshot();if(!snap)return;
    const b=herbBook(s),pots=self.potions??{};
    // 1. A player asked for healing (/sid heal).
    if(b.call){
      const p=playerByName(b.call.player);
      if(!p||Date.now()>b.call.until){b.call=null;}
      else{
        if(!await goTo(c.id,self,{x:p.x+1,z:p.z+1},3))return;
        const kind=(pots.HEALING??0)>0?'HEALING':(pots.SPLASH_HEALING??0)>0?'SPLASH_HEALING':null;
        if(kind&&await act(c.id,{type:'dose',x:0,y:0,z:0,target:kind,to:b.call.player}).then(()=>true).catch(()=>false)){
          b.treated++;ledger(c.id,`healed ${b.call.player} with a ${nice(kind)} remedy`);await say(c.id,`There now, ${b.call.player}. Drink this - you'll feel better soon.`);}
        else await say(c.id,`I'm sorry, ${b.call.player}, I have no healing remedy ready. Let me gather herbs and brew one.`);
        b.call=null;return;
      }
    }
    // 2. The hurt: splash when several stand together, otherwise one dose each.
    const patients=patientsOf(roleView(snap).filter(a=>a.id!==c.id));
    if(patients.length&&((pots.HEALING??0)+(pots.SPLASH_HEALING??0))>0){
      const p=patients[0],group=patients.filter(o=>dist(o,p)<=4).length;
      if(!await goTo(c.id,self,{x:p.x+1,z:p.z+1},3))return;
      const kind=group>=2&&(pots.SPLASH_HEALING??0)>0?'SPLASH_HEALING':(pots.HEALING??0)>0?'HEALING':'SPLASH_HEALING';
      const r=await act(c.id,{type:'dose',x:0,y:0,z:0,target:kind,to:p.id}).catch(()=>null);
      if(r){b.treated+=r.treated;b.history=[{time:Date.now(),to:p.id,potion:kind},...b.history].slice(0,12);
        ledger(c.id,`treated ${p.id}${r.treated>1?` and ${r.treated-1} others`:''} with a ${nice(kind)} remedy`);
        if(d.ready?.(`heal-say:${p.id}`,120000))await say(c.id,`Hold still, ${first(p.id)}. This will close those wounds.`);}
      return;
    }
    // 3. Dusk: prepare the night watch - Sir Aldric and Sheriff Wade (preventative care before their patrols).
    const phase=phaseNow();b.watchDays??={};
    const due=configs.filter(x=>['guardian','sheriff'].includes(x.role)&&(b.watchDays[x.id]??(x.role==='guardian'?b.guardDay:null))!==town.day);
    if(due.length&&phase==='evening'&&((pots.SWIFTNESS??0)>0||(pots.NIGHT_VISION??0)>0||(pots.HEALING??0)>1)){
      const guard=due[0],g=snap.agents.find(a=>a.id===guard.id);
      if(g&&dist(self,g)<80){
        if(!await goTo(c.id,self,{x:g.x+1,z:g.z+1},3))return;
        const given=[];
        for(const kind of ['SWIFTNESS','NIGHT_VISION'])if((pots[kind]??0)>0&&await act(c.id,{type:'dose',x:0,y:0,z:0,target:kind,to:guard.id}).then(()=>true).catch(()=>false))given.push(nice(kind));
        // A wounded watchman also gets a healing draught before going out (she keeps one back for emergencies).
        if((g.health??20)<=16&&(pots.HEALING??0)>1&&await act(c.id,{type:'dose',x:0,y:0,z:0,target:'HEALING',to:guard.id}).then(()=>true).catch(()=>false))given.push(nice('HEALING'));
        b.watchDays[guard.id]=town.day;if(guard.role==='guardian')b.guardDay=town.day;
        if(given.length){ledger(c.id,`prepared ${guard.id} for the night ${guard.role==='sheriff'?'patrol':'watch'} (${given.join(', ')})`);await say(c.id,`For your ${guard.role==='sheriff'?'patrol':'watch'}, ${first(guard.id)}: ${given.join(' and ')}. Keep safe out there.`);}
        return;
      }
    }
    // 4. Brew what is running low.
    const kind=brewNext(self.inventory,pots);
    if(kind){
      // Brewing in her herb shed once it stands (the remedies are kept there); otherwise at her post.
      if(!await goTo(c.id,self,d.herbShed?.()??postOf(c),3))return;
      const r=await act(c.id,{type:'brew',x:0,y:0,z:0,target:kind,count:2}).catch(e=>({error:e.message}));
      if(!r?.error){b.brewed+=r.count;log('brewed',{agent:c.id,potion:kind,count:r.count});if(d.ready?.('brew-ledger',600000))ledger(c.id,`brewed ${r.count} ${nice(kind)} remedies`);d.award?.(c.id,'craft',r.count);}
      return;
    }
    // 5. Gather ingredients: nearby first, the pantry for fruit and carrots, then a day trip to the flower forest.
    if(needsHerbs(self.inventory)||b.trip)return gatherHerbs(c,s,self);
    return goTo(c.id,self,postOf(c));
  }
  async function gatherHerbs(c,s,self){
    const b=herbBook(s),inv=self.inventory??{};
    if(b.trip){
      const phase=phaseNow();
      if(phase==='evening'||phase==='night'||Date.now()-b.trip.start>8*60000||herbCount(inv)>=16){
        if(await goTo(c.id,self,postOf(c),4)){ledger(c.id,`came back from ${HERB_GROUND.name} with herbs`);b.trip=null;}
        return;
      }
      if(!b.trip.arrived){if(dist(self,HERB_GROUND)>14){if(!self.pathing)await walk(c.id,clampMove({type:'pathfind',x:HERB_GROUND.x,y:Math.round(self.y),z:HERB_GROUND.z},self)).catch(()=>{});return;}b.trip.arrived=true;}
    }
    // Fruit and carrots can come from the pantry when the town has plenty.
    const stock=town.stock?.items??{};
    const fruit=(inv.SWEET_BERRIES??0)+(inv.APPLE??0)+(inv.GLOW_BERRIES??0)+(inv.MELON_SLICE??0);
    if(!b.trip&&fruit<6&&town.built?.warehouse&&((stock.APPLE??0)>=16||(stock.SWEET_BERRIES??0)>=16)&&d.ready?.('herb-pantry',300000)){
      if(await d.goToWarehouse(c.id,self)){await d.withdraw(c.id,(stock.APPLE??0)>=16?'APPLE':'SWEET_BERRIES',8);if((stock.CARROT??0)>=12&&(inv.CARROT??0)<2)await d.withdraw(c.id,'CARROT',4);}
      return;
    }
    b.targets=(b.targets??[]).filter(t=>Date.now()-t.found<120000);
    if(!b.targets.length){
      for(const kind of HERB_BLOCKS){
        const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:kind,count:24}).catch(()=>[]);
        b.targets.push(...found.slice(0,4).map(p=>({...p,kind,found:Date.now()})));
        if(b.targets.length>=8)break;
      }
      if(!b.targets.length){
        // Nothing in sight: first try where anyone last saw herbs (spatial memory), then search further afield.
        const mem=d.intel?.()?.spatial.query(c.id,'flowers berries cane mushrooms',3,110,{from:self,category:'plant'}).find(m=>!(b.visited??[]).includes(m.memory_id));
        if(mem&&!b.trip){
          if(Math.hypot(self.x-mem.x,self.z-mem.z)>5){if(!self.pathing)await travel(c.id,self,{x:mem.x+0.5,y:mem.y,z:mem.z+0.5}).catch(()=>{});return;}
          b.visited=[...(b.visited??[]),mem.memory_id].slice(-20);
          const here=await act(c.id,{type:'find',x:0,y:0,z:0,target:mem.item,count:8}).catch(()=>[]);
          if(!here?.length)d.intel().spatial.markStale(mem.memory_id);
          else b.targets.push(...here.slice(0,4).map(p=>({...p,kind:mem.item,found:Date.now()})));
          return;
        }
        b.searches=(b.searches??0)+1;
        // Nothing within reach: walk a little, and once a day go to the flower forest in good weather.
        const wt=(getSnapshot()?.worldTime??0)%24000;
        if(b.searches>=3&&!b.trip&&b.tripDay!==town.day&&wt>=2000&&wt<=7000&&!getSnapshot()?.weather?.storm&&!town.alert){
          b.trip={start:Date.now()};b.tripDay=town.day;b.searches=0;ledger(c.id,`set out to gather herbs in ${HERB_GROUND.name}`);
          await say(c.id,`The meadows near town are picked clean. I'm off to ${HERB_GROUND.name} for herbs.`);return;
        }
        const post=postOf(c);await walk(c.id,clampMove({type:'pathfind',x:post.x+(Math.random()*40-20),y:Math.round(self.y),z:post.z+(Math.random()*40-20)},self)).catch(()=>{});
        return;
      }
    }
    const t=b.targets[0];
    if(Math.hypot(self.x-t.x,self.z-t.z)>4){if(!self.pathing)await walk(c.id,clampMove({type:'pathfind',x:t.x+1.5,y:t.y,z:t.z+0.5},self)).catch(()=>{b.targets.shift();});return;}
    const r=await act(c.id,{type:'forage',x:t.x,y:t.y,z:t.z}).catch(()=>null);
    b.targets.shift();
    const n=Object.values(r?.foraged??{}).reduce((a,v)=>a+v,0);if(n){b.gathered+=n;b.searches=0;}
  }
  async function herbalistNight(c,s,self){
    await restLoop(c,s,self);
    if(!d.ready?.(`herb-night:${c.id}`,60000))return;
    const kind=brewNext(self.inventory,self.potions??{});
    if(kind)await act(c.id,{type:'brew',x:0,y:0,z:0,target:kind,count:2}).then(r=>{herbBook(s).brewed+=r.count;log('night_chore',{agent:c.id,chore:`brewed ${r.count} ${nice(kind)}`});}).catch(()=>{});
  }

  const status=(c,s)=>{
    if(c.role==='smith'){const b=smithBook(s);return b.job?`making a ${nice(b.job.kind)} for ${b.job.agent}`:'at the forge';}
    if(c.role==='herbalist'){const b=herbBook(s);return b.trip?'gathering herbs in the flower forest':b.call?`going to heal ${b.call.player}`:'tending herbs and remedies';}
    if(c.role==='courier'){const e=s.errand;return !e?'on the rounds':e.kind==='patrol'?`on the way to ${e.to}`:e.kind==='store'?'carrying goods to the warehouse':e.kind.startsWith('quest')?`running quest #${e.quest}`:e.kind==='feed'?`bringing food to ${e.to}`:'fetching rations';}
    return null;
  };

  return {
    AGENTS,
    has:id=>ids.has(id),
    /** The specialist's job for this tick, or null (the courier's daytime rounds come from civic). */
    job(c,s,self,night){
      if(!ids.has(c.id))return null;
      if(night)return c.role==='smith'?()=>smithNight(c,s,self):c.role==='herbalist'?()=>herbalistNight(c,s,self):()=>restLoop(c,s,self);
      if(c.role==='smith')return ()=>smithLoop(c,s,self);
      if(c.role==='herbalist')return ()=>herbalistLoop(c,s,self);
      return null;
    },
    status(c,s){return ids.has(c.id)?status(c,s):null;},
    context(c,s){
      if(c.role==='smith'){const snap=getSnapshot();return {forge:{job:smithBook(s).job,needs:snap?toolNeeds(roleView(snap)).slice(0,5):[],made:smithBook(s).made,delivered:smithBook(s).delivered},
        roleGuide:'You are Vulcan the Smith. Tool repairs and replacements happen on their own; in your turns talk shop briefly, ask Dorn for iron and coal when short, and offer players to look at their gear.'};}
      if(c.role==='herbalist'){const self=getSnapshot()?.agents.find(a=>a.id===c.id);return {herbs:{potions:self?.potions??{},herbs:herbCount(self?.inventory),brewed:herbBook(s).brewed,treated:herbBook(s).treated},
        roleGuide:'You are Rosa the Herbalist. Gathering, brewing and healing happen on their own; in your turns share plant lore softly, ask how people feel, and tell players they can ask for healing with /sid heal.'};}
      if(c.role==='courier')return {rounds:{errand:s.errand??null,lastStop:s.lastStop},roleGuide:'You are Barnaby the Runner. Your deliveries run on their own; in your turns share news from your rounds, cheerfully and briefly.'};
      return {};
    },
    commands:['heal','tools','potions'],
    /** /sid heal, /sid tools, /sid potions. */
    async command(data,args){
      const verb=String(args[0]??'').toLowerCase(),snap=getSnapshot();
      const herb=configs.find(c=>c.role==='herbalist'),smith=configs.find(c=>c.role==='smith');
      const tell=(id,text)=>act(id,{type:'whisper',x:0,y:0,z:0,to:data.player,text}).catch(()=>{});
      if(verb==='heal'&&herb){
        const s=memory.data.agents[herb.id];herbBook(s).call={player:data.player,until:Date.now()+5*60000};
        await say(herb.id,`I'm coming, ${data.player}. Stay where you are.`);return true;
      }
      if(verb==='potions'&&herb){const a=snap?.agents.find(x=>x.id===herb.id);const p=Object.entries(a?.potions??{}).map(([k,v])=>`${v} ${nice(k)}`).join(', ')||'none';
        await tell(herb.id,`Remedies ready: ${p}. Herbs in my basket: ${herbCount(a?.inventory)}.`);return true;}
      if(verb==='tools'&&smith){
        const needs=snap?toolNeeds(roleView(snap)):[];
        await tell(smith.id,needs.length?`On my list: ${needs.map(n=>`${n.agent} needs a ${nice(n.kind)} (${n.reason}${n.left!==undefined?`, ${n.left} uses left`:''})`).join('; ')}.`:'Everyone is well equipped right now.');
        return true;
      }
      return false;
    },
    view(){
      const snap=getSnapshot(),out={};
      const smith=configs.find(c=>c.role==='smith'),herb=configs.find(c=>c.role==='herbalist'),runner=configs.find(c=>c.role==='courier');
      if(smith){const s=memory.data.agents[smith.id]??{},b=smithBook(s);out.smith={name:smith.name,status:status(smith,s),made:b.made,delivered:b.delivered,orders:b.orders,history:b.history.slice(0,6),needs:snap?toolNeeds(roleView(snap)):[],
        wear:snap?Object.fromEntries(snap.agents.filter(a=>Object.keys(a.wear??{}).length).map(a=>[a.id,a.wear])):{}};}
      if(herb){const s=memory.data.agents[herb.id]??{},b=herbBook(s),a=snap?.agents.find(x=>x.id===herb.id);out.herbalist={name:herb.name,status:status(herb,s),potions:a?.potions??{},herbs:herbCount(a?.inventory),brewed:b.brewed,treated:b.treated,gathered:b.gathered,history:b.history.slice(0,6)};}
      if(runner){const s=memory.data.agents[runner.id]??{};out.courier={name:runner.name,status:status(runner,s),errand:s.errand??null,lastStop:s.lastStop??null};}
      return out;
    },
  };
}
