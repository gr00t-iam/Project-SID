// Gideon "Timber" Vance, the Lumberjack: the town's timber supply, run as a state machine (rules in ../lumber.mjs).
//
//   CHECK_TOOLS          an axe in hand? (best carried: iron > stone > wood)
//   GATHER_CRAFTING_MATS no axe and nothing to make one from: fell a tree by hand for logs
//   CRAFT_AXE            take sticks/planks/stone/iron from the warehouse, craft the best axe possible, equip it
//   SCOUT_TREES          nearest real tree (logs with leaves above - never a building's posts, never the park trees
//                        around the square); then trees the town remembers; then explore outward in rings
//   HARVEST_TREE         walk beside it, apologise, fell the whole trunk (an axe that breaks mid-tree: finish by hand)
//   CLEAR_FOLIAGE        no sapling dropped: clear the canopy - leaves drop saplings, sticks and apples
//   REPLANT_SEED         mandatory before moving on: a sapling where the tree stood (dark oak: a 2x2 of four)
//   HAUL_TO_WAREHOUSE    at 64 logs or 4 trees: deposit timber, apples and spare saplings (keeps 8 for planting)
//
// Stumps other citizens leave (the crafter fells trees too) are noticed from the block events and replanted as
// well - an unplanted stump makes Gideon anxious. His forestry ledger (trees_harvested, seeds_replanted,
// total_logs_delivered) lives in his memory and he is proud of his net-green score.
import {STATES,TUNING,isLog,isSapling,woodOf,saplingFor,pickSapling,bestAxe,isAxe,axePlan,nextState,newLedger,netGreen,greenRatio,line,treeName} from '../lumber.mjs';

export const AGENT={id:'lumberjack',role:'lumberjack',name:'Gideon "Timber" Vance',every:3,camp:true,post:[252,108],
  personality:'Big-hearted, theatrical lumberjack who talks to trees like old friends - apologises to an ancient oak before felling it and hums sea shanties while hauling timber. Obsessed with forest ecology: an unplanted stump makes him visibly anxious, and he keeps a proud tally of trees planted versus felled.',
  goal:'Keep the town in timber without ever shrinking the forest. Your felling, replanting and hauling run on their own; in your own turns, tell people about the trees you met today, boast about your net-green ledger, ask anyone who fells a tree to replant it, and offer the builder and the crafter wood.'};
export const PLUGIN_SETTINGS={'display-names':{lumberjack:'Gideon Vance'},uniforms:{lumberjack:'#8B3A2B'},'starter-items':{lumberjack:['BREAD:6','OAK_SAPLING:4']}};

const SQUARE={x:283.5,z:93.5},PARK=35;   // trees within this many blocks of the square are the town's park: never felled
const SIDES=[[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2],[2,2],[-2,-2]];
const LEAVES=log=>{const w=woodOf(log);return w?`${w}_LEAVES`:'OAK_LEAVES';};
const PAIRED=new Set(['DARK_OAK_SAPLING','PALE_OAK_SAPLING']);
// Felling, canopy clearing and planting all work from where he stands, up to 8.5 blocks away (the plugin allows 10).
const REACH=8.5,within=(p,self,dy=0)=>Math.hypot(p.x+0.5-self.x,(p.y??self.y)+dy+0.5-self.y,p.z+0.5-self.z)<=REACH;   // these grow only as a 2x2 of four

