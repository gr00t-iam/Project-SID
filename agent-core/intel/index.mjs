// The intelligence stack, assembled: spatial memory, hierarchical goals, the work order board, reflection,
// the social trust matrix and the conversation archive, all in settlement_intelligence.db.
// main.mjs creates one instance and wires its hooks into the worker loop, the model loop, events and the dashboard.
import path from 'node:path';
import {openDatabase,json} from './db.mjs';
import {createSpatial} from './spatial.mjs';
import {createSocial,baselineTrust} from './social.mjs';
import {createBoard,PRIORITY} from './orders.mjs';
import {createReflector,classify} from './reflect.mjs';
import {createGoals} from './goals.mjs';
import {createArchive} from './archive.mjs';
import {createExecutor} from './executor.mjs';
import {createMotivation} from './motivation.mjs';

const EDIBLE=/^(BREAD|COOKED_[A-Z_]+|BAKED_POTATO|APPLE|CARROT|SWEET_BERRIES|MUSHROOM_STEW|PUMPKIN_PIE|GOLDEN_CARROT|MELON_SLICE)$/;

export function createIntelligence(d){
  const {stateDir,lm,log,ledger,say,act,getSnapshot,configs,memory,isOffline,HOSTILE}=d;
  const db=openDatabase(d.dbFile??path.join(stateDir,'settlement_intelligence.db'));
  const now=()=>Date.now();
  const town=()=>memory.data.town??{};
  const getTick=()=>({day:town().day??null,worldTime:getSnapshot()?.worldTime??null});
  const agentIds=()=>configs.map(c=>c.id);
  const isAgent=id=>configs.some(c=>c.id===id);
  const roleOf=id=>{const c=configs.find(x=>x.id===id);return c?c.role??c.id:null;};
  // Short names for records: "Hazel", "Sir Aldric", "Governor Elia"; players keep their names.
  const nameOf=id=>{const c=configs.find(x=>x.id===id);return c?.name?c.name.split(' the ')[0]:String(id);};

  const spatial=createSpatial(db,{now,log,getTick,HOSTILE});
  const social=createSocial(db,{now,log});
  const board=createBoard(db,{now,log});
  const reflector=createReflector(db,{lm,log,now,isOffline});
  const goals=createGoals(db,{lm,log,now,isOffline});
  const archive=createArchive(db,{logDir:path.join(stateDir,'data','logs'),lm,log,getSnapshot,getTick,nameOf,isAgent,playerPos:d.playerPos,now,isOffline});
  const planContext=(c,self)=>({role:roleOf(c.id),you:nameOf(c.id),inventory:self?.inventory??{},warehouseStock:d.knownStock?.(c.id)??d.civic()?.stockItems()??{},
    knownResources:spatial.query(c.id,'wood flowers berries iron coal food',5,120,{from:self}).map(r=>r.summary),openOrders:board.open().slice(0,5).map(o=>`#${o.number} ${o.issuer_name} needs ${o.quantity} ${o.target_item??o.order_type}`)});
  const executor=createExecutor({payFromBank:d.payFromBank,isAgent,stateOf:id=>memory.data.agents[id],act,say,travel:d.travel,getSnapshot,spatial,board,goals,reflector,social,log,ledger,nameOf,roleOf,perform:d.perform,
    civic:d.civic,planContext,questReward:(item,n)=>d.civic()?.rewardFor(item,n)??1});

  // Intrinsic motivation: survival, curiosity and social drives (see motivation.mjs).
  const motivation=createMotivation({db,social,goals,board,configs,memory,getSnapshot,log,ledger,say,act,travel:d.travel,civic:d.civic,
    postOrder:(...a)=>postOrder(...a),nameOf,roleOf,hostile:HOSTILE,isNight:d.isNight??(()=>false),restSpot:d.restSpot??(()=>null),baseWeights:d.baseWeights,now});

  // Where trust settles for a pair: familiarity (the motivation engine's bonds) and the source's community value.
  const baselineOf=(a,b)=>baselineTrust({familiarity:motivation.edge?.(a,b)?.familiarity??0,community:d.valuesOf?.(a)?.community??0.5});
  // One-time repair (v1): a bug logged "friction" once a second for citizens standing close together (750k events),
  // which drove nearly all trust to zero; famine-era "ignored my plea" penalties came from a food bug, not neglect.
  // Rebuild the matrix from the real history, then drop the flood from the log.
  if(!db.meta('trust_repair_v1')){
    const famineFixed=Date.parse('2026-09-30T11:30:00Z');
    const n=social.rebuild(e=>e.kind==='friction'||(e.kind==='starvation_ignored'&&e.time<famineFixed),baselineOf);
    const dropped=db.run("DELETE FROM social_events WHERE kind='friction'").changes;
    try{db.raw.exec('VACUUM');}catch{}
    db.meta('trust_repair_v1',new Date().toISOString());log('trust_repaired',{pairs:n,droppedEvents:dropped});
  }

  // One-time migrations from the old systems.
  const resetTrees=spatial.resetTrees();if(resetTrees)log('intel_trees_reset',{removed:resetTrees});
  const migratedSocial=social.migrate(town().affinity);
  const migratedOrders=board.migrateQuests(town().quests);
  if(migratedSocial||migratedOrders)log('intel_migrated',{friendships:migratedSocial,quests:migratedOrders});

  let lastSweep=0,lastObserve=0,lastPrune=0,lastDrift=Date.now();
  const guardSamples=new Map();   // order_id -> {near, total}

  /** Once per worker tick: observe, end quiet conversations, file summaries, check orders and duties. */
  function tick(){
    const snap=getSnapshot();if(!snap)return;
    const t=now();
    if(t-lastObserve>5000){lastObserve=t;spatial.observeSnapshot(snap,{built:()=>d.civic()?.footprints()??[]});}
    archive.tick();
    archive.processOne().catch(e=>log('archive_error',{message:e.message}));
    if(t-lastSweep>30000){lastSweep=t;sweepOrders(snap);}
    if(t-lastPrune>3600000){lastPrune=t;spatial.prune();}
    try{motivation.tick();}catch(e){log('motivation_error',{where:'tick',message:e.message});}
    if(t-lastDrift>600000){try{social.drift(t-lastDrift,baselineOf);}catch(e){log('intel_error',{where:'trust drift',message:e.message});}lastDrift=t;}
  }
  function sweepOrders(snap){
    for(const o of board.sweep()){
      social.apply(o.issuer_name,o.contractor_name,'order_failed',`did not deliver order #${o.number} in time`);
      try{d.onOrderOverdue?.(o);}catch(e){log('intel_error',{where:'order overdue',message:e.message});}   // the issuer may take it to court
    }
    executor.retryUnpaid().catch(e=>log('intel_error',{where:'retry unpaid',message:e.message}));
    // A hungry citizen's plea that the named helper ignored for 10 minutes.
    for(const o of board.list({status:'OPEN'})){
      const pref=board.preferredOf(o);
      if(o.priority==='EMERGENCY'&&pref&&now()-o.created>600000&&!board.flagged(o,'ignored')){
        social.apply(o.issuer_name,pref,'starvation_ignored',`ignored a food request (order #${o.number})`);
        board.note(o.order_id,{flag:'ignored',by:pref});ledger(o.issuer_name,`feels let down: ${nameOf(pref)} ignored a plea for food`);
      }
    }
    // Guard duty: count how often the guard is near the post.
    for(const o of board.list({status:'CLAIMED'}).filter(x=>x.order_type==='GUARD_DUTY')){
      const g=snap.agents.find(a=>a.id===o.contractor_name),loc=json(o.target_location);
      if(!g||!loc)continue;
      const s=guardSamples.get(o.order_id)??{near:0,total:0};s.total++;if(Math.hypot(g.x-loc.x,g.z-loc.z)<=20)s.near++;guardSamples.set(o.order_id,s);
    }
  }
  /** The guard's patrol around a claimed guard-duty post (null when not on duty). */
  function guardJob(c,s,self){
    let o=board.claimedBy(c.id);
    if(!o){const open=board.open().find(x=>x.order_type==='GUARD_DUTY'&&(!board.preferredOf(x)||board.preferredOf(x)===c.id));
      if(open){o=board.claim(open.order_id,c.id,{source:'duty'});if(o){log('guard_duty_taken',{agent:c.id,number:o.number});say(c.id,`On guard tonight - ${o.note.replace(/^guard /,'')}.`).catch(()=>{});}}}
    if(!o||o.order_type!=='GUARD_DUTY')return null;
    const loc=json(o.target_location);if(!loc)return null;
    const k=s.patrol??={};if(now()-(k.last??0)<12000||self.pathing)return null;
    return async()=>{k.last=now();const a=Math.random()*Math.PI*2,r=3+Math.random()*6;
      await d.travel(c.id,self,{x:loc.x+Math.cos(a)*r,y:Math.round(self.y),z:loc.z+Math.sin(a)*r}).catch(()=>{});};
  }
  /**
   * The work that comes from the intelligence stack for this worker tick: an active contract, the current goal
   * milestone, or (by day) claiming a new work order. busy agents (projects, digs, role loops) only claim urgent ones.
   */
  function job(c,s,self,{night,busy}){
    if(['guardian','sheriff'].includes(roleOf(c.id)))return null;
    return executor.contractJob(c,s,self)??(night?null:executor.goalJob(c,s,self))??(night||s.contract?null:executor.maybeClaim(c,s,self,busy));
  }
  // ---------- events ----------
  function onBlock(data){
    if(data.kind==='agent_mine'&&data.block){
      const c=spatial.record({observed_by:data.agent,x:data.block.x,y:data.block.y,z:data.block.z,category:/_ORE$/.test(data.block.type)?'ore':/_LOG$/.test(data.block.type)?'tree':'structure',
        item:data.block.type.replace(/^DEEPSLATE_/,'').replace(/_ORE$/,''),details:{mined:true,drops:data.drops??{}}});
      return c;
    }
    if(data.kind==='agent_farm'&&data.harvested){
      const farm=memory.data.agents[data.agent]?.farm;
      if(farm)spatial.record({observed_by:data.agent,x:farm.x,y:farm.y??64,z:farm.z,category:'farm',item:String(farm.crop??'WHEAT').replace(/_SEEDS$/,''),details:{harvested:data.harvested,width:farm.width,depth:farm.depth}});
    }
  }
  function onTrade(data){
    // Sharing food with a fellow citizen builds trust (the receiver about the giver).
    if(data.kind==='give'&&isAgent(data.to)&&isAgent(data.agent)&&EDIBLE.test(String(data.item)))social.apply(data.to,data.agent,'food_shared',`${data.count} ${data.item}`);
  }
  const onChests=(observer,chests)=>spatial.observeChests(observer,chests);
  function onProjectDone(agent,project,success,centre){
    if(success&&centre)spatial.record({observed_by:agent,x:centre.x,y:centre.y??64,z:centre.z,category:'structure',item:String(project.name).toUpperCase().replace(/\W+/g,'_').slice(0,40),summary:`${project.name} (built by ${nameOf(agent)})`});
    if(project.planStage){
      const o=board.list({status:'CLAIMED'}).find(x=>x.order_type==='CONSTRUCTION'&&json(x.target_location)?.stage===project.planStage);
      if(o&&success){board.progress(o.order_id,1,o.contractor_name);executor.settle(board.get(o.order_id),o.contractor_name);}
      else if(o)board.note(o.order_id,{event:'attempt_failed'});
    }
  }
  /** The council funded a stage: the governor posts a construction order for the builder. */
  function onStageFunded(stage,name,governor,builder){
    board.post({issuer:governor,type:'CONSTRUCTION',quantity:1,targetLocation:{stage,name},reward:6,priority:'HIGH',note:`build the ${name}`,preferred:builder});
  }
  /** Dusk with monsters about: the governor posts guard duty at the latest hotspot (or the square). */
  function onAlert(level,governor,guardian){
    if(!governor||!guardian||board.list({status:'OPEN'}).concat(board.list({status:'CLAIMED'})).some(o=>o.order_type==='GUARD_DUTY'))return;
    const mob=spatial.query(guardian,'monsters',1,70,{from:{x:272.5,z:96.5}})[0];
    const post=mob?{x:mob.x,z:mob.z,why:`${mob.item?.toLowerCase()} seen there`}:{x:283.5,z:93.5,why:'the square'};
    board.post({issuer:governor,type:'GUARD_DUTY',quantity:1,targetLocation:post,reward:3,priority:level==='red'?'EMERGENCY':'HIGH',note:`guard ${post.why} tonight`,preferred:guardian});
  }
  /** Dawn: verify guard duty (near the post for at least 40% of the night). */
  async function onDawn(){
    for(const o of board.list({status:'CLAIMED'}).filter(x=>x.order_type==='GUARD_DUTY')){
      const s=guardSamples.get(o.order_id)??{near:0,total:0};guardSamples.delete(o.order_id);
      if(s.total&&s.near/s.total>=0.4){board.progress(o.order_id,1,o.contractor_name);await executor.settle(board.get(o.order_id),o.contractor_name);d.onLabor?.(o.contractor_name,'GUARDING',1);}
      else{board.release(o.order_id,'was not at the post');board.cancel(o.order_id,'the night is over');social.apply(o.issuer_name,o.contractor_name,'order_failed',`left the guard post (order #${o.number})`);}
    }
    for(const o of board.list({status:'OPEN'}).filter(x=>x.order_type==='GUARD_DUTY'))board.cancel(o.order_id,'the night is over');
  }
  /** Posts a resource order (replaces the old agent quest board). */
  function postOrder(issuer,item,quantity,{note='',priority='MEDIUM',reward=1,preferred=null,targetLocation='warehouse'}={}){
    const o=board.post({issuer,item,quantity,note,priority,reward,preferred,targetLocation});
    if(o&&!o.merged){
      ledger(issuer,`posted work order #${o.number}: ${o.quantity} ${String(item).toLowerCase().replace(/_/g,' ')} for ${o.reward_emeralds} emeralds`);
      const title=String(item).toLowerCase().split('_').map(w=>w[0].toUpperCase()+w.slice(1)).join(' ');
      say(issuer,`📜 Work order #${o.number}: Seeking ${o.quantity} ${title} for ${o.reward_emeralds} Emerald${o.reward_emeralds===1?'':'s'}${note?` (${note})`:''}.`).catch(()=>{});
    }
    return o;
  }
  // ---------- model loop: do not repeat failures, reflect on them ----------
  function beforeAction(agent,action){
    const err=reflector.repeatOf(agent,action);
    if(err)throw Error(`That exact action just failed ("${err}"). Do something different: another place, target or approach.`);
  }
  /** A planned action failed while executing: reflect and return a corrective action (or null). */
  async function onActionFailed(c,s,action,error,self){
    const cur=goals.current(c.id);
    const r=await reflector.reflect({agent:c.id,persona:{name:nameOf(c.id),role:roleOf(c.id),personality:s.personality??c.personality},subject:`free:${c.id}`,
      action,error:error.message,location:self,goal:cur?`${cur.goal.title}${cur.milestone?` -> ${cur.milestone.title}`:''}`:s.goal});
    if(r.giveUp){reflector.clear(`free:${c.id}`);if(cur?.milestone)await goals.failMilestone(cur.milestone.goal_id,error.message,planContext(c,self));return null;}
    if(r.strategy==='request_help'){const item=String(action?.target??'').toUpperCase();if(/^[A-Z_]{3,}$/.test(item))postOrder(c.id,item,Math.max(1,action.count||8),{note:'after a failed attempt',priority:'MEDIUM',reward:d.civic()?.rewardFor(item,8)??1,targetLocation:'agent'});}
    return r;
  }
  // ---------- prompts ----------
  /** Compact intelligence context for the planning prompt (kept small: planning prompts are already long). */
  function context(c,s,self){
    const cur=goals.current(c.id),k=board.claimedBy(c.id),others=agentIds().filter(x=>x!==c.id);
    const vec=social.vectors(c.id,others),byTrust=Object.entries(vec).sort((a,b)=>b[1].trust-a[1].trust);
    return {...motivation.context(c.id),intelligence:{
      goal:cur?{objective:cur.goal.title,now:cur.milestone?.title??'planning',status:cur.milestone?.status??cur.goal.status}:null,
      myContract:k?`#${k.number}: ${k.order_type==='RESOURCE_REQUEST'?`${k.quantity-k.delivered} ${k.target_item}`:k.note} for ${nameOf(k.issuer_name)}`:null,
      openWorkOrders:board.open().filter(o=>o.issuer_name!==c.id).slice(0,4).map(o=>`#${o.number} ${o.priority} ${nameOf(o.issuer_name)}: ${o.order_type==='RESOURCE_REQUEST'?`${o.quantity} ${o.target_item}`:o.note} (${o.reward_emeralds} emeralds)`),
      knownResources:spatial.query(c.id,d.resourceQueryFor?.(c)??'wood food',3,120,{from:self}).map(r=>`${r.summary} (${r.distance} blocks)`),
      trustMost:byTrust.slice(0,2).map(([k,v])=>`${nameOf(k)} ${v.trust}/${v.reliability}`),trustLeast:byTrust.slice(-2).map(([k,v])=>`${nameOf(k)} ${v.trust}/${v.reliability} ${v.feeling}`),
      howTo:'"goal" (text = an objective) starts a multi-step plan; "quest" posts a work order (target item, count) others can fill for emeralds; "claim_quest"/"turn_in_quest" (target = number) take and finish quests from openWorkOrders.'}};
  }
  /** For dialogue prompts: how each speaker sees the other, and their recent conversations. */
  function dialogueContext(a,b){
    // Grudges and favours colour the tone of the conversation.
    const rel=(x,y)=>{const v=social.view(x,y),r=social.relationship(x,y);return {trust:Math.round(v.trust_score),reliability:Math.round(v.reliability_score),feeling:v.affinity_label.toLowerCase(),
      affinity:r.affinity,grudges:r.grudges.slice(-2).map(g=>g.reason),favors:r.favors.slice(-2).map(f=>f.reason)};};
    return {[a]:{seesOther:rel(a,b),recentConversations:archive.getRecentConversations(a,3).map(e=>`${e.timestamp.slice(0,10)}: ${e.summary}`)},
      [b]:{seesOther:rel(b,a),recentConversations:archive.getRecentConversations(b,3).map(e=>`${e.timestamp.slice(0,10)}: ${e.summary}`)}};
  }
  /** For replies to a player: past conversations between this citizen and the player. */
  const playerContext=(agent,player)=>({pastConversationsWithYou:archive.getRecentConversations(player,6).filter(e=>e.participant_ids.includes(agent)).slice(0,3).map(e=>`${e.timestamp.slice(0,10)}: ${e.summary}`)});
  // ---------- commands ----------
  async function command(data,args,tell,agentFor){
    const verb=String(args[0]??'').toLowerCase();
    if(verb==='orders'||verb==='quests'){
      const open=board.active().slice(0,6);
      for(const line of open.length?open.map(o=>`#${o.number} ${o.status} ${o.priority}: ${nameOf(o.issuer_name)} needs ${o.order_type==='RESOURCE_REQUEST'?`${o.quantity-o.delivered} ${o.target_item.toLowerCase().replace(/_/g,' ')}`:o.note} - ${o.reward_emeralds} emeralds${o.contractor_name?` (${nameOf(o.contractor_name)})`:''}`):['No open work orders.'])await tell(line);
      return true;
    }
    if(verb==='goal'){
      const id=agentFor(args[1]),objective=args.slice(2).join(' ').trim();
      if(!id||objective.length<4){await tell('Use: /sid goal <citizen> <objective>, e.g. /sid goal hazel prepare winter food reserve');return true;}
      const g=goals.create(id,objective,{source:`player:${data.player}`});
      await say(id,`${data.player} asked me to: ${objective}. I'll make a plan.`).catch(()=>{});await tell(`${nameOf(id)} is planning: ${g.title}`);return true;
    }
    if(verb==='trust'){
      const id=agentFor(args[1]);if(!id){await tell('Use: /sid trust <citizen>');return true;}
      const v=social.vectors(id,agentIds());
      await tell(`${nameOf(id)} trusts: ${Object.entries(v).sort((a,b)=>b[1].trust-a[1].trust).map(([k,x])=>`${nameOf(k)} ${x.trust}/${x.reliability}`).join(', ')}`.slice(0,240));return true;
    }
    if(verb==='recall'){
      const q=args.slice(1).join(' ');const hits=spatial.query(null,q,4,null,{from:data});
      await tell(hits.length?hits.map(h=>`${h.summary} (${h.distance} blocks, ${h.age_minutes} min ago)`).join(' | ').slice(0,240):`Nobody remembers seeing ${q||'that'}.`);return true;
    }
    return false;
  }
  // ---------- dashboard ----------
  function dashboard(){
    const ids=agentIds();
    return {
      orders:board.list({limit:60}).map(o=>({...o,issuer:nameOf(o.issuer_name),contractor:o.contractor_name?nameOf(o.contractor_name):null,target_location:json(o.target_location)??o.target_location,history:json(o.history_json,[])})),
      social:{agents:ids.map(id=>({id,name:nameOf(id)})),matrix:social.matrix().filter(r=>ids.includes(r.source_agent)),events:social.events(15)},
      goals:goals.tree().slice(0,25),reflections:reflector.recent(15),spatialCounts:spatial.counts(),archive:archive.stats(),motivation:motivation.dashboard(),
    };
  }
  return {db,spatial,social,board,goals,reflector,archive,executor,motivation,tick,job,
    /** Survival preemption (and curiosity/altruism goals) for this worker tick; a job to run now, or null. */
    survivalJob:(c,s,self,o)=>motivation.job(c,s,self,o),guardJob,onBlock,onTrade,onChests,onProjectDone,onStageFunded,onAlert,onDawn,
    postOrder,beforeAction,onActionFailed,context,dialogueContext,playerContext,command,commands:['orders','quests','goal','trust','recall'],dashboard,nameOf,
    deliverFromPlayer:(...a)=>executor.deliverFromPlayer(...a),planContext,close:()=>db.close()};
}
