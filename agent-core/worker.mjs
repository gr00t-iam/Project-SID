// Fast, model-free behaviour: executing blueprint projects and guardian reflexes. Pure decision
// functions only; main.mjs performs the resulting bridge actions.
export const HOSTILE=new Set(['ZOMBIE','ZOMBIE_VILLAGER','HUSK','DROWNED','SKELETON','STRAY','BOGGED','SPIDER','CAVE_SPIDER',
  'CREEPER','WITCH','SLIME','MAGMA_CUBE','PHANTOM','PILLAGER','VINDICATOR','EVOKER','RAVAGER','VEX','SILVERFISH','ENDERMITE',
  'BLAZE','GHAST','BREEZE','ZOGLIN','HOGLIN','PIGLIN_BRUTE','WITHER_SKELETON','GUARDIAN','ELDER_GUARDIAN','SHULKER','CREAKING']);
import {deferBlock} from './construction.mjs';
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const flat=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const centre=b=>({x:b.x+0.5,y:b.y+0.5,z:b.z+0.5});

export function newProject(name,blocks){
  // expected: the blueprint the finished building is inspected against (construction.mjs inspect); site clearing excluded.
  const solid=blocks.filter(b=>!b.clear&&b.block!=='AIR');
  return {name,baseY:solid.length?Math.min(...solid.map(b=>b.y)):undefined,queue:blocks.map(b=>({...b,tries:0})),expected:blocks.filter(b=>!b.clear).map(b=>({...b})),deferred:[],total:blocks.length,placed:0,skipped:0,stalls:0,moveFails:0,status:'ACTIVE',started:Date.now()};
}
/** Next step for a project: place a batch on the lowest remaining layer within reach, or walk closer. */
export function nextBuildStep(project,self,reach,batch=12){
  if(!project.queue.length)return {kind:'done'};
  // Site preparation first (clearing, from the top down), then building layer by layer from the bottom up.
  const clearing=project.queue.filter(b=>b.clear),pool=clearing.length?clearing:project.queue;
  // Breaking needs no aim at a face to build against: plan clearing with 2 more blocks of reach (still inside the
  // plugin's 10 from the feet), so leaves 8 blocks up are cleared from the ground beneath them.
  if(clearing.length)reach+=2;
  const level=clearing.length?Math.max(...pool.map(b=>b.y)):Math.min(...pool.map(b=>b.y));
  const layer=pool.filter(b=>b.y===level);
  // Reach from eye level (feet + 1), the same measure used below to choose where to stand: a spot chosen as
  // "in reach" must also be one the builder places from (the plugin allows 10 from the feet; plans use reach-3).
  const eye={x:self.x,y:self.y+1,z:self.z};
  const inReach=layer.filter(b=>dist(centre(b),eye)<=reach).slice(0,batch);
  if(inReach.length)return {kind:'place',blocks:inReach};
  // Either stand 2 blocks outside the footprint next to the nearest unplaced block, or inside the
  // building on its floor (upper layers such as roof peaks are often only reachable from inside).
  const target=layer.reduce((a,b)=>flat(centre(a),self)<=flat(centre(b),self)?a:b);
  // Bridge blocks say where to stand (on the bank), so the builder never walks out over the water.
  if(target.stand)return {kind:'move',target,x:target.stand.x,y:target.stand.y,z:target.stand.z};
  const xs=project.queue.map(b=>b.x),zs=project.queue.map(b=>b.z);
  const cx=(Math.min(...xs)+Math.max(...xs)+1)/2,cz=(Math.min(...zs)+Math.max(...zs)+1)/2;
  const dx=target.x+0.5-cx,dz=target.z+0.5-cz,len=Math.hypot(dx,dz)||1;
  const base=project.baseY??target.y;
  const outside={x:Math.floor(target.x+0.5+dx/len*2)+0.5,y:base,z:Math.floor(target.z+0.5+dz/len*2)+0.5};
  const inside={x:Math.floor(cx)+0.5,y:base+1,z:Math.floor(cz)+0.5};
  const reachable=p=>layer.filter(b=>dist(centre(b),{x:p.x,y:p.y+1,z:p.z})<=reach).length;
  let spot=reachable(inside)>reachable(outside)?inside:outside;
  // Clearing something high on the site (a leftover tree canopy, the library's oak leaves up to y=73): stand right
  // under it - nothing is built there yet - instead of asking for scaffolding.
  if(clearing.length&&!reachable(spot)){
    const under={x:Math.floor(target.x)+0.5,y:base,z:Math.floor(target.z)+0.5};
    if(dist(centre(target),{x:under.x,y:under.y+1,z:under.z})<=reach)spot=under;
  }
  // Too high to reach from the floor or the ground (a tall roof): the caller builds scaffolding.
  if(!reachable(spot)&&target.y>base+3)return {kind:'unreachable',target,inside,outside,layer:level};
  return {kind:'move',target,...spot};
}
const RETRY=/standing there|rate|Disconnected|timeout|offline/i;
/**
 * Applies place results: successes leave the queue, transient failures retry, and a block that keeps failing is
 * DEFERRED with its reason and a back-off (construction.mjs deferBlock) - never dropped. An empty queue is not a
 * finished building: deferred blocks are retried and the result is inspected against the blueprint.
 */
