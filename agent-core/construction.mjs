// Construction that finishes: explicit blockers instead of silent skips, adaptive access to every block, per-section
// scaffolding, and a final inspection against the blueprint. Pure rules first (exported for tests), then the
// controller that main.mjs runs for a builder with a project.
//
//   a block that cannot be placed now   -> deferred with a reason and a back-off (never dropped); retried later
//   materials missing                   -> MATERIALS blocker (civic reserves them, assigns supplier and courier)
//   nothing on a layer reachable        -> standing spots around the work (failed spots remembered), then a scaffold
//                                          column per roof section (several columns tried per section, no global cap)
//   queue empty                         -> deferred blocks retried; when none are left, the site is scanned and
//                                          compared with the blueprint; missing or wrong blocks go back in the queue
//   done                                -> only when the inspection finds every blueprint block in place
//   long blocked                        -> the project is parked with its blocker (the builder takes other work and
//                                          comes back at the next check); nothing is ever reported finished early
//
// Every blocked state carries a sentence for people, e.g.
//   "Roof paused: missing 24 stone stairs. Courier assigned. Miner needs a new excavation site. Next check in 30 seconds."
import {scanPages} from './sites.mjs';

const label=k=>String(k).toLowerCase().replace(/_/g,' ');
const key=(x,y,z)=>`${x},${y},${z}`;
const centre=b=>({x:b.x+0.5,y:b.y+0.5,z:b.z+0.5});
const dist3=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);

// ---------- blocks that fail: defer, never drop ----------
/** What kind of trouble a placement error is. */
export function failureKind(error=''){
  const e=String(error);
  if(/^Out of /i.test(e))return 'materials';
  if(/out of reach|outside allowed range|unreachable|too high/i.test(e))return 'access';
  if(/occupied|No room/i.test(e))return 'obstructed';
  if(/not allowed/i.test(e))return 'material-not-allowed';
  if(/standing there|rate|Disconnected|timeout|offline/i.test(e))return 'transient';
  return 'placement';
}
/** Moves a block out of the queue into project.deferred with a reason and an exponential back-off (30 s .. 10 min). */
export function deferBlock(project,block,reason,{now=Date.now()}={}){
  const i=project.queue.indexOf(block);if(i>=0)project.queue.splice(i,1);
  const n=(block.deferrals??0)+1;
  (project.deferred??=[]).push({...block,deferrals:n,reason:String(reason).slice(0,120),kind:failureKind(reason),nextAt:now+Math.min(600000,30000*2**(n-1))});
}
/** Deferred blocks whose back-off is over go back into the queue. Returns how many. */
export function requeueDue(project,{now=Date.now()}={}){
  const due=(project.deferred??[]).filter(b=>b.nextAt<=now);
  if(!due.length)return 0;
  project.deferred=project.deferred.filter(b=>b.nextAt>now);
  for(const {nextAt,reason,kind,...b} of due)project.queue.push({...b,tries:0,lastReason:reason});
  return due.length;
}

// ---------- phases and blocker sentences ----------
/** Foundation / walls / roof, from where a block sits in the building. */
export function phaseOf(project,y){
  const ys=(project.expected??project.queue).filter(b=>!b.clear).map(b=>b.y);
  if(!ys.length)return 'Site work';
  const lo=Math.min(...ys),hi=Math.max(...ys);
  if(y<=lo)return 'Foundation';
  if(hi-lo>=3&&y>=hi-Math.max(1,Math.round((hi-lo)/4)))return 'Roof';
  return 'Walls';
}
/**
 * The blocker sentence: what stopped, what is missing or wrong, who is doing what about it, when it is checked next.
 * b: {kind, phase, missing:{item:n}, assigned:{supplier, courier, miner}, detail, nextCheck}
 */