export function createLumberjack(d){
  const {memory,configs,act,say,log,ledger,getSnapshot,travel,civic=()=>null,intel=()=>null,now=()=>Date.now(),random=Math.random}=d;
  const town=memory.data.town??={};
  const shared=town.forest??={stumps:[],unreachable:{}};   // stumps anyone left; trees nobody can reach (key -> until)
  const said=new Map();
  const ready=(key,ms)=>{const t=said.get(key)??0;if(now()-t<ms)return false;said.set(key,now());return true;};
  const quip=(id,kind,vars,ms=90000)=>ready(`${id}:${kind}`,ms)?say(id,line(kind,vars,random)):undefined;
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const key=(x,z)=>`${Math.floor(x)},${Math.floor(z)}`;
  const stateOf=id=>memory.data.agents[id];
  const lumberOf=s=>{const L=s.lumber??={state:STATES.IDLE,stumps:[],felled:0,ledger:newLedger()};L.stumps??=[];L.ledger??=newLedger();return L;};
  const moving=self=>self.pathing||['moving','loading'].includes(self.navigation?.status);
  const changed=(id,L,to)=>{if(L.state!==to){log('lumber_state',{agent:id,from:L.state,to});L.state=to;}};
  const unreachable=k=>(shared.unreachable[k]??0)>now();

  /** Stumps to work on: his own, then others' nearby; ones he has a sapling for, or can still try the canopy of. */
  function workStumps(L,self){
    const inv=self.inventory??{};
    const mine=L.stumps,others=shared.stumps.filter(t=>dist(t,self)<48&&!mine.some(m=>m.x===t.x&&m.z===t.z));
    return [...mine,...others].filter(t=>pickSapling(t.log,inv)||(t.foliage??0)<TUNING.foliageTries&&t.canopy!==false).sort((a,b)=>dist(a,self)-dist(b,self));
  }

  // ---------- states ----------
  async function craftAxe(c,L,self){
    const stock=civic()?.stockItems()??{},plan=axePlan(self.inventory??{},stock);
    if(plan.missing)return;
    if(Object.keys(plan.withdraw).length){
      if(!await civic().goToWarehouse(c.id,self))return;
      for(const [item,n] of Object.entries(plan.withdraw))await civic().withdraw(c.id,item,n);
      return;   // craft once the goods show up in his pockets
    }
    for(const step of plan.crafts){
      const r=await act(c.id,{type:'craft',x:0,y:0,z:0,target:step.item,count:step.times}).catch(error=>({error:error.message}));
      if(r?.error){log('lumber_craft_failed',{agent:c.id,item:step.item,error:r.error});return;}
    }
    await act(c.id,{type:'equip',x:0,y:0,z:0,target:plan.axe}).catch(()=>{});
    log('lumber_axe',{agent:c.id,axe:plan.axe});ledger(c.id,`crafted a ${plan.axe.toLowerCase().replace(/_/g,' ')}`);
    quip(c.id,'axe',{axe:plan.axe.toLowerCase().replace(/_/g,' ')},30000);
  }

  /** Finds the nearest real tree; falls back to remembered trees, then to exploring. Sets L.tree. */
  async function scout(c,L,self){
    town.notTrees??={};
    const kinds=[...new Set([L.lastKind,'OAK_LOG','BIRCH_LOG','SPRUCE_LOG','ACACIA_LOG','DARK_OAK_LOG','JUNGLE_LOG','CHERRY_LOG','MANGROVE_LOG'].filter(Boolean))];
    let best=null;
    for(const kind of kinds.slice(0,4)){
      const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:kind,count:24}).catch(()=>[]);
      const trunks=new Map();
      for(const l of found??[]){const k=key(l.x,l.z);if(town.notTrees[k]||unreachable(k)||dist(l,SQUARE)<PARK)continue;const t=trunks.get(k);if(!t||l.y<t.base)trunks.set(k,{x:l.x,z:l.z,base:l.y,log:kind,top:Math.max(t?.top??l.y,l.y)});else t.top=Math.max(t.top,l.y);}
      for(const t of [...trunks.values()].sort((a,b)=>dist(a,self)-dist(b,self)).slice(0,3)){
        // A real tree has leaves around the top of its trunk; logs in a wall do not.
        const crown=await act(c.id,{type:'scan',x:t.x-2,y:t.top-1,z:t.z-2,width:5,height:5,depth:5}).catch(()=>null);
        if(!crown?.cells?.some(cell=>/_LEAVES$/.test(cell[3]))){town.notTrees[key(t.x,t.z)]=now();continue;}
        if(!best||dist(t,self)<dist(best,self))best=t;break;
      }
      if(best&&dist(best,self)<12)break;
    }
    if(best){L.tree={...best,walks:0,side:0,apologised:false};L.lastKind=best.log;L.atPost=false;L.explored=0;log('lumber_tree',{agent:c.id,log:best.log,x:best.x,z:best.z});return;}
    // Nothing in sight: a tree the town remembers, else explore rings around his post.
    const mem=intel()?.spatial.query(c.id,'wood',1,null,{from:self,category:'tree'}).find(m=>!unreachable(key(m.x,m.z))&&dist(m,SQUARE)>=PARK);
    if(mem){
      if(dist(mem,self)>10){await travel(c.id,self,{x:mem.x+1.5,y:mem.y,z:mem.z+0.5}).catch(()=>{});return;}
      intel().spatial.markStale(mem.memory_id);return;
    }
    // Back to his post at the forest edge first (from the warehouse no tree is in sight), then rings around it.
    const post=configs.find(x=>x.id===c.id)?.post??[SQUARE.x,SQUARE.z];
    if(Math.hypot(self.x-post[0],self.z-post[1])>16&&!L.atPost){L.atPost=true;await travel(c.id,self,{x:post[0]+0.5,y:Math.round(self.y),z:post[1]+0.5}).catch(()=>{});return;}
    L.explored=(L.explored??0)+1;
    const ring=1+Math.floor(L.explored/8),angle=(L.explored%8)*Math.PI/4;
    await travel(c.id,self,{x:post[0]+Math.cos(angle)*20*ring,y:Math.round(self.y),z:post[1]+Math.sin(angle)*20*ring}).catch(()=>{});
  }

  async function harvest(c,L,self,manual){
    const t=L.tree;
    const inReachOf=l=>Math.hypot(l.x+0.5-self.x,l.y+0.5-self.y,l.z+0.5-self.z)<=8.5;
    const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:t.log,count:16}).catch(()=>[]);
    const trunk=(found??[]).filter(l=>Math.abs(l.x-t.x)<=1&&Math.abs(l.z-t.z)<=1&&!town.notTrees?.[key(l.x,l.z)]);
    if(!trunk.length){
      // Scouting saw this tree but his nearby search does not (other logs closer): give up on it for a while instead
      // of scouting it again and again (243 times in three hours on one spruce).
      if(!t.cut){shared.unreachable[key(t.x,t.z)]=now()+TUNING.unreachableMs;log('tree_lost',{agent:c.id,x:t.x,z:t.z});L.tree=null;return;}
      // The last log is down: one more tree felled, one stump to replant before he moves on.
      if(t.cut){
        L.ledger.trees_harvested++;L.felled++;L.stumps.unshift({x:t.x,y:t.base,z:t.z,log:t.log,at:now(),foliage:0,top:t.top});
        log('tree_felled',{agent:c.id,log:t.log,x:t.x,z:t.z,logs:t.cut,manual:!!L.manual});
        memory.add?.(c.id,{time:now(),forestry:`felled a ${treeName(t.log)} at ${t.x},${t.z} (${t.cut} logs)`});
      }
      L.tree=null;L.manual=false;return;
    }
    if(!trunk.some(inReachOf)){
      // Walk beside the trunk (another side when a spot is blocked). A tree he cannot reach is skipped for a while.
      if(now()-(t.walkAt??0)<5000)return;
      t.walkAt=now();t.walks++;
      if(t.walks>TUNING.walkTries){shared.unreachable[key(t.x,t.z)]=now()+TUNING.unreachableMs;log('tree_unreachable',{agent:c.id,x:t.x,z:t.z,for:'10 min'});L.tree=null;return;}
      const [sx,sz]=SIDES[t.side%SIDES.length];
      const r=await travel(c.id,self,{x:t.x+sx+0.5,y:t.base,z:t.z+sz+0.5}).catch(error=>({error:error.message}));
      if(r?.error)t.side++;
      return;
    }
    if(!t.apologised){t.apologised=true;quip(c.id,random()<0.75?'apology':'shanty',{tree:treeName(t.log)},45000);}
    // Axe in hand unless it broke mid-tree (then by hand: slower in spirit, same logs).
    const axe=bestAxe(self.held,self.inventory);
    if(axe&&self.held!==axe)await act(c.id,{type:'equip',x:0,y:0,z:0,target:axe}).catch(()=>{});
    let cut=0;
    for(const l of trunk.filter(inReachOf).sort((a,b)=>a.y-b.y).slice(0,12))
      if(await act(c.id,{type:'mine',x:l.x,y:l.y,z:l.z}).then(()=>true).catch(()=>false))cut++;
    t.cut=(t.cut??0)+cut;
    if(manual&&!L.manual){L.manual=true;}
  }

  async function clearFoliage(c,L,self,stump){
    // No sapling dropped: clear the canopy above the stump - leaves give saplings, sticks and apples.
    if(!within(stump,self,3)){await travel(c.id,self,{x:stump.x+1.5,y:stump.y,z:stump.z+0.5}).catch(()=>{});return;}
    if(!stump.foliage)quip(c.id,'noSapling',{},120000);
    const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:LEAVES(stump.log),count:8}).catch(()=>[]);
    const near=(found??[]).filter(l=>Math.abs(l.x-stump.x)<=4&&Math.abs(l.z-stump.z)<=4&&Math.hypot(l.x+0.5-self.x,l.y+0.5-self.y,l.z+0.5-self.z)<=8.5).slice(0,16);
    let cleared=0;for(const l of near)if(await act(c.id,{type:'mine',x:l.x,y:l.y,z:l.z}).then(()=>true).catch(()=>false))cleared++;
    stump.foliage=(stump.foliage??0)+1;if(!near.length)stump.canopy=false;
    log('foliage_cleared',{agent:c.id,x:stump.x,z:stump.z,leaves:cleared,pass:stump.foliage});
    if(stump.foliage>=TUNING.foliageTries&&!pickSapling(stump.log,self.inventory??{})){L.ledger.owed=(L.ledger.owed??0)+1;log('stump_owed',{agent:c.id,x:stump.x,z:stump.z});}
  }

  async function replant(c,L,self,stump){
    const inv=self.inventory??{},sapling=pickSapling(stump.log,inv);if(!sapling)return;
    if(!within(stump,self)){
      if(now()-(stump.walkAt??0)<5000)return;stump.walkAt=now();stump.walks=(stump.walks??0)+1;
      if(stump.walks>TUNING.walkTries){dropStump(L,stump);log('stump_unreachable',{agent:c.id,x:stump.x,z:stump.z});return;}
      await travel(c.id,self,{x:stump.x+1.5,y:stump.y,z:stump.z+0.5}).catch(()=>{});return;
    }
    // Dark and pale oak grow only as a 2x2 of four saplings; everything else from one.
    const cells=PAIRED.has(sapling)&&(inv[sapling]??0)>=4?[[0,0],[1,0],[0,1],[1,1]]:[[0,0],[1,0],[-1,0],[0,1],[0,-1]];
    let planted=0;
    for(const [dx,dz] of cells){
      const r=await act(c.id,{type:'place',x:stump.x+dx,y:stump.y,z:stump.z+dz,target:sapling}).then(()=>'ok').catch(error=>error.message);
      if(r==='ok'){planted++;if(!PAIRED.has(sapling)||cells.length<4)break;}
    }
    if(!planted){dropStump(L,stump);log('replant_failed',{agent:c.id,x:stump.x,z:stump.z,sapling});return;}
    L.ledger.seeds_replanted+=planted;if(stump.from&&stump.from!==c.id)L.ledger.others_replanted=(L.ledger.others_replanted??0)+planted;
    dropStump(L,stump);
    log('sapling_planted',{agent:c.id,sapling,x:stump.x,z:stump.z,count:planted,for:stump.from??c.id});
    memory.add?.(c.id,{time:now(),forestry:`planted ${planted} ${sapling.toLowerCase().replace(/_/g,' ')} at ${stump.x},${stump.z}`});
    quip(c.id,'replant',{sapling:sapling.toLowerCase().replace(/_/g,' ')},60000);
  }
  const dropStump=(L,stump)=>{L.stumps=L.stumps.filter(t=>t!==stump&&!(t.x===stump.x&&t.z===stump.z));shared.stumps=shared.stumps.filter(t=>!(t.x===stump.x&&t.z===stump.z));};

  async function haul(c,L,self,stumps){
    if(!await civic().goToWarehouse(c.id,self))return;
    const inv=self.inventory??{};let logs=0,saplings=0;
    for(const [item,n] of Object.entries(inv)){
      if(n<=0)continue;
      if(isLog(item)){const k=await civic().deposit(c.id,item,n);logs+=k;}
      else if(isSapling(item)){
        const keep=Math.max(TUNING.keepSaplings-Object.entries(inv).filter(([k])=>isSapling(k)&&k!==item).reduce((s,[,v])=>s+v,0),item===saplingFor(L.lastKind)?TUNING.keepSaplings:0);
        if(n>keep){const k=await civic().deposit(c.id,item,n-keep);saplings+=k;}
      }
      else if(['APPLE','STICK'].includes(item)&&n>(item==='STICK'?4:0))await civic().deposit(c.id,item,item==='STICK'?n-4:n);
    }
    // Stumps waiting on a sapling: take some from the store.
    if(stumps.length&&!Object.keys(inv).some(isSapling)){
      const stock=civic().stockItems(),want=saplingFor(stumps[0].log);
      const pick=(stock[want]??0)>0?want:Object.keys(stock).find(k=>isSapling(k)&&stock[k]>0);
      if(pick)await civic().withdraw(c.id,pick,Math.min(TUNING.keepSaplings,stock[pick]));
    }
    if(logs){
      L.ledger.total_logs_delivered+=logs;L.ledger.saplings_delivered=(L.ledger.saplings_delivered??0)+saplings;L.felled=0;
      log('timber_delivered',{agent:c.id,logs,saplings,total:L.ledger.total_logs_delivered});
      ledger(c.id,`delivered ${logs} logs to the warehouse (forestry: ${L.ledger.trees_harvested} felled, ${L.ledger.seeds_replanted} planted, net green ${netGreen(L.ledger)})`);
      quip(c.id,random()<0.5?'haul':'boast',{logs,planted:L.ledger.seeds_replanted,felled:L.ledger.trees_harvested,net:(netGreen(L.ledger)>=0?'+':'')+netGreen(L.ledger)},120000);
    }else L.felled=0;
  }

  // ---------- the loop ----------
  async function step(c,s,self){
    const L=lumberOf(s);
    if(moving(self))return;
    const inv=self.inventory??{},stock=civic()?.stockItems()??{},stumps=workStumps(L,self);
    // An axe that broke mid-tree: finish the trunk by hand, then make a new one.
    if(L.lastAxe&&!bestAxe(self.held,inv)&&L.tree){L.manual=true;quip(c.id,'broke',{axe:L.lastAxe.toLowerCase().replace(/_/g,' ')},300000);log('axe_broke',{agent:c.id,axe:L.lastAxe});}
    L.lastAxe=bestAxe(self.held,inv);
    const pending=[...L.stumps,...shared.stumps].filter(t=>dist(t,self)<24).length;
    if(pending>=2)quip(c.id,'stumps',{n:pending},300000);
    const st=nextState({held:self.held,inventory:inv,stock,stumps,tree:L.tree,felled:L.felled,foliageTries:stumps[0]?.foliage??0,manual:L.manual,haulLogs:civic()?.woodWanted?.()?16:undefined});
    changed(c.id,L,st);
    switch(st){
      case STATES.REPLANT_SEED:return replant(c,L,self,stumps[0]);
      case STATES.CLEAR_FOLIAGE:return clearFoliage(c,L,self,stumps[0]);
      case STATES.HAUL_TO_WAREHOUSE:return haul(c,L,self,stumps);
      case STATES.CRAFT_AXE:return craftAxe(c,L,self);
      case STATES.GATHER_CRAFTING_MATS:return L.tree?harvest(c,L,self,true):scout(c,L,self);
      case STATES.HARVEST_TREE:return harvest(c,L,self,!bestAxe(self.held,inv));
      case STATES.SCOUT_TREES:return scout(c,L,self);
    }
  }

  return {
    /** Daytime work for the lumberjack (role job: after urgent needs, before routine chores). */
    job(c,s,self,night){
      if((c.role??c.id)!=='lumberjack'||night||s.resting)return null;
      return ()=>step(c,s,self);
    },
    /** Stumps other citizens leave behind (from block events): he replants those too. */
    onBlock(data){
      if(data?.kind!=='agent_mine'||!isLog(data.block?.type)||data.agent==='lumberjack')return;
      const b=data.block,k=key(b.x,b.z),old=shared.stumps.find(t=>key(t.x,t.z)===k);
      if(old){old.y=Math.min(old.y,b.y);return;}
      if(Math.hypot(b.x-SQUARE.x,b.z-SQUARE.z)>200)return;
      shared.stumps.push({x:b.x,y:b.y,z:b.z,log:b.type,at:now(),from:data.agent,foliage:0});
      shared.stumps=shared.stumps.slice(-40);
    },
    context(c,s){
      if((c.role??c.id)!=='lumberjack')return {};
      const L=lumberOf(s),l=L.ledger;
      return {forestry:{state:L.state,trees_harvested:l.trees_harvested,seeds_replanted:l.seeds_replanted,total_logs_delivered:l.total_logs_delivered,
        net_green:netGreen(l),green_ratio:Math.round(greenRatio(l)*100)/100,stumps_waiting:L.stumps.length+shared.stumps.length,owed:l.owed??0},
        roleGuide:'You are Gideon "Timber" Vance. Felling, replanting and hauling happen on their own. In your turns, speak to trees fondly, hum a shanty now and then, boast about your net-green ledger (forestry) and fret about unplanted stumps.'};
    },
    agentView(id){const s=stateOf(id);if(!s?.lumber)return {};const L=s.lumber;return {forestry:{state:L.state,...L.ledger,net_green:netGreen(L.ledger),stumps:L.stumps.length,tree:L.tree?{x:L.tree.x,z:L.tree.z,log:L.tree.log}:null}};},
    view(){return {stumps:shared.stumps.length,unreachable:Object.values(shared.unreachable).filter(t=>t>now()).length};},
    status(c,s){const L=s.lumber;if(!L)return null;return ({HARVEST_TREE:`felling ${/^[aeiou]/.test(treeName(L.tree?.log))?'an':'a'} ${treeName(L.tree?.log)}`,REPLANT_SEED:'planting a sapling',CLEAR_FOLIAGE:'clearing a canopy for saplings',
      HAUL_TO_WAREHOUSE:'hauling timber',CRAFT_AXE:'making an axe',GATHER_CRAFTING_MATS:'gathering wood by hand',SCOUT_TREES:'looking for a good tree'})[L.state]??null;},
  };
}
