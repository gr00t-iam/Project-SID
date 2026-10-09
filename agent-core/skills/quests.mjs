// The citizen quest engine: quests are work orders on the board (intel/orders.mjs) with a category, a reward and a
// lifecycle the citizens drive themselves (claim_quest -> progress_quest -> turn_in_quest), so the old
// RESOURCE_REQUEST / CONSTRUCTION / GUARD_DUTY orders keep working and the new kinds sit beside them.
//
//   FETCH_RESOURCES      bring items (to the warehouse or into the issuer's hands)        order type RESOURCE_REQUEST
//   CRAFT_ITEM           make an item from ingredients and hand it over                  order type CRAFT_ITEM
//   BUILD_STRUCTURE      build a council-funded building or wall                         order type CONSTRUCTION
//   PATROL_TERRITORY     walk a round of waypoints (one unit per waypoint)               order type PATROL_TERRITORY / GUARD_DUTY
//   INVESTIGATE_DISPUTE  the sheriff looks into a complaint and files findings           order type INVESTIGATE_DISPUTE
//   COMMUNITY_SERVICE    minutes of useful town work (repairs, lighting, tidying)        order type COMMUNITY_SERVICE
//
// Pure helpers (categories, who may take what, rewards, the quests citizens post from the town's needs) are
// exported for tests; createQuests() binds them to the board and the world.

export const CATEGORIES={
  FETCH_RESOURCES:{type:'RESOURCE_REQUEST',unit:'item',label:'fetch'},
  CRAFT_ITEM:{type:'CRAFT_ITEM',unit:'item',label:'craft'},
  BUILD_STRUCTURE:{type:'CONSTRUCTION',unit:'building',label:'build'},
  PATROL_TERRITORY:{type:'PATROL_TERRITORY',unit:'waypoint',label:'patrol'},
  INVESTIGATE_DISPUTE:{type:'INVESTIGATE_DISPUTE',unit:'finding',label:'investigate'},
  COMMUNITY_SERVICE:{type:'COMMUNITY_SERVICE',unit:'minute',label:'community service'},
};
export const QUEST_TYPES=['CRAFT_ITEM','PATROL_TERRITORY','INVESTIGATE_DISPUTE','COMMUNITY_SERVICE'];
const TYPE_TO_CATEGORY={RESOURCE_REQUEST:'FETCH_RESOURCES',CONSTRUCTION:'BUILD_STRUCTURE',GUARD_DUTY:'PATROL_TERRITORY',
  CRAFT_ITEM:'CRAFT_ITEM',PATROL_TERRITORY:'PATROL_TERRITORY',INVESTIGATE_DISPUTE:'INVESTIGATE_DISPUTE',COMMUNITY_SERVICE:'COMMUNITY_SERVICE'};
export const categoryOf=order=>TYPE_TO_CATEGORY[order?.order_type]??'FETCH_RESOURCES';
/** Quests measured in units of work rather than items (no inventory changes hands). */
export const isWorkQuest=order=>['PATROL_TERRITORY','INVESTIGATE_DISPUTE','COMMUNITY_SERVICE'].includes(order?.order_type);

// How long a claim may run before it goes back on the board (ms). Buildings take hours; a patrol, minutes.
export const CLAIM_LIMIT={CONSTRUCTION:3*3600000,PATROL_TERRITORY:30*60000,INVESTIGATE_DISPUTE:40*60000,COMMUNITY_SERVICE:60*60000,CRAFT_ITEM:40*60000};

/** Whether a citizen of `role` may take a quest of this category (stock and ingredients are checked elsewhere). */
export function eligible(category,role,{sheriffExists=true}={}){
  switch(category){
    case 'INVESTIGATE_DISPUTE':return role==='sheriff'||(!sheriffExists&&role==='guardian');
    case 'PATROL_TERRITORY':return ['sheriff','guardian','scout'].includes(role);
    case 'BUILD_STRUCTURE':return role==='builder';
    case 'COMMUNITY_SERVICE':return !['sheriff','guardian','governor','visitor'].includes(role);
    case 'CRAFT_ITEM':return ['crafter','smith','chef','farmer','fisher','lumberjack'].includes(role);
    default:return !['sheriff','guardian','visitor'].includes(role);
  }
}