export function describeBlocker(b,{now=Date.now(),nameOf=x=>x}={}){
  const phase=b.phase??'Work',secs=Math.max(0,Math.round(((b.nextCheck??now)-now)/1000));
  const parts=[];
  if(b.kind==='materials'){
    const miss=Object.entries(b.missing??{}).filter(([,n])=>n>0).sort((x,y)=>y[1]-x[1]);
    if(!miss.length&&b.assigned?.courier){parts.push(`${phase} paused: the courier is bringing the reserved materials.`);parts.push(`Next check in ${secs<90?`${secs} seconds`:`${Math.round(secs/60)} minutes`}.`);return parts.join(" ");}
    parts.push(`${phase} paused: missing ${miss.length?miss.slice(0,3).map(([k,n])=>`${n} ${label(k)}`).join(', ')+(miss.length>3?` and ${miss.length-3} more`:''):'materials'}.`);
    const a=b.assigned??{};
    if(a.supplier)parts.push(`${nameOf(a.supplier)} is making them.`);
    if(a.courier)parts.push('Courier assigned.');
    if(a.miner)parts.push(!a.minerSite?'Miner needs a new excavation site.':/^opening/.test(a.minerSite)?`${nameOf(a.miner)} is ${a.minerSite}.`:`${nameOf(a.miner)} is digging at ${a.minerSite}.`);
    if(!a.supplier&&!a.courier&&!a.miner)parts.push('Nobody can supply them yet; asking the town.');
  }else if(b.kind==='access')parts.push(`${phase} paused: ${b.detail??'cannot reach the next blocks'}.`);
  else if(b.kind==='obstructed')parts.push(`${phase} paused: ${b.detail??'something is in the way'}.`);
  else if(b.kind==='path')parts.push(`${phase} paused: ${b.detail??'no way through to the site'}.`);
  else if(b.kind==='verify')parts.push(`Final inspection: ${b.detail??'checking the building against the plan'}.`);
  else parts.push(`${phase} paused: ${b.detail??b.kind}.`);
  parts.push(`Next check in ${secs<90?`${secs} seconds`:`${Math.round(secs/60)} minutes`}.`);
  return parts.join(' ');
}
/** The blocker for blocks that are all deferred: the most common reason, with counts. */
export function deferredBlocker(project,{now=Date.now()}={}){
  const by={};for(const b of project.deferred??[])(by[b.kind]??=[]).push(b);
  const [kind,list]=Object.entries(by).sort((x,y)=>y[1].length-x[1].length)[0]??['placement',[]];
  const nextCheck=Math.min(...(project.deferred??[]).map(b=>b.nextAt),now+30000);
  const first=list[0];
  const detail=kind==='access'?`${list.length} block${list.length>1?'s':''} out of reach (${first?`${first.x},${first.y},${first.z}`:''}); trying other standing spots and scaffolding`
    :kind==='obstructed'?`${list.length} spot${list.length>1?'s are':' is'} occupied by something not in the plan (e.g. ${first?`${first.x},${first.y},${first.z}`:''})`
    :kind==='material-not-allowed'?`${list.length} block${list.length>1?'s use':' uses'} a material the server does not allow (${label(first?.block??'')})`
    :`${list.length} block${list.length>1?'s':''} failed to place (${first?.reason??'unknown'})`;
  return {kind:kind==='material-not-allowed'?'obstructed':kind,phase:phaseOf(project,first?.y??0),detail,nextCheck,count:list.length};
}

// ---------- standing spots and scaffolding ----------
/** Where blueprint blocks are (solid now or later): nobody stands or scaffolds there. */
export function solidSet(project){
  const s=new Set();for(const b of project.expected??project.queue)if(!b.clear&&b.block!=='AIR')s.add(key(b.x,b.y,b.z));return s;
}
/**
 * Standing spots from which `target` is in reach: around it on the ground (base) and the floor (base+1), never inside
 * a blueprint block, nearest first, minus spots that already failed. Returns up to `limit`.
 */