export function recordPlacements(project,results,{now=Date.now()}={}){
  let progress=0;
  for(const {block,ok,error} of results){
    const i=project.queue.indexOf(block);if(i<0)continue;
    if(ok){project.queue.splice(i,1);project.placed++;progress++;continue;}
    // Out of materials: keep the block and pause the project until supplies are fetched.
    if(/^Out of /.test(error)){project.waiting=true;continue;}
    if(RETRY.test(error)&&++block.tries<=5)continue;
    // A little out of reach is not a reason to give a block up: step closer (or onto scaffolding) and try again.
    if(/outside allowed range|out of reach/i.test(error)&&++block.tries<=12){project.closer=true;continue;}
    deferBlock(project,block,error,{now});
  }
  project.stalls=progress||project.waiting?0:project.stalls+1;
  return progress;
}

/** Guardian reflex: attack the hostile nearest the protected player, otherwise stay close to them. */
export function guardianStep(self,player,{attackRange=2.8,followDistance=6,guardRadius=16}={}){
  const anchor=player??self;
  const threats=self.entities.filter(e=>HOSTILE.has(e.type)&&flat(e,anchor)<=guardRadius);
  if(threats.length){
    const target=threats.reduce((a,b)=>flat(a,anchor)<=flat(b,anchor)?a:b);
    if(dist(target,self)<=attackRange)return {kind:'attack',target};
    return {kind:'chase',target,x:target.x,y:target.y,z:target.z};
  }
  if(player&&flat(player,self)>followDistance){
    const dx=self.x-player.x,dz=self.z-player.z,len=Math.hypot(dx,dz)||1;
    return {kind:'follow',x:Math.round((player.x+dx/len*3)*2)/2,y:Math.round(player.y),z:Math.round((player.z+dz/len*3)*2)/2};
  }
  return null;
}

export function newDig(name,steps,start){
  return {name,steps:steps.map(s=>({...s,dig:s.dig.map(b=>({...b,done:false}))})),start,index:0,mined:0,stalls:0,moveFails:0,drops:{},started:Date.now()};
}
/** Next mining step: dig the current column's remaining blocks in reach, place its torch, or walk down to the last dug column. */
export function nextDigStep(dig,self,reach){
  while(dig.index<dig.steps.length){
    const step=dig.steps[dig.index];
    const todo=step.dig.filter(b=>!b.done);
    if(!todo.length){
      if(step.torch&&!step.torchPlaced)return {kind:'torch',step};
      dig.index++;continue;
    }
    const inReach=todo.filter(b=>Math.hypot(b.x+0.5-self.x,b.y+0.5-self.y,b.z+0.5-self.z)<=reach);
    if(inReach.length===todo.length)return {kind:'mine',blocks:todo};
    const stand=dig.index?dig.steps[dig.index-1].stand:dig.start;
    return {kind:'move',x:stand.x,y:stand.y,z:stand.z};
  }
  return {kind:'done'};
}
// Real hazards and zone limits stop a dig safely; being a little too far from a block ("Target outside allowed
// range") only means: step closer and try again.
const DIG_STOP=/lava|water|only allowed|disabled/i;
/** Marks mined blocks; "already air" counts as done; lava, water or zone limits end the dig safely. */
export function recordDig(dig,results){
  let progress=0;
  for(const {block,ok,error,result} of results){
    // "Built by an agent" / "placed by a player": his own torch in the tunnel (the miner was stuck a day and a half
    // on one at 208,23,112, retrying it every 35 s) - not his to dig, and no rock to clear: passed over.
    if(ok||/cannot be mined|built by an agent|placed by a player/i.test(error)&&!result){block.done=true;progress++;
      if(ok){dig.mined++;for(const [item,n] of Object.entries(result?.drops??{}))dig.drops[item]=(dig.drops[item]??0)+n;}
      continue;}
    if(DIG_STOP.test(error))return {stop:error};
  }
  dig.stalls=progress?0:dig.stalls+1;
  return {progress};
}