/** The reward for a quest: emeralds, plus the reputation and trust a job well done earns. */
export function questReward(category,quantity=1,{value=1}={}){
  const n=Math.max(1,quantity);
  switch(category){
    case 'FETCH_RESOURCES':return {emeralds:Math.max(1,Math.min(16,Math.round(value*n))),reputation:1,trust:2};
    case 'CRAFT_ITEM':return {emeralds:Math.max(2,Math.min(20,Math.round(value*n*1.5)+1)),reputation:2,trust:3};
    case 'BUILD_STRUCTURE':return {emeralds:6,reputation:5,trust:4};
    case 'PATROL_TERRITORY':return {emeralds:Math.max(1,Math.min(6,Math.ceil(n/3))),reputation:2,trust:2};
    case 'INVESTIGATE_DISPUTE':return {emeralds:3,reputation:3,trust:2};
    case 'COMMUNITY_SERVICE':return {emeralds:Math.max(1,Math.min(8,Math.floor(n/3))),reputation:3,trust:3};
    default:return {emeralds:1,reputation:1,trust:1};
  }
}

/** Waypoints for a patrol round: a ring around a centre, starting with the point nearest north. */
export function patrolRoute(centre,{points=6,radius=14}={}){
  return Array.from({length:points},(_,i)=>{const a=-Math.PI/2+2*Math.PI*i/points;return {x:Math.round(centre.x+Math.cos(a)*radius)+0.5,z:Math.round(centre.z+Math.sin(a)*radius)+0.5};});
}

/**
 * The quests citizens post from what the town needs right now. ctx:
 *   {shortages:[{item,n,by}], brokenTools:[{agent,tool}], threats, darkSpots, damageOpen, complaints:[{conflict_id,by,against}],
 *    fundedStages:[{stage,name}], active:[orders on the board], roles:{role:id}, square:{x,z}}
 * Each quest: {category,issuer,item?,quantity,note,priority,preferred?,targetLocation?,key}. Never repeats one already active.
 */
export function generateQuests(ctx){
  const out=[],active=ctx.active??[],roles=ctx.roles??{};
  const has=(type,pred)=>active.some(o=>o.order_type===type&&['OPEN','CLAIMED','DELIVERED'].includes(o.status)&&pred(o));
  const gov=roles.governor??Object.values(roles)[0];
  const loc=o=>{try{return typeof o.target_location==='string'?JSON.parse(o.target_location):o.target_location;}catch{return o.target_location;}};
  for(const s of (ctx.shortages??[]).slice(0,2))
    if(!has('RESOURCE_REQUEST',o=>o.target_item===s.item))out.push({category:'FETCH_RESOURCES',issuer:s.by??roles.builder??gov,item:s.item,quantity:Math.min(64,s.n),note:`for the ${s.for??'building work'}`,priority:'MEDIUM',key:`fetch:${s.item}`});
  for(const t of (ctx.brokenTools??[]).slice(0,2))
    if(!has('CRAFT_ITEM',o=>o.target_item===t.tool&&o.issuer_name===t.agent))out.push({category:'CRAFT_ITEM',issuer:t.agent,item:t.tool,quantity:1,note:'mine wore out',priority:'MEDIUM',preferred:roles.smith,key:`craft:${t.agent}:${t.tool}`});
  if((ctx.threats??0)>=3&&!has('PATROL_TERRITORY',()=>true)&&gov)
    out.push({category:'PATROL_TERRITORY',issuer:gov,quantity:6,note:`walk the bounds: ${ctx.threats} monsters seen this week`,priority:'HIGH',preferred:roles.sheriff,targetLocation:{x:ctx.square?.x??283.5,z:ctx.square?.z??93.5,radius:16},key:'patrol'});
  for(const c of (ctx.complaints??[]))
    if(!has('INVESTIGATE_DISPUTE',o=>loc(o)?.conflict_id===c.conflict_id))out.push({category:'INVESTIGATE_DISPUTE',issuer:c.by,quantity:1,note:`look into ${c.reason??'a complaint'} (${c.conflict_id})`,priority:'HIGH',preferred:roles.sheriff,targetLocation:{conflict_id:c.conflict_id,x:c.location?.x,z:c.location?.z},key:`investigate:${c.conflict_id}`});
  if(((ctx.damageOpen??0)>=4||(ctx.darkSpots??0)>=6)&&!has('COMMUNITY_SERVICE',o=>!loc(o)?.sentence)&&gov)
    out.push({category:'COMMUNITY_SERVICE',issuer:gov,quantity:10,note:(ctx.damageOpen??0)>=4?`help repair ${ctx.damageOpen} damaged blocks`:`light ${ctx.darkSpots} dark corners`,priority:'MEDIUM',targetLocation:{x:ctx.square?.x??283.5,z:ctx.square?.z??93.5},key:'service'});
  for(const f of (ctx.fundedStages??[]))
    if(!has('CONSTRUCTION',o=>loc(o)?.stage===f.stage)&&gov)out.push({category:'BUILD_STRUCTURE',issuer:gov,quantity:1,note:`build the ${f.name}`,priority:'HIGH',preferred:roles.builder,targetLocation:{stage:f.stage,name:f.name},key:`build:${f.stage}`});
  return out;
}