export function standingSpots(target,project,{reach,base,self=null,bad=[],limit=12}){
  const solid=solidSet(project),badSet=new Set(bad),out=[],r=Math.max(2,Math.floor(reach)-1);
  for(let dx=-r;dx<=r;dx++)for(let dz=-r;dz<=r;dz++){
    if(Math.hypot(dx,dz)<1.5)continue;
    for(const y of [base,base+1]){
      const x=target.x+dx,z=target.z+dz;
      if(solid.has(key(x,y,z))||solid.has(key(x,y+1,z)))continue;
      if(dist3({x:x+0.5,y:y+1,z:z+0.5},centre(target))>reach)continue;   // eye level as worker.mjs measures it
      const k=key(x,y,z);if(badSet.has(k))continue;
      const fromSelf=self?Math.hypot(x+0.5-self.x,z+0.5-self.z):0;
      out.push({x:x+0.5,y,z:z+0.5,key:k,score:Math.hypot(dx,dz)+fromSelf*0.15});
    }
  }
  // On the building itself: the exposed top of a blueprint block below the target (a wall top, a lower roof ring) -
  // the way a real builder stands on the roof to set its ridge. Ranked behind ground spots; reached by climbing.
  // Only blocks already in place hold him up: a queued (or deferred) roof is not there yet (the builder kept
  // picking spots on the library's unbuilt roof to reach an old tree canopy).
  const exp=project.expected??project.queue,pending=new Set([...project.queue,...(project.deferred??[])].map(b=>key(b.x,b.y,b.z)));
  for(const b of exp){
    if(b.clear||b.block==='AIR'||pending.has(key(b.x,b.y,b.z))||b.y>=target.y||b.y<target.y-4||Math.hypot(b.x-target.x,b.z-target.z)>r)continue;
    if(solid.has(key(b.x,b.y+1,b.z))||solid.has(key(b.x,b.y+2,b.z)))continue;
    if(b.x===target.x&&b.z===target.z)continue;
    if(dist3({x:b.x+0.5,y:b.y+2,z:b.z+0.5},centre(target))>reach)continue;
    const k=key(b.x,b.y+1,b.z);if(badSet.has(k))continue;
    out.push({x:b.x+0.5,y:b.y+1,z:b.z+0.5,key:k,onBuilding:true,score:4+Math.hypot(b.x-target.x,b.z-target.z)});
  }
  return out.sort((a,b)=>a.score-b.score).slice(0,limit);
}
/** The roof (or any high layer) in sections of up to 6 x 6, so each gets its own access plan. */
export function sectionOf(project,b){
  const xs=(project.expected??project.queue).map(q=>q.x),zs=(project.expected??project.queue).map(q=>q.z);
  const x0=Math.min(...xs),z0=Math.min(...zs);
  return `${Math.floor((b.x-x0)/6)}:${Math.floor((b.z-z0)/6)}`;
}
/**
 * A scaffold column for a section: inside the walls first (standing on the floor), then outside them (standing on the
 * ground); no blueprint block anywhere in the column; a free cell beside it to stand on at its foot; nearest the
 * section's blocks first; never a column already tried. floor: the y a citizen stands at inside; ground: outside.
 */
export function scaffoldColumn(project,target,{floor,ground=floor-1,tried=[]}){
  const solid=solidSet(project),triedSet=new Set(tried);
  const walls=(project.expected??project.queue).filter(q=>!q.clear&&q.y===floor);   // the wall ring at standing height
  const wx=walls.map(q=>q.x),wz=walls.map(q=>q.z);
  const all=(project.expected??project.queue),xs=all.map(q=>q.x),zs=all.map(q=>q.z);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
  const inMinX=wx.length?Math.min(...wx):minX,inMaxX=wx.length?Math.max(...wx):maxX,inMinZ=wz.length?Math.min(...wz):minZ,inMaxZ=wz.length?Math.max(...wz):maxZ;
  const top=target.y-3;
  const cands=[];
  for(let x=minX-2;x<=maxX+2;x++)for(let z=minZ-2;z<=maxZ+2;z++){
    const k=`${x},${z}`;if(triedSet.has(k))continue;
    const inside=x>inMinX&&x<inMaxX&&z>inMinZ&&z<inMaxZ,base=inside?floor:ground;
    if(top<base)continue;
    let free=true;for(let y=base;y<=top+2;y++)if(solid.has(key(x,y,z))){free=false;break;}
    if(!free||Math.hypot(target.x-x,target.z-z)>4)continue;
    // Somewhere to stand at its foot (to build it and to climb on and off).
    const beside=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({x:x+dx,z:z+dz})).find(p=>{
      const pin=p.x>inMinX&&p.x<inMaxX&&p.z>inMinZ&&p.z<inMaxZ;if(pin!==inside)return false;
      return !solid.has(key(p.x,base,p.z))&&!solid.has(key(p.x,base+1,p.z));});
    if(!beside)continue;
    cands.push({x,z,top,base,key:k,beside:{x:beside.x+0.5,y:base,z:beside.z+0.5},inside,score:Math.hypot(target.x-x,target.z-z)+(inside?0:2)});
  }
  return cands.sort((a,b)=>a.score-b.score)[0]??null;
}