/** Idle reflex: step out of a crowd at once, or after idleMs without moving stroll near the agent's post. */
export function idleStep(self,others,{since,post,now=Date.now(),idleMs=45000,random=Math.random}){
  if(self.pathing)return null;
  const angle=random()*2*Math.PI;
  if(others.some(o=>flat(o,self)<1.5))
    return {kind:'separate',x:Math.floor(self.x+Math.cos(angle)*3.5)+0.5,z:Math.floor(self.z+Math.sin(angle)*3.5)+0.5};
  if(now-since<idleMs)return null;
  const anchor=post??self,r=2+random()*4;
  return {kind:'wander',x:Math.floor(anchor.x+Math.cos(angle)*r)+0.5,z:Math.floor(anchor.z+Math.sin(angle)*r)+0.5};
}

/** Minecraft night: monsters spawn from about 13000 to 23000 ticks. */
export const isNight=worldTime=>Number.isFinite(worldTime)&&(worldTime%24000)>=13000&&(worldTime%24000)<23000;

/** Agents a chat line is addressed to: "@builder", "builder," or the name as a word; "everyone"/"all" means all. */
export function mentionedAgents(text,ids,aliases={}){
  const lower=String(text).toLowerCase();
  if(/\b(everyone|everybody|all of you)\b/.test(lower))return [...ids];
  const said=word=>new RegExp(`(^|[^a-z0-9_])@?${word}([^a-z0-9_]|$)`).test(lower);
  // Agents answer to their id ("scout") and to their given name ("Wren").
  return ids.filter(id=>said(id.toLowerCase())||Object.entries(aliases).some(([alias,target])=>target===id&&said(alias)));
}

const BUILD_SHAPES=['house','floor','walls','path','box'];
/** Parses /sid arguments into an order; returns {error} for bad input. */
export function parseCommand(args,ids,aliases={}){
  const [verb='',...rest]=args.map(a=>String(a).toLowerCase());
  const who=name=>name==='all'?[...ids]:ids.includes(name)?[name]:aliases[name]?[aliases[name]]:null;
  if(['come','follow','stay','free','home'].includes(verb)){
    const targets=who(rest[0]??'');
    if(!targets)return {error:`Name a bot (${ids.join(', ')}) or all`};
    if(verb==='follow'&&targets.length>1)return {error:'Only one bot can follow you at a time'};
    return {kind:verb,targets};
  }
  if(verb==='quests')return {kind:'quests'};
  if(verb==='endorse'){const target=rest[0]&&(aliases[rest[0]]??rest[0]);return target?{kind:'endorse',target}:{error:'Usage: /sid endorse <candidate>'};}
  if(verb==='vote'||verb==='veto'){
    const id=(rest[0]??'').replace('#','');
    if(!/^\d+$/.test(id))return {error:`Usage: /sid ${verb==='vote'?'vote <id> yes|no':'veto <id>'}`};
    if(verb==='veto')return {kind:'vote',id,vote:'no',veto:true};
    if(!['yes','no'].includes(rest[1]))return {error:'Usage: /sid vote <id> yes|no'};
    return {kind:'vote',id,vote:rest[1]};
  }
  if(verb==='build'){
    const shape=rest[0];
    if(!BUILD_SHAPES.includes(shape))return {error:`Build one of: ${BUILD_SHAPES.join(', ')}`};
    const size=Number.parseInt(rest.find(r=>/^\d+$/.test(r))??'',10);
    const material=rest.find(r=>/^[a-z_]{3,}$/.test(r)&&r!==shape);
    return {kind:'build',shape,size:Number.isFinite(size)?Math.max(shape==='house'?5:1,Math.min(15,size)):(shape==='house'?7:shape==='path'?12:5),material:material?.toUpperCase()};
  }
  return {error:'Try /sid help'};
}

/** Where a /sid build lands: the footprint starts 2 blocks in front of the player, centred on their line of sight. */
export function frontOf(player,size){
  const rad=player.yaw*Math.PI/180,dx=-Math.sin(rad),dz=Math.cos(rad);
  const facing=Math.abs(dx)>Math.abs(dz)?(dx>0?'east':'west'):(dz>0?'south':'north');
  const [fx,fz]={east:[1,0],west:[-1,0],south:[0,1],north:[0,-1]}[facing];
  const px=Math.floor(player.x),pz=Math.floor(player.z),half=Math.floor(size/2);
  const cx=px+fx*(half+2),cz=pz+fz*(half+2);
  // The door faces back toward the player.
  const door={east:'west',west:'east',south:'north',north:'south'}[facing];
  return {x:cx-half,z:cz-half,facing,door,x2:px+fx*(size+1),z2:pz+fz*(size+1)};
}

/** Night patrol: walk a loop of waypoints, moving on when close to the current one. */
export function patrolStep(self,waypoints,state){
  if(!waypoints.length)return null;
  state.index??=0;
  const current=waypoints[state.index%waypoints.length];
  if(Math.hypot(current.x-self.x,current.z-self.z)<3)state.index++;
  return {kind:'patrol',...waypoints[state.index%waypoints.length]};
}