/** One line for prompts and chat. */
export function describe(o,nameOf=x=>x){
  const cat=categoryOf(o),left=o.quantity-o.delivered,item=String(o.target_item??'').toLowerCase().replace(/_/g,' ');
  const what={FETCH_RESOURCES:`fetch ${left} ${item}`,CRAFT_ITEM:`craft ${left} ${item}`,BUILD_STRUCTURE:o.note??'build',PATROL_TERRITORY:`patrol ${left} waypoints`,
    INVESTIGATE_DISPUTE:o.note??'investigate a dispute',COMMUNITY_SERVICE:`${left} minutes of community service`}[cat];
  return `#${o.number} [${cat}] ${what} for ${nameOf(o.issuer_name)} (${o.reward_emeralds} emeralds, ${o.status})`;
}

/**
 * Binds the engine to the board. d: {board, executor, social, act, say, log, ledger, nameOf, roleOf, getSnapshot, civic, travel,
 * award, valueOf(item), now}. The work quests (patrol, service) run here; investigations run in the sheriff's loop.
 */
export function createQuests(d){
  const {board,log=()=>{},ledger=()=>{},nameOf=x=>x,roleOf=x=>x,now=()=>Date.now()}=d;
  const json=v=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return v;}};
  const find=ref=>board.get(String(ref).replace('#',''));
  const sheriffExists=()=>!!d.configs?.some(c=>(c.role??c.id)==='sheriff');

  /** Posts a quest of a category. Returns the order (or null when the board is full). */
  function post({category='FETCH_RESOURCES',issuer,item=null,quantity=1,note='',priority='MEDIUM',preferred=null,targetLocation,reward}){
    const cat=CATEGORIES[category]??CATEGORIES.FETCH_RESOURCES;
    const r=reward??questReward(category,quantity,{value:item?d.valueOf?.(item)??1:1}).emeralds;
    const o=board.post({issuer,type:cat.type,item,quantity,note:note.slice(0,150),priority,preferred,reward:r,
      targetLocation:targetLocation??(category==='FETCH_RESOURCES'?'warehouse':category==='CRAFT_ITEM'?'agent':null)});
    if(o&&!o.merged){log('quest_posted',{number:o.number,category,issuer,item,quantity:o.quantity,reward:o.reward_emeralds});ledger(issuer,`posted quest #${o.number}: ${describe(o,nameOf)}`);}
    return o;
  }
  /** claim_quest: a citizen takes a quest it can do. */
  function claim(id,ref){
    const o=find(ref);if(!o)throw Error(`No quest #${ref}`);
    if(o.status!=='OPEN')throw Error(`Quest #${o.number} is ${o.status.toLowerCase()}${o.contractor_name?` (taken by ${nameOf(o.contractor_name)})`:''}`);
    if(o.issuer_name===id)throw Error('That is your own quest');
    const cat=categoryOf(o);
    const assigned=json(o.target_location)?.assigned;
    if(assigned&&assigned!==id)throw Error(`Quest #${o.number} is ${nameOf(assigned)}'s sentence`);
    if(!assigned&&!eligible(cat,roleOf(id),{sheriffExists:sheriffExists()}))throw Error(`A ${roleOf(id)} cannot take a ${cat.toLowerCase().replace(/_/g,' ')} quest`);
    const c=board.claim(o.order_id,id,{source:isWorkQuest(o)?'work':cat==='BUILD_STRUCTURE'?'build':'self'});   // the claim limit per kind is in orders.mjs
    log('quest_claimed',{number:o.number,category:cat,by:id});
    return c;
  }
  /**
   * progress_quest: n more units done (items delivered to the warehouse/issuer are counted by the executor; work units here).
   * Returns the order.
   */
  function progress(id,ref,n=1){
    const o=find(ref);if(!o)throw Error(`No quest #${ref}`);
    if(o.contractor_name&&o.contractor_name!==id)throw Error(`Quest #${o.number} belongs to ${nameOf(o.contractor_name)}`);
    if(!['OPEN','CLAIMED'].includes(o.status))throw Error(`Quest #${o.number} is ${o.status.toLowerCase()}`);
    const p=board.progress(o.order_id,Math.max(1,Math.round(n)),id);
    log('quest_progress',{number:o.number,by:id,done:p.delivered,of:p.quantity});
    return p;
  }
  /** turn_in_quest: a finished quest is paid (emeralds from the issuer or treasury; trust and reputation). */
  async function turnIn(id,ref){
    const o=find(ref);if(!o)throw Error(`No quest #${ref}`);
    if(o.contractor_name!==id)throw Error(`Quest #${o.number} is not yours`);
    if(o.status==='VERIFIED')throw Error(`Quest #${o.number} is already paid`);
    if(o.delivered<o.quantity)throw Error(`Quest #${o.number} is not finished: ${o.delivered}/${o.quantity} ${CATEGORIES[categoryOf(o)].unit}s`);
    const paid=await d.executor.settle(board.get(o.order_id),id);
    const r=questReward(categoryOf(o),o.quantity);
    d.award?.(id,'quest',r.reputation);d.onReputation?.(id,r.reputation,`quest #${o.number}`);d.onQuestDone?.(id,o);
    log('quest_completed',{number:o.number,category:categoryOf(o),by:id,issuer:o.issuer_name,emeralds:o.reward_emeralds,paid});
    return {...board.get(o.order_id),paid};
  }

  // ---------- work quests: patrols and community service ----------
  /** The job for a claimed patrol or service quest (null when the citizen has none). */
  function workJob(c,s,self){
    const o=board.claimedBy(c.id);if(!o||!['PATROL_TERRITORY','COMMUNITY_SERVICE'].includes(o.order_type))return null;
    const w=s.questWork??={};if(w.order!==o.order_id)Object.assign(w,{order:o.order_id,leg:0,since:now(),lastUnit:now(),walks:0});
    if(self.pathing||['moving','loading'].includes(self.navigation?.status))return null;
    const loc=json(o.target_location)??{x:self.x,z:self.z};
    if(o.order_type==='PATROL_TERRITORY'){
      const route=patrolRoute(loc,{points:Math.max(3,o.quantity),radius:loc.radius??14}),next=route[w.leg%route.length];
      return async()=>{
        if(Math.hypot(self.x-next.x,self.z-next.z)>3&&w.walks<4){w.walks++;await d.travel(c.id,self,{x:next.x,y:Math.round(self.y),z:next.z}).catch(()=>{});return;}
        w.leg++;w.walks=0;const p=progress(c.id,o.number,1);
        if(p.delivered>=p.quantity){await turnIn(c.id,o.number).catch(e=>log('quest_error',{number:o.number,message:e.message}));s.questWork=null;
          await d.say?.(c.id,`Patrol done - ${p.quantity} waypoints walked, all quiet.`).catch(()=>{});}
      };
    }
    // Community service: one unit per minute of real work (repairs, lighting, tidying the square).
    const work=d.civic?.()?.serviceWork?.(c,s,self);
    return async()=>{
      if(work)await work();else if(Math.hypot(self.x-loc.x,self.z-loc.z)>6)await d.travel(c.id,self,{x:loc.x+(Math.random()*6-3),y:Math.round(self.y),z:loc.z+(Math.random()*6-3)}).catch(()=>{});
      else await d.act?.(c.id,{type:'effect',x:self.x,y:self.y,z:self.z,target:'gardening'}).catch(()=>{});
      if(now()-w.lastUnit>=60000){
        w.lastUnit=now();const p=progress(c.id,o.number,1);
        if(p.delivered>=p.quantity){await turnIn(c.id,o.number).catch(e=>log('quest_error',{number:o.number,message:e.message}));s.questWork=null;
          d.onServiceDone?.(c.id,o);await d.say?.(c.id,`That's my ${p.quantity} minutes of community service done.`).catch(()=>{});}
      }
    };
  }
  /** Picks up an open work quest meant for this citizen (patrols for the sheriff/scout, service for the sentenced). */
  function maybeTakeWork(c,s,{assignedOnly=false}={}){
    if(board.claimedBy(c.id))return null;
    const role=roleOf(c.id);
    // A sentence of community service is meant for one citizen (who takes it whatever their role); open service anyone free may do.
    const o=board.open().find(x=>['PATROL_TERRITORY','COMMUNITY_SERVICE'].includes(x.order_type)&&x.issuer_name!==c.id
      &&(json(x.target_location)?.assigned?json(x.target_location).assigned===c.id:!assignedOnly&&eligible(categoryOf(x),role,{sheriffExists:sheriffExists()}))&&(board.preferredOf(x)?board.preferredOf(x)===c.id||now()-x.created>120000:true));
    if(!o)return null;
    return async()=>{const k=claim(c.id,o.number);if(k)await d.say?.(c.id,`I'll take quest #${o.number}: ${describe(k,nameOf).replace(/^#\d+ \[[A-Z_]+\] /,'')}.`).catch(()=>{});};
  }
  /** Daily: citizens post quests from the town's needs. */
  function generate(ctx){
    const made=[];
    for(const q of generateQuests({...ctx,active:board.active()})){
      if(!q.issuer)continue;
      const o=post(q);if(o&&!o.merged)made.push(o);
    }
    return made;
  }
  /** Construction quests whose stage is finished get paid even if nobody claimed them in time. */
  async function syncConstruction(done=[],builder){
    for(const o of board.active().filter(x=>x.order_type==='CONSTRUCTION')){
      const stage=json(o.target_location)?.stage;if(!stage||!done.includes(stage))continue;
      const who=o.contractor_name??builder;if(!who)continue;
      if(o.status==='OPEN')board.claim(o.order_id,who,{source:'build'});
      if(board.get(o.order_id).status==='CLAIMED')board.progress(o.order_id,1,who);
      await d.executor.settle(board.get(o.order_id),who);log('quest_completed',{number:o.number,category:'BUILD_STRUCTURE',by:who,late:true});
    }
  }
  const list=()=>board.active().map(o=>({number:o.number,category:categoryOf(o),status:o.status,issuer:nameOf(o.issuer_name),contractor:o.contractor_name?nameOf(o.contractor_name):null,
    item:o.target_item,progress:`${o.delivered}/${o.quantity}`,reward:o.reward_emeralds,note:o.note}));
  return {post,claim,progress,turnIn,workJob,maybeTakeWork,generate,syncConstruction,list,describe:o=>describe(o,nameOf)};
}