// ---------- the final inspection ----------
const FAMILY=[/_BED$/,/_DOOR$/,/_TRAPDOOR$/,/_SIGN$/];
/** Same block for inspection purposes (beds and doors by family; everything else by exact name). */
export function sameBlock(expected,actual){
  if(expected==='AIR')return !actual||/^(AIR|CAVE_AIR)$/.test(actual);
  if(expected==='IRON_DOOR'||actual==='IRON_DOOR')return expected===actual;
  if(!actual)return false;if(expected===actual)return true;
  return FAMILY.some(f=>f.test(expected)&&f.test(actual));
}
/**
 * Compares the blueprint (expected blocks; site clearing is not inspected) with scanned cells [[x,y,z,type,...],...].
 * Returns {total, matched, missing:[blocks absent], wrong:[blocks with something else there], pct}.
 */
export function inspect(expected,cells){
  const at=new Map();for(const c of cells)at.set(key(c[0],c[1],c[2]),c[3]);
  const missing=[],wrong=[];let matched=0;
  const want=expected.filter(b=>!b.clear);
  for(const b of want){
    const got=at.get(key(b.x,b.y,b.z));
    if(sameBlock(b.block,got))matched++;
    else if(!got)missing.push(b);
    else wrong.push({...b,found:got});
  }
  const total=want.length;
  return {total,matched,missing,wrong,pct:total?Math.floor(100*matched/total):100};
}
/** The scan box around a blueprint. */
export function inspectionBox(expected){
  const b=expected.filter(q=>!q.clear),xs=b.map(q=>q.x),ys=b.map(q=>q.y),zs=b.map(q=>q.z);
  return {x1:Math.min(...xs),x2:Math.max(...xs),y1:Math.min(...ys),y2:Math.max(...ys),z1:Math.min(...zs),z2:Math.max(...zs)};
}

// ---------- the controller ----------
/**
 * d: {act, walk, placeAll, nextBuildStep, recordPlacements, civic:()=>civic, memory, log, ledger, say, reach, travel,
 *     nameOf, traits(id), onBlocked(c,project), now}
 * step(c,s,self) runs one tick of the builder's project; resumeParked(c,s) brings back a parked project when due.
 */
export function createConstruction(d){
  const {act,walk,placeAll,nextBuildStep,recordPlacements,memory,log=()=>{},ledger=()=>{},say=async()=>{},now=()=>Date.now()}=d;
  const civic=()=>d.civic();
  const town=()=>memory.data.town??={};
  const nameOf=d.nameOf??(x=>x);
  const traits=id=>d.traits?.(id)??{patience:0.5,craftsmanship:0.5,risk_tolerance:0.5};

  function migrate(p){
    // Projects started before this module: the blueprint to inspect against is what is still queued (what was placed
    // earlier cannot be told from here) plus nothing; new projects carry their full blueprint from the start.
    if(!p.expected){p.expected=p.queue.filter(b=>!b.clear).map(({tries,...b})=>b);}
    const solid=p.expected.filter(b=>!b.clear&&b.block!=='AIR');if(p.baseY===undefined&&solid.length)p.baseY=Math.min(...solid.map(b=>b.y));
    p.deferred??=[];p.badSpots??=[];p.scaffoldTried??={};p.verifyPasses??=0;p.status??='ACTIVE';
  }
  function block(c,p,b){
    const was=p.blocker?.text;
    p.blocker={...b,since:p.blocker?.kind===b.kind?p.blocker.since:now()};
    p.blocker.text=describeBlocker(p.blocker,{now:now(),nameOf});
    p.status='BLOCKED';
    const gist=t=>String(t??'').replace(/ Next check in .*$/,'');   // the countdown changes every tick; the reason does not
    if(gist(p.blocker.text)!==gist(was)){log('build_blocked_status',{agent:c.id,project:p.name,kind:b.kind,text:p.blocker.text});d.onBlocked?.(c,p);}
  }
  const unblock=p=>{if(p.blocker){p.blocker=null;p.status='ACTIVE';}};
  /** A natural break in the work (for meals, meetings): a layer done, a scaffold down, or blocked. */
  const breakpoint=p=>!!p&&(p.status==='BLOCKED'||p.waiting||!!p.atBreak||(p.placedSinceBreak??0)>=60);

  async function step(c,s,self){
    const p=s.project;migrate(p);
    if(p.atBreak){p.atBreak=false;p.placedSinceBreak=0;}
    if(p.terrainPending){if(now()>=(p.terrainRetryAt??0))await civic().prepareProject(c,s);
      if(p.terrainPending){block(c,p,{kind:'obstructed',phase:'Terrain',detail:p.prepared?.failed?'site scan unavailable':`${p.prepared?.blocked??0} protected obstructions and ${p.prepared?.unsupported??0} unsupported ground columns; terrain must be prepared before building`,nextCheck:p.terrainRetryAt});return 'blocked';}}
    // Materials: civic fetches, reserves and assigns suppliers (fetchForProject); the blocker comes from there.
    // Waiting on materials: after his patience runs out the project is set aside (checked again in 20 minutes) so he
    // can build something else meanwhile - homes for the homeless above all (the library sat waiting for bookshelves).
    if(p.waiting){p.progressAt=now();if(p.materials)block(c,p,{kind:'materials',phase:phaseOf(p,p.queue[0]?.y??0),...p.materials});return maybePark(c,s,{recheckMs:1200000})==='parked'?'parked':'waiting';}
    if(p.placed!==p.lastPlaced){p.lastPlaced=p.placed;p.progressAt=now();}
    if(now()-(p.lastStep??0)>30000)p.progressAt=now();
    p.lastStep=now();
    if(p.scaffold){p.progressAt=now();return scaffoldStep(c,p,self);}
    const st=nextBuildStep(p,self,d.reach-3,civic().batchFor(c.id));
    if(st.kind==='done'){
      if(requeueDue(p,{now:now()}))return 'retry';
      if(p.deferred.length){block(c,p,deferredBlocker(p,{now:now()}));return maybePark(c,s);}
      return inspectAndFinish(c,s,self);
    }
    if(st.kind==='unreachable')return access(c,p,self,st);
    if(st.kind==='place'){
      const want=st.blocks;
      // Wrong block in the spot (found by the inspection): take it away first (natural ground: clear; ours: break).
      for(const b of want.filter(b=>b.replace)){await act(c.id,{type:'clear',x:b.x,y:b.y,z:b.z}).catch(()=>act(c.id,{type:'break',x:b.x,y:b.y,z:b.z})).catch(()=>{});b.replace=false;}
      const results=await placeAll(c.id,want,{free:!!p.free||!civic().economyReady()});
      const layerBefore=Math.min(...p.queue.filter(b=>!b.clear).map(b=>b.y),Infinity);
      const placed=recordPlacements(p,results,{now:now()});
      civic().award(c.id,'place',placed);
      if(placed){unblock(p);p.lastGap=undefined;p.walks=0;p.placedSinceBreak=(p.placedSinceBreak??0)+placed;
        const layerAfter=Math.min(...p.queue.filter(b=>!b.clear).map(b=>b.y),Infinity);if(layerAfter>layerBefore)p.atBreak=true;}
      p.moveFails=0;return 'placed';
    }
    return move(c,p,self,st);
  }

  /** Walk toward the work; a spot that cannot be reached is remembered and the next standing spot is used. */
  async function move(c,p,self,st){
    if(self.pathing||['moving','loading'].includes(self.navigation?.status))return 'walking';
    if(now()-(p.walkAt??0)<5000)return 'walking';
    p.walkAt=now();
    const gap=Math.hypot(st.x-self.x,st.z-self.z);
    const noCloser=p.lastGap!==undefined&&gap>=p.lastGap-0.5;
    p.lastGap=Math.min(gap,p.lastGap??gap);
    if(noCloser)p.noCloser=(p.noCloser??0)+1;else p.noCloser=0;
    // Patience sets how many fruitless walks before a spot is given up for another one.
    const patience=2+Math.round(traits(c.id).patience*4);
    let dest={x:st.x,y:st.y,z:st.z};
    if(p.noCloser>=patience){
      p.badSpots.push(`${Math.floor(st.x)},${st.y},${Math.floor(st.z)}`);
      // Standing on the chosen spot and still unable to work from it: that spot is no good either.
      if(p.spot)p.badSpots.push(`${Math.floor(p.spot.x)},${p.spot.y},${Math.floor(p.spot.z)}`);p.spot=null;p.badSpots=p.badSpots.slice(-200);p.noCloser=0;p.lastGap=undefined;
      const spots=st.target?standingSpots(st.target,p,{reach:d.reach-3,base:p.baseY??st.target.y,self,bad:p.badSpots}):[];
      if(!spots.length){deferBlock(p,st.target,'unreachable: no standing spot reached',{now:now()});log('build_access_deferred',{agent:c.id,project:p.name,block:st.target});return 'deferred';}
      dest={x:spots[0].x,y:spots[0].y,z:spots[0].z};p.spot=dest;
      log('build_new_spot',{agent:c.id,project:p.name,spot:dest,left:spots.length});
    }else if(p.spot&&st.target&&dist3({x:p.spot.x,y:p.spot.y+1,z:p.spot.z},centre(st.target))<=d.reach-3)dest=p.spot;
    // Far away: the town's travel (roads, plugin legs with detours and chunk loading).
    if(gap>20){await d.travel(c.id,self,dest).catch(()=>{});return 'travelling';}
    // Up on the building (a wall top, a roof ring) within arm's reach: climb onto it.
    if(dest.y>self.y+1.5&&Math.hypot(dest.x-self.x,dest.z-self.z)<=3.2&&dest.y-self.y<=12){
      const ok=await act(c.id,{type:'climb',x:dest.x,y:dest.y,z:dest.z}).then(()=>true).catch(()=>false);
      if(ok)return 'climbed';
    }
    try{await walk(c.id,{type:'pathfind',...dest});}
    catch(error){
      if(/Busy|No way/.test(error.message))return 'waiting';
      p.badSpots.push(`${Math.floor(dest.x)},${dest.y},${Math.floor(dest.z)}`);p.moveFails=(p.moveFails??0)+1;
    }
    return 'walking';
  }

  /** Nothing on this layer in reach from ground or floor: a standing spot near it, then a scaffold for its section. */
  async function access(c,p,self,st){
    const target=st.target,base=p.baseY??(st.inside.y-1);
    const spots=standingSpots(target,p,{reach:d.reach-3,base,self,bad:p.badSpots});
    if(spots.length&&(p.accessTries?.[`${target.x},${target.y},${target.z}`]??0)<2+(spots.some(s=>s.onBuilding)?2:0)){
      (p.accessTries??={})[`${target.x},${target.y},${target.z}`]=(p.accessTries[`${target.x},${target.y},${target.z}`]??0)+1;
      return move(c,p,self,{...spots[0],target,kind:'move'});
    }
    const section=sectionOf(p,target),tried=p.scaffoldTried[section]??=[];
    // Bolder builders try more columns before calling the section blocked.
    const maxColumns=3+Math.round(traits(c.id).risk_tolerance*3);
    const col=tried.length<maxColumns?scaffoldColumn(p,target,{floor:base+1,ground:base,tried}):null;
    if(!col){
      const layer=p.queue.filter(b=>sectionOf(p,b)===section&&b.y===target.y);
      for(const b of layer)deferBlock(p,b,'unreachable: no scaffold position worked for this roof section',{now:now()});
      block(c,p,{kind:'access',phase:phaseOf(p,target.y),detail:`roof section ${section} out of reach after ${tried.length} scaffold position${tried.length===1?'':'s'}; trying again later`,nextCheck:now()+300000});
      return 'deferred';
    }
    tried.push(col.key);
    const blocks=[];for(let y=col.base;y<=col.top;y++)blocks.push({x:col.x,y,z:col.z,done:false});
    p.scaffold={x:col.x,z:col.z,base:col.base,top:col.top,beside:col.beside,blocks,state:'fetch',failed:0,section};
    p.scaffolds=(p.scaffolds??0)+1;
    log('scaffold_planned',{agent:c.id,project:p.name,section,x:col.x,z:col.z,from:col.base,to:col.top,attempt:tried.length});
    say(c.id,`That part of the roof is out of reach - putting up scaffolding there.`).catch(()=>{});
    return 'scaffold';
  }

  async function scaffoldStep(c,p,self){
    const sc=p.scaffold,id=c.id,beside=sc.beside??{x:sc.x+1.5,y:sc.base,z:sc.z+0.5};
    const done=()=>{log('scaffold_removed',{agent:id,project:p.name,blocks:sc.blocks.length,section:sc.section});p.scaffold=null;p.atBreak=true;};
    if(sc.state==='fetch'){
      const need=sc.blocks.length-(self.inventory?.DIRT??0);
      if(need<=0){sc.state='build';return 'scaffold';}
      if(!await civic().goToWarehouse(id,self))return 'walking';
      if(await civic().withdraw(id,'DIRT',need)<need){
        block(c,p,{kind:'materials',phase:'Scaffolding',missing:{DIRT:need},assigned:{},nextCheck:now()+60000});
        p.scaffold=null;return 'blocked';
      }
      sc.state='build';return 'scaffold';
    }
    if(sc.state==='build'){
      const todo=sc.blocks.filter(b=>!b.done).sort((a,b)=>a.y-b.y);
      if(!todo.length){
        const r=await act(id,{type:'climb',x:sc.x+0.5,y:sc.top+1,z:sc.z+0.5}).catch(e=>({error:e.message}));
        if(r?.error){sc.state='down';return 'scaffold';}
        sc.state='on';log('scaffold_up',{agent:id,project:p.name,y:sc.top+1,section:sc.section});return 'scaffold';
      }
      if(Math.hypot(self.x-beside.x,self.z-beside.z)>2.5||Math.abs(self.y-sc.base)>1.5){
        if(self.pathing)return 'walking';
        await walk(id,{type:'pathfind',...beside}).catch(()=>{sc.failed++;});
        if(sc.failed>8){sc.state='down';}
        return 'walking';
      }
      for(const b of todo.slice(0,4)){
        const r=await act(id,{type:'place',x:b.x,y:b.y,z:b.z,target:'DIRT'}).then(()=>'ok').catch(e=>e.message);
        if(r==='ok'){b.done=true;b.ours=true;}
        else if(/occupied/i.test(r))b.done=true;
        else if(/^Out of/.test(r)){sc.state='fetch';return 'scaffold';}
        else if(++sc.failed>8){sc.state='down';return 'scaffold';}
      }
      return 'scaffold';
    }
    if(sc.state==='on'){
      const st=nextBuildStep(p,self,d.reach-2,civic().batchFor(id));
      if(st.kind==='place'){
        const results=await placeAll(id,st.blocks,{free:!!p.free||!civic().economyReady()});
        const placed=recordPlacements(p,results,{now:now()});civic().award(id,'place',placed);
        if(placed){unblock(p);p.placedSinceBreak=(p.placedSinceBreak??0)+placed;return 'placed';}
      }
      sc.state='down';return 'scaffold';
    }
    if(sc.state==='down'){
      // Climb down only when he is actually up on this column; elsewhere (on the ground away from it, after a restart
      // or a walk) "higher than its base" just means the terrain there is higher, and climbing toward a column 20
      // blocks away failed forever (the library sat at 0/591 in this loop).
      sc.downSteps=(sc.downSteps??0)+1;
      const onColumn=Math.hypot(self.x-(sc.x+0.5),self.z-(sc.z+0.5))<2.5;
      if(sc.downSteps>40){log('scaffold_abandoned',{agent:id,project:p.name,section:sc.section});done();return 'scaffold';}
      if(onColumn&&self.y>sc.base+1.5){
        for(const pt of [beside,...[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({x:sc.x+dx+0.5,y:sc.base,z:sc.z+dz+0.5}))])if(await act(id,{type:'climb',x:pt.x,y:sc.base,z:pt.z}).then(()=>true).catch(()=>false))return 'scaffold';
        await act(id,{type:'unstick',x:0,y:0,z:0}).catch(()=>{});return 'scaffold';
      }
      const up=sc.blocks.filter(b=>b.ours&&!b.removed).sort((a,b)=>b.y-a.y);
      if(!up.length){done();return 'scaffold';}
      if(Math.hypot(self.x-beside.x,self.z-beside.z)>3&&!self.pathing){await walk(id,{type:'pathfind',...beside}).catch(()=>{});return 'walking';}
      for(const b of up.slice(0,4)){
        const r=await act(id,{type:'break',x:b.x,y:b.y,z:b.z}).then(()=>'ok').catch(e=>e.message);
        if(r==='ok'||/Only blocks placed|changed since/.test(r))b.removed=true;
        else if(++sc.failed>16){done();return 'scaffold';}
      }
    }
    return 'scaffold';
  }

  /** The final inspection: scan the site, compare with the blueprint, finish only at 100%. */
  async function inspectAndFinish(c,s,self){
    const p=s.project,id=c.id;
    if(now()<(p.inspectAt??0))return 'waiting';
    const box=inspectionBox(p.expected),cells=[];
    for(const page of scanPages(box)){
      const r=await act(id,{type:'scan',...page}).catch(e=>({error:e.message}));
      if(r?.error){p.inspectAt=now()+60000;block(c,p,{kind:'verify',phase:'Inspection',detail:`could not scan the site (${r.error})`,nextCheck:p.inspectAt});return 'blocked';}
      cells.push(...(r.cells??[]));
    }
    const result=inspect(p.expected,cells);p.verifyPasses++;
    p.inspection={time:now(),pct:result.pct,matched:result.matched,total:result.total,missing:result.missing.length,wrong:result.wrong.length};
    log('build_inspection',{agent:id,project:p.name,...p.inspection,pass:p.verifyPasses});
    if(result.missing.length||result.wrong.length){
      // Back into the queue: missing blocks as they are, wrong ones marked to be replaced. After several passes with the
      // same gaps they are deferred (with the reason) so the project parks instead of looping.
      for(const b of [...result.missing,...result.wrong.map(w=>({...w,replace:true}))]){
        const {found,...blk}=b;if(blk.block==='AIR'){blk.block='CLEAR';blk.clear=true;blk.demolish=!!p.renovation;blk.replace=false;}const k=`${blk.x},${blk.y},${blk.z}`;
        p.reworked??={};p.reworked[k]=(p.reworked[k]??0)+1;
        // Meticulous builders keep at a stubborn block longer before setting it aside.
        if(p.reworked[k]>2+Math.round(traits(id).craftsmanship*6)){(p.deferred??=[]).push({...blk,deferrals:5,reason:found?`a ${label(found)} is there and could not be replaced`:'placed but not standing',kind:found?'obstructed':'placement',nextAt:now()+600000});continue;}
        p.queue.push({...blk,tries:0});
      }
      block(c,p,{kind:'verify',phase:'Inspection',detail:`${result.pct}% matches the plan; ${result.missing.length} missing and ${result.wrong.length} wrong blocks going back on the list`,nextCheck:now()+5000});
      p.status='ACTIVE';
      return 'rework';
    }
    // Every blueprint block is in place: finished, and only now said to be.
    const summary=`${p.name}: ${result.matched}/${result.total} blocks, inspected against the plan`;
    if(p.homeFor)memory.data.village.built[p.homeFor]=true;
    p.verified=true;p.status='DONE';
    civic().onProjectDone(c,p,true);
    s.project=null;memory.add?.(id,{time:now(),project:summary});
    log('project_done',{agent:id,summary,verified:true,passes:p.verifyPasses});ledger(id,`finished ${summary}`);
    await say(id,`The ${p.name} is finished - I checked every block against the plan.`).catch(()=>{});
    return 'done';
  }

  /** A project blocked for long is parked (with its blocker) so the builder can do other work until the next check. */
  function maybePark(c,s,{recheckMs=null}={}){
    const p=s.project;
    const waitMin=4+Math.round(traits(c.id).patience*6);   // patient builders wait longer on site before moving on
    if(!p.blocker||now()-p.blocker.since<waitMin*60000)return 'blocked';
    p.status='PARKED';p.parkedAt=now();
    (town().parkedProjects??=[]).push({builder:c.id,project:p,nextCheck:recheckMs?now()+recheckMs:p.blocker.nextCheck??now()+300000});
    s.project=null;
    log('project_parked',{agent:c.id,project:p.name,blocker:p.blocker.text});
    ledger(c.id,`set the ${p.name} aside for now: ${p.blocker.text}`);
    return 'parked';
  }
  /** Back to a parked project when its next check is due (builderWork calls this before starting anything new). */
  function resumeParked(c,s){
    // A parked home whose house is already marked built is stale (the fisher's house came back from a parked plan
    // that sat on its roof): dropped, never resumed.
    if(d.staleProject)town().parkedProjects=(town().parkedProjects??[]).filter(x=>{const st=d.staleProject(x.project);if(st)log('parked_dropped',{agent:x.builder,project:x.project.name,why:'already built'});return !st;});
    const list=town().parkedProjects??[],i=list.findIndex(x=>x.builder===c.id&&x.nextCheck<=now());
    if(i<0||s.project)return false;
    const [x]=list.splice(i,1);s.project=x.project;s.project.status='ACTIVE';
    requeueDue(s.project,{now:now()+Infinity});   // everything deferred gets another go
    log('project_resumed',{agent:c.id,project:s.project.name,was:x.project.blocker?.text});
    return true;
  }
  /** What the builder can truthfully say about a project. */
  function statusLine(p){
    if(!p)return null;
    if(p.verified)return `The ${p.name} is finished and inspected.`;
    if(p.blocker)return p.blocker.text;
    const left=p.queue.length+(p.deferred?.length??0);
    return `${phaseOf(p,p.queue[0]?.y??0)} of the ${p.name}: ${p.placed} placed, ${left} to go.`;
  }
  const view=()=>({parked:(town().parkedProjects??[]).map(x=>({builder:x.builder,name:x.project.name,blocker:x.project.blocker?.text,nextCheck:x.nextCheck}))});
  return {step,resumeParked,breakpoint,statusLine,view,inspectAndFinish};
}
