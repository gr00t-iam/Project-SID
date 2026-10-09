import {constructionGate,builderDuty as hasBuilderDuty} from './city.mjs';
import {readFile} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {navGuard,navPriority,destKey} from './navlease.mjs';
import http from 'node:http';
import Ajv from 'ajv';
import {Bridge,fitMapSpec} from '../node-bridge/bridge.mjs';
import {LLMRouter,isOffline} from './lm.mjs';
import {Memory} from './memory.mjs';
import {createCognition} from './cognition.mjs';
import {loadAgents,loadOptionalJson,checkEnv,ConfigError} from './config.mjs';
import {FOOD_POINTS,edibleIn} from './town.mjs';
import {assertAction,BUILD_REACH} from './actions.mjs';
import {blueprint,digPlan} from './blueprints.mjs';
import {newProject,nextBuildStep,recordPlacements,guardianStep,newDig,nextDigStep,recordDig,idleStep,isNight,mentionedAgents,parseCommand,frontOf,patrolStep,HOSTILE} from './worker.mjs';
import {createCivic,ROADS} from './civic.mjs';
import {createLife} from './life.mjs';
import {createFisher,AGENT as FISHER_AGENT} from './roles/fisher.mjs';
import {createPercy,AGENT as PERCY_AGENT} from './roles/percy.mjs';
import {createSpecialists,AGENTS as SPECIALIST_AGENTS} from './roles/specialists.mjs';
import {createPriest,AGENT as PRIEST_AGENT} from './roles/priest.mjs';
import {createMinds} from './minds.mjs';
import {createLumberjack,AGENT as LUMBER_AGENT} from './roles/lumberjack.mjs';
import {createMiner} from './roles/miner.mjs';
import {createChef,AGENT as CHEF_AGENT} from './roles/chef.mjs';
import {duplicateOf,similarity} from './skills/proposals.mjs';
import {createQuests} from './skills/quests.mjs';
import {createJustice} from './skills/justice.mjs';
import {createSheriff,AGENT as SHERIFF_AGENT} from './roles/sheriff.mjs';
import {createFunding} from './skills/funding.mjs';
import {createBank,emptyBank,DEFAULT_WAGE_RATES} from './skills/banking.mjs';
import {createEconomy} from './skills/economy.mjs';
import {createBanker,AGENT as BANKER_AGENT} from './roles/banker.mjs';
import {createJudge,AGENT as JUDGE_AGENT} from './roles/judge.mjs';
import {createHealthcare} from './skills/healthcare.mjs';
import {createRestPolicy,REST_START} from './skills/rest.mjs';
import {createClerk,AGENT as CLERK_AGENT} from './roles/clerk.mjs';
import {createLifeSim} from './lifesim.mjs';
import {createConstruction} from './construction.mjs';
import {assignLots} from './skills/property.mjs';
import {fulfilmentPlan} from './intel/orders.mjs';
import {dayPhase as phaseOf} from './town.mjs';
import {createIntelligence} from './intel/index.mjs';
import {buildWorkbook} from './intel/archive.mjs';
// Recent notable log lines, shown on the dashboard.
const recent=[];
let cognition=null;   // created below; the log feeds its feelings and memories
const log=(type,data={})=>{
  const line={time:new Date().toISOString(),type,...data};console.log(JSON.stringify(line));
  cognition?.onLog(type,data);
  lifesim?.onEvent(type,data);
  if(type==='ate')chef?.onAte(data);
  if(!['bridge','bridge_ready','lm_ready'].includes(type)){recent.push(line);if(recent.length>60)recent.shift();}
};
// Configuration: fail fast with a message that says what is wrong and how to fix it.
const fatal=error=>{log('config_error',{message:error.message,file:error.file,hint:error.hint});console.error(`Configuration error: ${error.message}${error.hint?`
  ${error.hint}`:''}`);process.exit(1);};
const envCheck=checkEnv(process.env);
for(const w of envCheck.warnings)log('config_warning',{message:w});
if(envCheck.errors.length)fatal(new ConfigError(envCheck.errors.join('; '),{hint:'Edit config/runtime.env (see config/runtime.env.example).'}));
const {configs,warnings:agentWarnings}=await loadAgents(process.env.AGENTS_FILE||'config/agents.json').catch(fatal);
for(const w of agentWarnings)log('config_warning',{message:w});
// Role modules define their own agent; add it unless agents.json already configures it.
if(!configs.some(c=>c.id===FISHER_AGENT.id))configs.push({...FISHER_AGENT});
for(const a of SPECIALIST_AGENTS)if(!configs.some(c=>c.id===a.id))configs.push({...a});
if(!configs.some(c=>c.id===PRIEST_AGENT.id))configs.push({...PRIEST_AGENT});
if(!configs.some(c=>c.id===LUMBER_AGENT.id))configs.push({...LUMBER_AGENT});
if(!configs.some(c=>c.id===CHEF_AGENT.id))configs.push({...CHEF_AGENT});
if(!configs.some(c=>c.id===SHERIFF_AGENT.id))configs.push({...SHERIFF_AGENT});
if(!configs.some(c=>c.id===BANKER_AGENT.id))configs.push({...BANKER_AGENT});
if(!configs.some(c=>c.id===JUDGE_AGENT.id))configs.push({...JUDGE_AGENT});
if(!configs.some(c=>c.id===CLERK_AGENT.id))configs.push({...CLERK_AGENT});
if(!configs.some(c=>c.id===PERCY_AGENT.id))configs.push({...PERCY_AGENT});
// memory.json is saved at most every MEMORY_SAVE_MS (default 30 s) when something changed, and always at shutdown.
const memory=new Memory(process.env.STATE_DIR||'./state',{debounceMs:Number(process.env.MEMORY_SAVE_MS??30000)});await memory.load();configs.forEach(c=>memory.agent(c));
// Settlement-wide state: governance (rules and proposals) and the shared ledger kept by the scribe.
// A goal changed in agents.json replaces the saved one (previously a saved goal never changed again).
for(const c of configs){const s=memory.data.agents[c.id];if(s&&c.goal&&s.configGoal!==c.goal){if(s.configGoal!==undefined||s.goal!==c.goal)console.log(JSON.stringify({time:new Date().toISOString(),type:'goal_updated',agent:c.id}));   /* the logger's hooks are not set up yet here */s.goal=c.goal;s.configGoal=c.goal;}}
// One-time: the builder's old goal ("ask the player what to build, agree on size and materials") had turned into a
// habit of waiting for sign-offs. Reset that drift: core personality, no pending "waiting for approval" thread.
if(memory.data.builderAutonomyV1!=='v2'&&memory.data.agents.builder){const s=memory.data.agents.builder,c=configs.find(x=>x.id==='builder');
  memory.data.builderAutonomyV1='v2';s.personality=c?.personality??s.personality;s.mood='eager to build';
  for(const p of Object.values(s.talk?.players??{}))if(/ratif|sign-?off|approv|size|material|dimension/i.test(p.followUp??''))p.followUp=null;
  if(s.relationships)for(const [k,v] of Object.entries(s.relationships))if(/approv|sign-?off|ratif/i.test(v))s.relationships[k]='Feels warmly toward them and is glad to build what the town decides for them.';
  s.episodes=(s.episodes??[]).filter(e=>!/ratif|sign-?off/i.test(JSON.stringify(e)));log('builder_reset',{});}
memory.data.charter??={rules:[],proposals:[],next:1};
memory.data.proposal_history??=[];
if(!memory.data.charter.dedupV1){
  // Of each group of near-identical rules keep the newest wording (the latest annexation, the latest guidelines).
  const kept=[];for(const r of [...memory.data.charter.rules].reverse())if(!kept.some(k=>similarity(k.text,r.text)>=0.5))kept.unshift(r);
  const dropped=memory.data.charter.rules.length-kept.length;memory.data.charter.rules=kept;
  const before=memory.data.charter.proposals.length;
  memory.data.charter.proposals=memory.data.charter.proposals.filter(p=>!kept.some(k=>similarity(k.text,p.text)>=0.5));
  memory.data.charter.dedupV1=true;memory.save?.().catch?.(()=>{});
  console.log(JSON.stringify({time:new Date().toISOString(),type:'charter_deduplicated',rulesDropped:dropped,proposalsClosed:before-memory.data.charter.proposals.length}));
}
memory.data.ledger??=[];
// Homes on the village street; the builder builds them one by one during the day.
const {value:village,warning:villageWarning}=await loadOptionalJson(process.env.VILLAGE_FILE||'config/village.json',{homes:{}});
if(villageWarning)log('config_warning',{message:villageWarning});
memory.data.village??={built:{},attempts:{}};
// Every citizen gets a house lot: the newer ones continue the village street south (skills/property.mjs NEW_LOTS).
{const v=memory.data.village;v.extraHomes={...(v.extraHomes??{})};
  if(!v.clerkBedV1){v.clerkBedV1=true;const st=memory.data.agents?.clerk;if(st?.bed?.y>=70)st.bed=null;}
  // One-time: Jasper's west doorway faced a dirt bank by the farm; his door was moved to the north wall (2026-10-05).
  if(!v.clerkDoorV1){v.clerkDoorV1=true;if(v.extraHomes.clerk)v.extraHomes.clerk.door='north';}
 Object.assign(v.extraHomes,assignLots({...village.homes,...v.extraHomes},configs.filter(c=>c.role!=='visitor'&&!village.homes?.[c.id]&&!v.extraHomes[c.id]).map(c=>c.id)));
  village.homes={...village.homes,...v.extraHomes};}
// Given names ("Wren") work as well as ids ("scout") when talking to agents or in /sid commands.
const aliases=()=>Object.fromEntries(configs.filter(c=>c.name).flatMap(c=>[c.name.split(' ')[0],c.nickname,...(c.aliases??[])].filter(Boolean).map(a=>[a.toLowerCase(),c.id])));
const homeOf=id=>{const lot=village.homes?.[id];return lot?{...lot,cx:lot.x+2.5,cz:lot.z+2.5,spot:sleepSpot(lot)}:undefined;};
const homeBuilt=id=>!!memory.data.village.built[id];
// Conversation transcript for the dashboard: bot-to-bot messages, chat, replies, speeches.
memory.data.conversations??=[];
function conversation(entry){memory.data.conversations.push({time:Date.now(),...entry,text:String(entry.text).slice(0,300)});if(memory.data.conversations.length>300)memory.data.conversations.splice(0,memory.data.conversations.length-300);}
function ledger(by,text){life?.news(by,text);memory.data.ledger.push({time:Date.now(),by,text:String(text).slice(0,240)});memory.data.ledger=memory.data.ledger.slice(-200);}
const validate=new Ajv().compile(JSON.parse(await readFile(new URL('../config/world.schema.json',import.meta.url),'utf8')));
const bridge=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,configs);
let civic=null,life=null,fisher=null,specialists=null,intel=null,priest=null,lumberjack=null,miner=null,chef=null,quests=null,justice=null,sheriff=null,judge=null,healthcare=null,restPolicy=null,clerk=null,bank=null,economy=null,banker=null,lifesim=null,construction=null;   // created once the helpers below exist; events may arrive before that
const lm=new LLMRouter();
// Each server's state is logged once when it changes; failovers at most once a minute per task kind.
lm.onEndpoint=(name,online,info)=>log(online?'llm_endpoint_online':'llm_endpoint_offline',{endpoint:name,...(online?{awayMinutes:info.since?Math.round((Date.now()-info.since)/60000):0}:{why:info.why}),model:lm.status()[name].model});
lm.onFailover=f=>log('llm_failover',f);
lm.onModel=(endpoint,model,before,context)=>log('llm_model_selected',{endpoint,model,before,context});
lm.onDraft=(endpoint,what,info)=>log('llm_draft_model',{endpoint,what,...info});
lm.onTeam=(what,info)=>log('llm_teamwork',{what,...info});let lmReady=false,stopping=false,snapshot=null,received=0,events=[],chats=[];
// Offline mode: when the PC with LM Studio is off, the town keeps working without the model; thinking, talk,
// diaries and speeches wait. Time-bound tasks (speeches, greetings, chance meetings) are dropped on return.
const STALE_ON_RETURN=new Set(['meeting','council','festival','market','greet','away','campaign','dialogue']);
lm.onChange=(online,info)=>{
  if(!online){log('lm_offline',{why:info.why});return;}
  const away=Math.round((Date.now()-(info.since??Date.now()))/60000);
  for(const q of [life?.tasks,civic?.tasks])if(q){const keep=q.filter(t=>!STALE_ON_RETURN.has(t.kind));q.splice(0,q.length,...keep);}
  log('lm_online',{awayMinutes:away,queued:(life?.tasks.length??0)+(civic?.tasks.length??0)});
};
lm.startMonitor();
/** Short in-character answer while the model is unavailable, so players are not ignored. */
const OFFLINE_LINES={
  guardian:['{p}. On watch. Words later.','Not now, {p}. Eyes on the dark.'],
  scribe:['Forgive me, {p}, my quill is dry for the moment. Ask me again soon.'],
  merchant:['Ah, {p}! My head is full of numbers right now - come back in a while?'],
  herbalist:['Hush, {p}, I am lost in thought. Ask me again a little later, dear.'],
  default:['Sorry {p}, my head is in the clouds right now. Ask me again a little later?','Hm? Oh - {p}. Give me a while to gather my thoughts.','{p}, I can\'t think straight just now. Later, I promise.']};
async function offlineReply(config,state,request){
  const lines=OFFLINE_LINES[config.role]??OFFLINE_LINES.default,text=lines[Math.floor(Math.random()*lines.length)].replace('{p}',request.from);
  await say(config.id,text).catch(()=>{});
  conversation({from:config.id,to:request.from,kind:'reply',text,heard:request.text,offline:true});intel?.archive.agentSaidTo(config.id,request.from,text);
  // Keep what the player said: the bot reflects on it once it can think again.
  life?.noteExchange(config.id,request.from,request.text,'(was lost in thought and could not answer)');
}
// Player movement arrives every block step; track the latest position per player instead of
// letting it flood the event window. PLAYER_NAMES maps "uuid=name,..." so agents know who is who.
const names=new Map((process.env.PLAYER_NAMES||'').split(',').filter(Boolean).map(p=>p.split('=').map(v=>v.trim())));
const players=new Map();
let snapshotWaiter=null;
const seen=(uuid,position)=>{const p=players.get(uuid)??{};players.set(uuid,{...p,...position,time:Date.now()});};
bridge.on('log',message=>log('bridge',{message}));
bridge.on('ready',()=>log('bridge_ready'));
bridge.on('offline',info=>{snapshot=null;log('bridge_offline',info??{});});
bridge.on('message',m=>{
  if(m.type==='snapshot'&&validate(m)){snapshot=m;received=Date.now();snapshotWaiter?.();}
  if(m.type!=='event')return;
  const data=m.data??{};
  if(m.event==='movement'&&data.player){seen(data.player,data.position);return;}
  if(m.event==='chat'){
    if(data.player)seen(data.player,{});
    const from=data.agent??names.get(data.player)??data.player;
    // Where it was said, so only those within earshot hear it.
    const at=data.agent?snapshot?.agents?.find(a=>a.id===data.agent):[...players.entries()].find(([uuid])=>uuid===data.player||names.get(uuid)===from)?.[1];
    chats.push({time:m.time,from,text:data.text,...(Number.isFinite(at?.x)?{x:at.x,z:at.z}:{})});chats=chats.slice(-40);
    try{chef?.onChat(data.agent??from,data.text);}catch(e){log('chef_error',{where:'chat',message:e.message});}
    if(data.player)conversation({from,kind:'player',text:data.text});
    if(data.player)try{civic?.onPlayerChat(from,data.text);}catch(error){log('civic_error',{where:'chat',message:error.message});}
    if(data.player){const heardBy=queueReplies(from,data.player,data.text);if(heardBy.length||intel?.archive.hasOpen(from))intel?.archive.playerSaid(from,data.text);life?.onPlayerChat(from,data.text);}
  }
  if(m.event==='bank')return;   // vault moves: the runtime's bank logs its own (bank_deposit, payroll, ...)
  if(m.event==='command'){handleCommand(data).catch(error=>log('command_error',{message:error.message}));return;}
  if(m.event==='player'){life?.onPlayer(data).catch(error=>log('life_error',{where:'player',message:error.message}));return;}
  if(m.event==='vandalism'){log('vandalism',data);life?.onVandalism(data);return;}
  if(m.event==='damage'){try{civic?.onDamage(data);}catch(e){log('civic_error',{where:'damage',message:e.message});}return;}
  // A player breaking ground: the terrain sweep leaves that spot alone for a day (skills/terrain.mjs).
  if(m.event==='block'&&data.kind==='break'&&data.player&&data.block)try{civic?.notePlayerEdit(data.block.x,data.block.z);}catch{}
  if(m.event==='block'){try{intel?.onBlock(data);}catch(e){log('intel_error',{where:'block',message:e.message});}try{lumberjack?.onBlock(data);}catch(e){log('lumber_error',{where:'block',message:e.message});}}
  if(m.event==='entity'&&data.kind==='bred')life?.onBred(data).catch(()=>{});
  if(m.event==='trade'){
    try{intel?.onTrade(data);}catch(e){log('intel_error',{where:'trade',message:e.message});}
    life?.onTrade(data);
    civic?.onTrade(data);
    log('trade',data);
    const list=o=>Object.entries(o??{}).map(([k,v])=>`${v} ${k}`).join(', ')||'nothing';
    ledger(data.agent,data.kind==='received'?`received ${data.count} ${data.item} from ${data.from}${data.equipped?' (equipped)':''}`
      :data.kind==='traded'?`traded with ${data.player}: got ${list(data.received)} for ${list(data.gave)}`
      :`gave ${data.count} ${data.item} to ${data.to}`);
  }
  events.push(m);events=events.slice(-50);
});
bridge.start();
// Exit promptly (after saving) instead of waiting for an in-flight model call: the plugin removes
// NPCs whose session stays disconnected for 60 s, so a slow shutdown would reset their positions.
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{stopping=true;bridge.stop();await memory.flush().catch(()=>{});try{intel?.close();}catch{}log('stopped');process.exit(0);});
// Optional "x,z,radius" matching the plugin's spawn and roam-radius, so plans stay inside the area.
const area=(process.env.ROAM_AREA||'').split(',').map(Number);
const home=area.length===3&&area.every(Number.isFinite)?{x:area[0],z:area[1],radius:area[2]}:undefined;
const MIN_MOVE=Number(process.env.MIN_MOVE_BLOCKS||6);
const EVOLVE_EVERY=Number(process.env.EVOLVE_EVERY_TURNS||15);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fresh=()=>bridge.ready&&snapshot&&Date.now()-received<=5000;
const selfOf=id=>fresh()?snapshot.agents.find(a=>a.id===id):undefined;
const playerByName=name=>{for(const [uuid,p] of players)if((names.get(uuid)??uuid)===name&&p.x!==undefined&&Date.now()-p.time<60000)return p;};

// One bridge action at a time per agent: the plugin allows one action per 250 ms per agent, and the
// model loop and the background worker both act for the same NPC.
const locks=new Map();
async function exclusive(id,fn){
  const previous=locks.get(id)??Promise.resolve();let release;
  const current=new Promise(r=>release=r);locks.set(id,previous.then(()=>current));
  await previous;
  try{return await fn();}finally{await pause(300);release();}
}
// Every action's outcome and duration feed the motivation engine's forward model (curiosity from surprise).
// Who is steering each citizen (navlease.mjs): the job that last sent it walking holds a lease until it arrives,
// stalls or 60 s pass; a different, lower-priority job (or a model turn) cannot send it elsewhere meanwhile.
const jobCtx=new AsyncLocalStorage(),navLeases=new Map(),navBlocked=new Map();
// Walk tracing (temporary diagnostics for doorway spinning): every walk request, at most one per citizen per 10 s.
const walkTrace=new Map();
const act=(id,action)=>{
  if(['move','pathfind','travel'].includes(action?.type)&&Date.now()-(walkTrace.get(id)??0)>10000){walkTrace.set(id,Date.now());const me=selfOf(id),ctx=jobCtx.getStore();
    log('walk_trace',{agent:id,walk:action.type,to:[action.x,action.y,action.z].map(v=>Math.round(v*10)/10),from:me?[Math.round(me.x*10)/10,Math.round(me.y),Math.round(me.z*10)/10]:null,job:ctx?.job??null});}
  try{navGuard(id,action,{ctx:jobCtx.getStore(),leases:navLeases,blocked:navBlocked,self:selfOf(id)});}
  catch(error){
    // "Wait until you arrive" is exactly what a wait does while a job walks the citizen: let it, without stopping the walk.
    if(action.type==='wait'&&/^Busy/.test(error.message))return Promise.resolve('waiting while walking');
    return Promise.reject(error);}
  return actNow(id,action);
};
const actNow=(id,action)=>exclusive(id,async()=>{
  const t0=Date.now();
  try{const r=(await bridge.action(id,action)).result;intel?.motivation?.observeOutcome(id,action,true,Date.now()-t0);return r;}
  catch(error){intel?.motivation?.observeOutcome(id,action,false,Date.now()-t0);throw error;}
});
const say=(id,text)=>{conversation({from:id,kind:'chat',text});return act(id,{type:'chat',x:0,y:0,z:0,text:text.slice(0,240)}).catch(e=>log('chat_error',{agent:id,message:e.message}));};

// Long moves (e.g. heading toward a distant player) become a 20-block step in the same direction.
function clampMove(action,self){
  if(!['move','pathfind'].includes(action.type))return action;
  const dx=action.x-self.x,dz=action.z-self.z,flat=Math.hypot(dx,dz);
  if(flat<=20)return action;
  // The stopover 20 blocks along the straight line - but never inside a house or a town building (the line from the
  // tavern to the warehouse ran through a house: the chef pathed in at its door and jammed there). Shorter or longer
  // stops along the same line are tried; the target building itself is fine.
  const dest={x:action.x,z:action.z},home=insideBuilding(dest);
  for(const reach of [20,17,14,23,11,26,8]){
    if(reach>=flat)break;
    const k=reach/flat,x=Math.round((self.x+dx*k)*2)/2,z=Math.round((self.z+dz*k)*2)/2,b=insideBuilding({x,z});
    if(b&&b!==home)continue;
    return {...action,x,z,y:Math.round(self.y+(action.y-self.y)*k)};
  }
  const k=20/flat;
  return {...action,x:Math.round((self.x+dx*k)*2)/2,z:Math.round((self.z+dz*k)*2)/2,y:Math.round(self.y+(action.y-self.y)*k)};
}
/** Which building (a home lot, one cell of margin, or a town site) a point is in, or null. */
function insideBuilding(p){
  for(const [id,lot] of Object.entries(village.homes??{}))if(homeBuilt(id)&&p.x>=lot.x-1&&p.x<lot.x+6&&p.z>=lot.z-1&&p.z<lot.z+6)return 'home:'+id;
  return civic?.floorAt?.(p.x,p.z)!=null?'site:'+Math.round(p.x)+','+Math.round(p.z):null;
}
// Models guess heights; when the plugin reports the spot solid, try standing 1-3 blocks higher.
async function walk(id,action){
  for(let lift=0;;lift++){
    const attempt={...action,type:action.type==='move'?'move':'pathfind',y:action.y+lift};
    try{return {ack:await act(id,attempt),action:attempt};}
    catch(error){if(error.message!=='Destination obstructed'||lift>=3)throw error;}
  }
}
async function placeAll(id,blocks,{free=false}={}){
  const results=[];
  for(const block of blocks){
    // Site preparation: CLEAR removes natural ground (the plugin refuses anything built).
    try{if(block.clear){const point={x:block.x,y:block.y,z:block.z};if(block.demolish)await act(id,{type:'break',...point}).catch(()=>act(id,{type:'clear',...point}));else await act(id,{type:'clear',...point,...(block.expected?{expected:block.expected}:{})});}
      else await act(id,{type:'place',x:block.x,y:block.y,z:block.z,target:block.block,...(block.facing?{facing:block.facing}:{}),...(block.reclaim?{reclaim:true}:{}),...(free?{free:true}:{})});results.push({block,ok:true});}
    catch(error){results.push({block,ok:false,error:error.message});if(!bridge.ready)break;}
  }
  return results;
}
const JAIL_OK=new Set(['chat','tell','wait','vote','record','eat','turn_in_quest','get_balance']);
/** At the bank: by the counter (or the warehouse door until the bank stands) or next to the Banker. */
function atBank(id){const me=selfOf(id),counter=civic.bankCounter(),b=snapshot?.agents.find(a=>configs.find(c=>c.id===a.id)?.role==='banker');
  return !!me&&(Math.hypot(me.x-counter.x,me.z-counter.z)<=6||(!!b&&Math.hypot(me.x-b.x,me.z-b.z)<=6));}
async function dispatch(id,action,state){
  if(justice?.restricted(id)&&!JAIL_OK.has(action.type))throw Error(justice.jailed(id)?`You are in jail (${justice.jailed(id).reason}); you can only talk, eat, vote or wait until you are released or pardoned`:'The sheriff is taking you to jail; you can only talk');
  switch(action.type){
    case 'build':{
      const results=await placeAll(id,action.blocks);const placed=results.filter(r=>r.ok).length;
      if(!placed)throw Error(`Nothing placed: ${results.slice(0,3).map(r=>r.error).join('; ')}`);
      return {ack:{placed,failed:results.filter(r=>!r.ok).slice(0,4).map(r=>`${r.block.block}@${r.block.x},${r.block.y},${r.block.z}: ${r.error}`)},action};
    }
    case 'blueprint':{
      const gate=constructionGate(id,String(action.spec.shape).toLowerCase(),state,memory.data.town??{});if(gate)throw Error(gate);
      if(String(action.spec.shape).toLowerCase()==='cancel'){
        const name=state.project?.name;state.project=null;return {ack:name?`cancelled ${name}`:'no project to cancel',action};
      }
      if(state.project||state.dig)throw Error(`Already working on ${(state.project??state.dig).name}; cancel it first`);
      if(action.spec.ground!==false&&!['roof','pillar'].includes(String(action.spec.shape).toLowerCase())){
        // Sit the build on the real terrain: the most common ground height in the footprint.
        const shape=String(action.spec.shape).toLowerCase();
        const w=Math.min(16,Math.max(1,Math.round(Number(shape==='path'?Math.abs((action.spec.x2??action.x)-action.x)+1:action.spec.width)||5)));
        const d=Math.min(16,Math.max(1,Math.round(Number(shape==='path'?Math.abs((action.spec.z2??action.z)-action.z)+1:action.spec.depth??action.spec.width)||5)));
        const survey=await act(id,{type:'survey',x:Math.min(action.x,action.spec.x2??action.x),y:0,z:Math.min(action.z,action.spec.z2??action.z),width:w,depth:d}).catch(()=>null);
        const heights=(survey?.heights??[]).filter(h=>h!==null);
        if(heights.length){
          const counts=new Map();heights.forEach(h=>counts.set(h,(counts.get(h)??0)+1));
          const ground=[...counts].sort((a,b)=>b[1]-a[1])[0][0];
          action={...action,y:shape==='path'?ground:ground+1};
        }
      }
      const blocks=blueprint(action.spec,action.x,action.y,action.z);
      const allowed=new Set(bridge.info?.materials??[]);
      const invalid=[...new Set(blocks.map(b=>b.block))].filter(m=>!allowed.has(m));
      if(invalid.length)throw Error(`Not in buildMaterials: ${invalid.join(', ')}`);
      // The world is the citizens' to build in; LIMIT_TO_HOME=true restores the old home-area limit.
      if(home&&process.env.LIMIT_TO_HOME==='true'&&blocks.some(b=>Math.hypot(b.x+0.5-home.x,b.z+0.5-home.z)>home.radius))throw Error('Blueprint extends outside the home area; move it closer to home');
      const name=`${action.spec.shape} at ${Math.floor(action.x)},${Math.floor(action.y)},${Math.floor(action.z)}`;
      state.project={...newProject(name,blocks),baseY:Math.floor(action.y),blueprint:{spec:structuredClone(action.spec),x:action.x,y:action.y,z:action.z}};
      if(id==='builder'&&!['floor','roof','pillar','path','walls'].includes(String(action.spec.shape).toLowerCase()))await civic.prepareProject(configs.find(c=>c.id===id),state);
      if(id==='builder'){const registry=memory.data.town.constructionRegistry??={};const key=`${action.x},${action.y},${action.z}:${action.spec.shape}`;state.project.registryKey=key;registry[key]={name,blueprint:state.project.blueprint,expected:blocks,started:Date.now(),status:'building'};await memory.flush();}
      log('project_started',{agent:id,name,blocks:blocks.length});ledger(id,`started building ${name} (${blocks.length} blocks)`);
      return {ack:{project:name,blocks:blocks.length},action};
    }
    case 'place':return {ack:await act(id,{...action,target:action.target.toUpperCase()}),action};
    case 'mine':case 'breed':case 'craft':case 'smelt':case 'appraise':return {ack:await act(id,{...action,target:action.target.toUpperCase()}),action};
    case 'dig':{
      if(String(action.spec.shape).toLowerCase()==='cancel'){const name=state.dig?.name;state.dig=null;return {ack:name?`cancelled ${name}`:'no dig to cancel',action};}
      if(state.dig||state.project)throw Error('Already working on a project; cancel it first');
      const steps=digPlan(action.spec,action.x,action.y,action.z);
      const name=`${action.spec.shape} ${action.spec.direction} from ${Math.floor(action.x)},${Math.floor(action.y)},${Math.floor(action.z)}`;
      state.dig=newDig(name,steps,{x:Math.floor(action.x)+0.5,y:Math.floor(action.y),z:Math.floor(action.z)+0.5});
      await act(id,{type:'equip',x:0,y:0,z:0,target:'IRON_PICKAXE'}).catch(()=>{});
      log('dig_started',{agent:id,name});ledger(id,`started digging ${name}`);
      return {ack:{dig:name,steps:steps.length},action};
    }
    case 'farm':{
      if(String(action.spec.crop).toLowerCase()==='cancel'){const had=!!state.farm;state.farm=null;return {ack:had?'stopped farming':'no farm to stop',action};}
      if(state.farm&&Math.hypot(state.farm.x-(Math.floor(action.x)+0.5),state.farm.z-(Math.floor(action.z)+0.5))<3)return {ack:'already tending this plot',action};
      const size=v=>Math.max(1,Math.min(10,Math.round(Number(v))||6));
      state.farm={x:Math.floor(action.x)+0.5,z:Math.floor(action.z)+0.5,width:size(action.spec.width),depth:size(action.spec.depth),crop:String(action.spec.crop||'WHEAT_SEEDS').toUpperCase(),last:0};
      ledger(id,`started a ${state.farm.width}x${state.farm.depth} ${state.farm.crop} farm at ${Math.floor(action.x)},${Math.floor(action.z)}`);
      return {ack:{farm:state.farm},action};
    }
    case 'propose':{
      const charter=memory.data.charter;
      if(charter.proposals.some(p=>p.by===id))throw Error('You already have an open proposal; wait for the vote');
      if(charter.proposals.length>=3)throw Error('Three proposals are already open; vote on those first');
      const dup=duplicateOf(action.text,{open:charter.proposals,rules:charter.rules,history:memory.data.proposal_history??[]});
      if(dup)throw Error(`That repeats ${dup.kind==='rule'?'rule':dup.kind==='open'?'open proposal':`the ${dup.kind} proposal`} #${dup.id} ("${String(dup.text).slice(0,60)}..."). Propose something the town has not decided yet, or nothing.`);
      const proposal={id:String(charter.next++),by:id,text:action.text,votes:{[id]:'yes'},time:Date.now()};
      charter.proposals.push(proposal);ledger(id,`proposed #${proposal.id}: ${action.text}`);resolveProposals();
      return {ack:{proposal:proposal.id},action};
    }
    case 'vote':{
      const proposal=memory.data.charter.proposals.find(p=>p.id===String(action.target).replace('#',''));
      if(!proposal)throw Error('No open proposal with that id');
      proposal.votes[id]=action.text.trim().toLowerCase();resolveProposals();
      return {ack:{proposal:proposal.id,vote:proposal.votes[id]},action};
    }
    case 'record':ledger(id,action.text);return {ack:'recorded',action};
    case 'quest':{const o=await civic.postQuest(id,action.target.toUpperCase(),action.count||8,action.text);return {ack:o?`work order #${o.number} posted`:'the order board is full',action};}
    case 'claim_quest':{
      const o=intel.board.get(String(action.target).replace('#',''));if(!o)throw Error(`No quest #${action.target}`);
      let plan=null;
      if(['RESOURCE_REQUEST','CRAFT_ITEM'].includes(o.order_type)&&o.status==='OPEN'){
        const roleOfId=x=>configs.find(c=>c.id===x)?.role??x;
        plan=fulfilmentPlan(o,{...selfOf(id),id,role:roleOfId(id)},{stock:civic.stockItems(),agents:(snapshot?.agents??[]).map(a=>({...a,role:roleOfId(a.id)}))});
        if(!plan)throw Error(`You cannot fill quest #${o.number} now: you have no spare ${String(o.target_item).toLowerCase().replace(/_/g,' ')} and cannot make it`);
      }
      const k=quests.claim(id,o.number);
      if(plan)state.contract={order_id:k.order_id,plan,phase:'acquire',since:Date.now()};
      ledger(id,`took quest #${k.number}: ${quests.describe(k)}`);
      return {ack:`claimed: ${quests.describe(k)}`,action};
    }
    case 'progress_quest':{
      const o=intel.board.get(String(action.target).replace('#',''));if(!o||o.contractor_name!==id)throw Error(`Quest #${action.target} is not yours`);
      // Items count when they are handed over (the delivery runs on its own); work quests count as the work is done.
      if(['RESOURCE_REQUEST','CRAFT_ITEM'].includes(o.order_type)&&state.contract?.order_id===o.order_id){const have=selfOf(id)?.inventory?.[state.contract.plan.item??o.target_item]??0;if(have>0)state.contract.phase='deliver';}
      return {ack:`quest #${o.number}: ${o.delivered}/${o.quantity} done${state.contract?.phase==='deliver'?', delivering now':''}`,action};
    }
    case 'turn_in_quest':{const r=await quests.turnIn(id,action.target);return {ack:`quest #${r.number} turned in${r.paid?` - ${r.reward_emeralds} emeralds paid`:''}`,action};}
    case 'deposit_emeralds':case 'withdraw_emeralds':{
      if(!atBank(id)){const c=civic.bankCounter();throw Error(`Go to the bank counter first (${Math.floor(c.x)},${Math.floor(c.z)}) or stand by the Banker`);}
      const n=action.count||1;
      const r=action.type==='deposit_emeralds'?await bank.deposit(id,n,{memo:action.text||'deposit at the counter'}):await bank.withdraw(id,n,{requester:id,memo:action.text||'withdrawal at the counter'});
      ledger(id,`${action.type==='deposit_emeralds'?'deposited':'withdrew'} ${n} emeralds at the bank (balance ${r.balance})`);
      return {ack:{[action.type==='deposit_emeralds'?'deposited':'withdrew']:n,balance:r.balance,txn:r.txn},action};
    }
    case 'get_balance':{const b=bank.balance(id),owed=economy.view().owed[id]??0;return {ack:{balance:b.balance,payOwed:owed,recent:b.history.slice(0,5).map(t=>`${t.type} ${t.amount} ${t.memo}`)},action};}
    case 'stash':case 'take_from_chest':return {ack:await lifesim.chestAction(id,action,selfOf(id)),action};
    case 'complain':{
      if(Date.now()-(state.lastComplaint??0)<1800000)throw Error('You filed a complaint recently; let the sheriff look into it first');
      const k=justice.complain(id,action.to,action.text);state.lastComplaint=Date.now();
      return {ack:`complaint filed as ${k.conflict_id}; the sheriff will investigate`,action};
    }
    case 'pardon':{
      if(civic.governorOf()?.id!==id)throw Error('Only the governor (as magistrate) or the mayor can pardon');
      await justice.pardonCitizen(action.to,id);return {ack:`pardoned ${action.to}`,action};
    }
    case 'goal':{const g=intel.goals.create(id,action.text,{source:'self'});return {ack:`goal set: ${g.title}; planning the milestones`,action};}
    case 'preach':case 'attempt_conversion':case 'practice_hobby':case 'cultural_festival':return {ack:await priest.action(id,action,selfOf(id)),action};
    case 'zone':{
      const charter=memory.data.charter;
      if(charter.proposals.some(p=>p.by===id))throw Error('You already have an open proposal; wait for the vote');
      const {zone,text}=civic.proposeZone(id,action,charter);
      const proposal={id:String(charter.next++),by:id,text,zone:zone.id,votes:{[id]:'yes'},time:Date.now()};
      charter.proposals.push(proposal);ledger(id,`proposed #${proposal.id}: ${text}`);resolveProposals();
      return {ack:{proposal:proposal.id,zone:zone.id},action};
    }
    case 'mediate':return {ack:await civic.mediate(id,action),action};
    case 'eat':{
      const carried=selfOf(id)?.inventory??{};
      if(!action.target||!carried[String(action.target).toUpperCase()])action={...action,target:Object.keys(FOOD_POINTS).find(f=>(carried[f]??0)>0)??action.target};
      if(!action.target)throw Error('You have no food with you; get some from the warehouse or a friend');
      const r=await act(id,{...action,target:action.target.toUpperCase()});if(state.needs)state.needs.hunger=Math.min(20,state.needs.hunger+(FOOD_POINTS[String(action.target).toUpperCase()]??r.value??2));return {ack:r,action};}
    case 'deposit':case 'withdraw':return {ack:await civic.warehouseAction(id,action,selfOf(id)),action};
    case 'give':case 'equip':return {ack:await act(id,{...action,target:action.target.toUpperCase()}),action};
    case 'move':case 'pathfind':return walk(id,action);
    default:return {ack:await act(id,action),action};
  }
}
function resolveProposals(){
  const charter=memory.data.charter,majority=Math.floor(configs.length/2)+1;
  for(const p of [...charter.proposals]){
    const votes=Object.values(p.votes),yes=votes.filter(v=>v==='yes').length,no=votes.length-yes;
    if(p.generated&&!p.playerVote&&Date.now()<(p.closesAt??0))continue;
    const expired=p.generated?Date.now()>=(p.closesAt??0):Date.now()-p.time>30*60000;
    // A player's vote decides: yes adopts, no (or veto) rejects.
    if(p.playerVote){const adopted=p.playerVote.vote==='yes';p.decidedBy=p.playerVote.player;
      if(adopted&&!p.generated){charter.rules.push({id:p.id,text:p.text,by:p.by,time:Date.now()});charter.rules=charter.rules.slice(-20);}
      ledger('governor',`proposal #${p.id} ${adopted?'adopted':'rejected'} by ${p.playerVote.player}${p.playerVote.veto?' (veto)':''}: ${p.text}`);
      civic.onProposalResolved(p,adopted);if(adopted)life?.onProposalAdopted(p);charter.proposals.splice(charter.proposals.indexOf(p),1);continue;}
    if(p.requiresPlayer)continue;   // e.g. annexing land: only the mayor decides
    if(yes>=majority||expired&&yes>no){if(!p.generated){charter.rules.push({id:p.id,text:p.text,by:p.by,time:Date.now()});charter.rules=charter.rules.slice(-20);}ledger('governor',`rule #${p.id} adopted (${yes}-${no}): ${p.text}`);log('rule_adopted',{id:p.id,text:p.text});civic.onProposalResolved(p,true);}
    else if(no>=majority||expired){ledger('governor',`proposal #${p.id} rejected (${yes}-${no}): ${p.text}`);log('proposal_rejected',{id:p.id});civic.onProposalResolved(p,false);}
    else continue;
    charter.proposals.splice(charter.proposals.indexOf(p),1);
  }
}
function evaluate(last,self){
  if(!last)return null;
  if(['move','pathfind'].includes(last.action.type)){
    const remaining=Math.hypot(self.x-last.action.x,self.y-last.action.y,self.z-last.action.z);
    return {action:last.action.type,remaining,arrived:remaining<2,progress:last.distance-remaining,pathing:self.pathing};
  }
  return {action:last.action.type,ack:last.ack,note:'Acknowledged execution; no claim of goal completion'};
}

// Replies jump the queue: a bot named in a player's chat line (or the only bot standing close to the
// player) answers on the next model turn with a quick dialogue call instead of a full plan.
const priority=[];
function queueReplies(from,uuid,text){
  const ids=configs.map(c=>c.id);
  let targets=mentionedAgents(text,ids,aliases());
  const p=players.get(uuid);
  if(!targets.length&&p?.x!==undefined&&snapshot){
    const near=snapshot.agents.filter(a=>Math.hypot(a.x-p.x,a.z-p.z)<=6).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z));
    if(near.length)targets=[near[0].id];
  }
  for(const id of targets.slice(0,3))if(!priority.some(q=>q.id===id))priority.push({id,from,text,time:Date.now()});
  return targets;
}
/**
 * Speech bound to confirmed state: a citizen with a project in progress (or parked) may not say it is finished, built
 * or complete - the line is replaced by what is actually true (construction.statusLine: progress or the blocker).
 */
function truthful(id,state,text){
  const p=state.project??(memory.data.town?.parkedProjects??[]).find(x=>x.builder===id)?.project;
  if(!p||p.verified||!text)return text;
  const name=String(p.name).toLowerCase().split(/\s+/).filter(w=>w.length>3);
  const claims=/\b(finished|complete[d]?|done|built)\b/i.test(text)&&(name.some(w=>text.toLowerCase().includes(w))||/\b(roof|house|building|walls?)\b/i.test(text));
  if(!claims)return text;
  log('speech_corrected',{agent:id,said:String(text).slice(0,160),project:p.name});
  return construction.statusLine(p)??text;
}
async function quickReply(config,state,request){
  const reply=await lm.speak({name:config.id,role:config.role,personality:state.personality??config.personality,mood:state.mood,relationships:state.relationships,
    goal:state.goal,doing:statusOf(config,state),timeOfDay:isNight(snapshot?.worldTime)?'night':'day',speaker:request.from,message:request.text,recentChat:chats.slice(-8),
    you:config.name??config.id,aboutSpeaker:life?.aboutPlayer(request.from),promises:state.promises,townNews:memory.data.town?.news?.slice(-3).map(n=>n.text),
    memory:{...life?.recallFor(config.id,request.from),...intel?.playerContext(config.id,request.from)},
    town:(({building,designs,buildQueue}={})=>({building,designs,buildQueue}))(civic.context(config,state).town),
    instruction:`Answer ${request.from} directly and helpfully, by name, in character. If they ask for something you can do, say you will. If they ask for a building, it goes to the town's building queue and the citizens decide its design - say so; never ask them for sizes or materials. ${life?.replyStyle(config)??''}`});
  const said=truthful(config.id,state,reply);
  minds.end(config.id,{said:String(said??'').slice(0,240),to:request.from});
  await say(config.id,said);
  memory.add(config.id,{time:Date.now(),reply:{to:request.from,heard:request.text,said:reply}});
  conversation({from:config.id,to:request.from,kind:'reply',text:reply,heard:request.text});
  life?.onReply(config.id,request.from,reply);life?.noteExchange(config.id,request.from,request.text,reply);intel?.archive.agentSaidTo(config.id,request.from,reply);
  log('reply',{agent:config.id,to:request.from,text:reply,waited:Math.round((Date.now()-request.time)/1000)});
}

// /sid commands from players, relayed by the plugin; they run immediately without the model.
const nearestTo=pos=>snapshot?.agents.slice().sort((a,b)=>Math.hypot(a.x-pos.x,a.z-pos.z)-Math.hypot(b.x-pos.x,b.z-pos.z))[0]?.id;
async function handleCommand(data){
  const verb=String(data.args?.[0]??'').toLowerCase();
  if(fisher.commands.includes(verb)&&await fisher.command(data,data.args))return;
  if(specialists.commands.includes(verb)&&await specialists.command(data,data.args))return;
  if(priest.commands.includes(verb)){const who=nearestTo(data)??'priest';await priest.command(data,data.args,text=>act(who,{type:'whisper',x:0,y:0,z:0,to:data.player,text}).catch(()=>{}));return;}
  if(civic.commands.includes(verb)&&await civic.command(data,data.args))return;
  // /sid warehouse survey: find the warehouse's chests (after a player rebuilds it).
  if(verb==='warehouse'&&String(data.args[1]??'').toLowerCase()==='survey'){
    const s=await civic.surveyWarehouse((configs.find(c=>c.role==='clerk')??configs.find(c=>c.role==='banker'))?.id).catch(e=>({error:e.message}));
    log('warehouse_survey_cmd',{player:data.player,result:s.error??`${s.chests.length} chests`});
    // Tell the town where things are now (in short lines: chat holds 240 characters).
    const dir=civic.warehouseDirectory(),clerkId=(configs.find(c=>c.role==='clerk')??configs.find(c=>c.role==='banker'))?.id;
    if(dir&&clerkId){const lines=['Listen up, everyone: the warehouse chests are in the walls now.',...dir.split('; ').reduce((acc,p)=>{const l=acc.at(-1);if(l&&l.length+p.length<220)acc[acc.length-1]=l+'; '+p;else acc.push(p);return acc;},[]),'The old floor chests are being emptied - put nothing in them.'];
      for(const l of lines)await say(clerkId,l).catch(()=>{});ledger(clerkId,`set up the warehouse wall chests: ${dir}`);}
    return;
  }
  if(['bank','treasury'].includes(verb)){
    const near=nearestTo(data)??configs[0].id,tell=text=>act(near,{type:'whisper',x:0,y:0,z:0,to:data.player,text:String(text).slice(0,240)}).catch(()=>{});
    if(verb==='bank'&&['cashout','withdraw'].includes(String(data.args[1]??'').toLowerCase())){
      const acct=bank.balance(data.player),want=Math.min(64,Number(data.args[2])||acct.balance);
      if(acct.balance<1){await tell('Your town bank account is empty.');return;}
      const banker=configs.find(c=>c.role==='banker'),b=banker&&snapshot?.agents.find(a=>a.id===banker.id);
      if(!b||!Number.isFinite(data.x)||Math.hypot(b.x-data.x,b.z-data.z)>4){await tell(`Come within 4 blocks of Finneas the Vault Keeper to collect your ${acct.balance} emeralds${b?` (he is at ${Math.round(b.x)}, ${Math.round(b.z)})`:''}.`);return;}
      try{const r=await bank.cashOut(data.player,want,{agent:banker.id,handOver:n=>act(banker.id,{type:'give',x:0,y:0,z:0,target:'EMERALD',count:n,to:data.player})});
        await say(banker.id,`Here you are, ${data.player}: ${want} emeralds. ${r.balance} left in your account.`).catch(()=>{});}
      catch(error){await tell(error.message);}
      return;
    }
    if(verb==='treasury'){const v=bank.state.municipal_vault,a=bank.state.lastAudit;await tell(`Tax reserves ${v.total_tax_reserves}, treasury ${memory.data.town?.stock?.items?.EMERALD??0}, accounts ${bank.liabilities()-v.total_tax_reserves}. Income tax ${Math.round(bank.state.tax_config.income_tax_rate*100)}%, sales tax ${Math.round(bank.state.tax_config.sales_tax_rate*100)}%.${a?` Last audit: vault ${a.vault}, ${a.ok?'balanced':`off by ${a.diff}`}.`:''}`);return;}
    const w=String(data.args[1]??'').toLowerCase(),who=configs.find(c=>c.id===w)?.id??aliases()[w];
    if(!who){const top=Object.entries(bank.state.accounts).sort((a,b)=>b[1].balance-a[1].balance).slice(0,6);await tell(top.length?top.map(([k,a])=>`${intel.nameOf(k)} ${a.balance}`).join(', '):'No accounts yet.');return;}
    const b=bank.balance(who);await tell(`${intel.nameOf(who)}: ${b.balance} emeralds. ${b.history.slice(0,3).map(t=>`${t.type} ${t.amount} (${t.memo})`).join('; ')}`);return;
  }
  if(['pardon','court','jail'].includes(verb)){
    const near=nearestTo(data)??configs[0].id,tell=text=>act(near,{type:'whisper',x:0,y:0,z:0,to:data.player,text:String(text).slice(0,240)}).catch(()=>{});
    const v=justice.view();
    if(verb==='court'){const open=v.conflicts.filter(c=>c.status!=='RESOLVED').slice(0,4);await tell(open.length?open.map(c=>`${c.conflict_id} ${c.status} ${c.party_a} v ${c.party_b}: ${c.reason}${c.trial&&!c.trial.held?` (trial ${c.trial.scheduled_at.slice(11,16)} UTC)`:''}`).join(' | '):'No open cases. The town is at peace.');return;}
    if(verb==='jail'){await tell(v.jail.length?v.jail.map(r=>`${r.name}: ${r.reason}, ${r.minutesLeft} min left`).join(' | '):`The jail is empty.${v.warrants.length?` Warrants: ${v.warrants.map(w=>w.name).join(', ')}`:''}`);return;}
    const w=String(data.args[1]??'').toLowerCase(),who=configs.find(c=>c.id===w)?.id??aliases()[w];
    if(!who){await tell('Use: /sid pardon <citizen>');return;}
    const mayor=memory.data.town?.mayor;if(mayor&&mayor!==data.player){await tell(`Only the mayor (${mayor}) can pardon.`);return;}
    try{await justice.pardonCitizen(who,data.player);await say(civic.governorOf()?.id??near,`By the mayor's pardon, ${configs.find(c=>c.id===who)?.name??who} is free to go.`).catch(()=>{});}
    catch(error){await tell(error.message);}
    return;
  }
  if(intel.commands.includes(verb)){
    const near=nearestTo(data)??configs[0].id;
    const tell=text=>act(near,{type:'whisper',x:0,y:0,z:0,to:data.player,text:String(text).slice(0,240)}).catch(()=>{});
    const agentFor=word=>{const w=String(word??'').toLowerCase();return configs.find(c=>c.id===w)?.id??aliases()[w];};
    if(await intel.command(data,data.args,tell,agentFor))return;
  }
  const ids=configs.map(c=>c.id),order=parseCommand(data.args??[],ids,aliases());
  log('command',{player:data.player,args:data.args,order});
  if(order.error){const id=nearestTo(data);if(id)await say(id,`${data.player}: ${order.error}`);return;}
  const reply={come:`Coming, ${data.player}!`,follow:`I'll follow you, ${data.player}.`,stay:'Staying right here.',free:'Back to my usual work.',home:'Heading home.'};
  if(order.kind==='endorse'){
    const id=nearestTo(data)??configs[0].id;
    try{const name=life.endorse(data.player,order.target);await say(configs.find(c=>c.role==='governor')?.id??id,`${data.player} endorses ${name} for governor!`);}
    catch(error){await act(id,{type:'whisper',x:0,y:0,z:0,to:data.player,text:error.message}).catch(()=>{});}
    return;
  }
  if(order.kind==='quests'){
    const id=nearestTo(data)??configs[0].id;
    for(const line of civic.questsText().slice(0,6))await act(id,{type:'whisper',x:0,y:0,z:0,to:data.player,text:line}).catch(()=>{});
    return;
  }
  if(order.kind==='vote'){
    const p=memory.data.charter.proposals.find(x=>x.id===order.id),id=nearestTo(data)??configs[0].id;
    if(!p){await act(id,{type:'whisper',x:0,y:0,z:0,to:data.player,text:`There is no open proposal #${order.id}.`}).catch(()=>{});return;}
    p.playerVote={player:data.player,vote:order.vote,veto:!!order.veto};resolveProposals();
    const governor=configs.find(c=>c.role==='governor')?.id??id;
    await say(governor,`${data.player} has ${order.veto?'vetoed':order.vote==='yes'?'approved':'rejected'} proposal #${order.id}.`);
    return;
  }
  if(order.kind==='build'){
    const builder=configs.find(c=>c.role!=='guardian'&&c.id==='builder')??configs[0],state=memory.data.agents[builder.id];
    if(state.project){await say(builder.id,`I'm still building ${state.project.name}, ${data.player}. I'll do yours next if you ask again after.`);return;}
    const spot=frontOf(data,order.size);
    const spec=order.shape==='path'?{shape:'path',x2:spot.x2,z2:spot.z2,width:2,material:order.material??'GRAVEL'}
      :{shape:order.shape,width:order.size,depth:order.size,height:order.shape==='house'?4:3,material:order.material??(order.shape==='floor'?'STONE_BRICKS':'SPRUCE_PLANKS'),door:spot.door,bed:order.shape==='house'};
    const origin=order.shape==='path'?{x:Math.floor(data.x),z:Math.floor(data.z)}:spot;
    try{
      await dispatch(builder.id,{type:'blueprint',x:origin.x,y:Math.floor(data.y),z:origin.z,target:'',text:'',to:'',blocks:[],count:1,spec},state);
      state.order=null;
      await say(builder.id,`On it, ${data.player}! Building a ${order.shape==='path'?'path':`${order.size}x${order.size} ${order.shape}`} right there.`);
    }catch(error){await say(builder.id,`Sorry ${data.player}, I can't build that there: ${error.message}`);}
    return;
  }
  for(const id of order.targets){
    const state=memory.data.agents[id];if(!state)continue;
    if(state.order?.kind==='follow'&&order.kind!=='follow')act(id,{type:'unfollow',x:0,y:0,z:0}).catch(()=>{});
    state.order=order.kind==='free'?null:{kind:order.kind,player:data.player,since:Date.now()};
    if(order.kind==='home'&&!homeBuilt(id)){state.order=null;await say(id,"I don't have a home yet. The builder is working on it!");continue;}
    if(order.targets.length===1||id===order.targets[0])await say(id,reply[order.kind]);
  }
}

// Background worker: runs blueprint projects and guardian reflexes without waiting for the model.
const combat=new Map(),working=new Set();
// What each citizen is doing in the worker loop (for the dashboard and the stuck-job warning).
const jobInfo=new Map();
// ---------- construction (construction.mjs): blockers instead of skips, access planning, final inspection ----------
async function buildStep(config,state,self){
  // The citizen's standing intention while a project is under way: kept through meals and meetings.
  const p=state.project;
  if(p&&!state.intention?.project)state.intention={project:p.name,text:`Finish the ${p.name}${snapshot?.weather?.storm||snapshot?.weather?.rain?' before the rain gets worse':''}`,since:Date.now()};
  const r=await construction.step(config,state,self);
  if(!state.project)state.intention=null;
  return r;
}
async function guardStep(config,self){
  const player=config.protect?playerByName(config.protect):undefined;
  let step=guardianStep(self,player);
  const state=combat.get(config.id)??{lastThreat:0,lastMove:0,patrol:{}};combat.set(config.id,state);
  if(!step&&!player){
    // Nobody to escort: walk the town, past every post and door on the village street.
    // (Not Jasper's desk inside the warehouse: the guard used to march in and out through its door all day.)
    const waypoints=[...configs.filter(c=>Array.isArray(c.post)&&c.role!=='clerk').map(c=>({x:c.post[0]+0.5,z:c.post[1]+0.5})),{x:301.5,z:78.5},{x:301.5,z:112.5}];
    step=patrolStep(self,waypoints,state.patrol);
    if(step)step={...step,kind:'follow',y:self.y};
  }
  if(!step)return;
  if(step.kind==='attack'){
    state.lastThreat=Date.now();
    // The mob may have died or stepped away since the snapshot; just re-evaluate next tick.
    const result=await act(config.id,{type:'attack',x:0,y:0,z:0,target:step.target.uuid}).catch(error=>{if(/out-of-reach|not visible/.test(error.message))return null;throw error;});
    if(!result)return;
    log('guardian_attack',{agent:config.id,target:step.target.type,...result});
    if(result?.target_health===0){civic.onKill(config.id);ledger(config.id,`defeated a ${step.target.type.toLowerCase()} near ${config.protect??'town'}`);memory.add(config.id,{time:Date.now(),defeated:step.target.type});await say(config.id,`${step.target.type.toLowerCase().replace(/_/g,' ')} defeated. You're safe${config.protect?`, ${config.protect}`:''}!`);}
    return;
  }
  if(step.kind==='chase')state.lastThreat=Date.now();
  if(Date.now()-state.lastMove<1500||(step.kind==='follow'&&self.pathing))return;
  state.lastMove=Date.now();
  await walk(config.id,clampMove({type:'pathfind',x:step.x,y:Math.round(step.y),z:step.z},self)).catch(()=>{});
}
const DIG_HAZARD=/lava|water/i;
/** The medic between calls: at her place in the infirmary (the bench by the beds), where the wounded can find her. */
function clinicStep(config,self){
  const r=civic.infirmaryLayout?.();if(!r)return null;
  const p=[Math.floor(r.medic.x),Math.floor(r.medic.z)];if(config.post?.[0]!==p[0]||config.post?.[1]!==p[1])config.post=p;   // her idle stroll stays inside
  if(Math.hypot(self.x-r.medic.x,self.z-r.medic.z)<=2.5)return null;
  return ()=>self.pathing?null:life.travel(config.id,self,{x:r.medic.x,y:r.medic.y,z:r.medic.z}).catch(()=>{});
}
/** Up and out: one block at a time, the rock above dug for headroom, a block from the pack set under his feet. */
async function climbOut(config,self,to){
  const fx=Math.floor(self.x),fy=Math.floor(self.y),fz=Math.floor(self.z),rise=Math.min(12,Math.ceil(to.y-self.y));
  let up=0;
  for(let i=0;i<rise;i++){
    // Headroom (air already: nothing to do); water or lava above ends the climb - never up into the lake over the mine.
    const m=await act(config.id,{type:'mine',x:fx,y:fy+i+2,z:fz}).then(()=>null).catch(e=>e.message);
    if(/water|lava/i.test(m??'')){log('climb_out_stopped',{agent:config.id,why:m,up});break;}
    const r=await act(config.id,{type:'pillar',x:0,y:0,z:0,count:1}).catch(e=>({error:e.message}));
    if(!r?.climbed){if(r?.error||r?.block==='none')log('climb_out_stopped',{agent:config.id,why:r?.error??'no dirt or cobblestone in the pack',up});break;}
    up++;
  }
  if(up)log('climbed_out',{agent:config.id,from:{x:fx,y:fy,z:fz},up,toward:to});
}
async function digStep(config,state,self){
  // The plugin measures reach from the feet to the block corner; plan from a little closer so every block is in reach.
  const dig=state.dig,step=nextDigStep(dig,self,BUILD_REACH-3);
  const finish=async(text)=>{
    state.dig=null;const got=Object.entries(dig.drops).map(([k,v])=>`${v} ${k}`).join(', ')||'nothing';
    const summary=`${dig.name}: mined ${dig.mined} blocks, got ${got}`;
    memory.add(config.id,{time:Date.now(),project:summary});ledger(config.id,`${text} ${summary}`);log('dig_done',{agent:config.id,summary,text});miner?.onDigDone(config.id,dig,text);
    await memory.save();await say(config.id,`${text[0].toUpperCase()+text.slice(1)} ${summary}.`);
  };
  if(step.kind==='done')return finish('finished');
  if(dig.stalls>=12)return finish('had to stop');
  if(step.kind==='torch'){
    const s=step.step.stand;
    await act(config.id,{type:'place',x:Math.floor(s.x),y:s.y,z:Math.floor(s.z),target:'TORCH'}).catch(()=>{});
    step.step.torchPlaced=true;return;
  }
  if(step.kind==='mine'){
    const results=[];
    for(const block of step.blocks){
      try{results.push({block,ok:true,result:await act(config.id,{type:'mine',x:block.x,y:block.y,z:block.z})});}
      catch(error){
        // A block a citizen placed (his own cobblestone floor patch on the stairs, a torch): broken and taken, not mined.
        if(/built by an agent/i.test(error.message)){
          const r=await act(config.id,{type:'break',x:block.x,y:block.y,z:block.z}).then(r=>({ok:true,r})).catch(e=>({ok:false,e:e.message}));
          if(r.ok){results.push({block,ok:true,result:{drops:r.r?.drops??{}}});continue;}
        }
        results.push({block,ok:false,error:error.message});}
    }
    const outcome=recordDig(dig,results);civic.award(config.id,'mine',results.filter(r=>r.ok).length);
    const failed=results.filter(r=>!r.ok&&!/cannot be mined/i.test(r.error));
    if(failed.length&&civic.ready(`dig-fail:${config.id}`,20000))log('dig_mine_failed',{agent:config.id,dig:dig.name,at:{x:Math.round(self.x*10)/10,y:Math.round(self.y*10)/10,z:Math.round(self.z*10)/10},errors:failed.map(r=>({x:r.block.x,y:r.block.y,z:r.block.z,error:r.error}))});
    if(outcome.stop)return finish(`stopped safely (${outcome.stop})`);
    return;
  }
  if(self.pathing)return;
  // Not getting there on the same level (gravel fell back into the gallery, a cave-in): dig through toward the work
  // at the tunnel's height, as a miner would, instead of walking at the wall until the dig is given up.
  const flatGap=Math.hypot(step.x-self.x,step.z-self.z);
  // Far from the work (up at the pithead when the dig starts): the town's travel (legs, stairs, chunk loading) - one
  // pathfind that far is refused by the plugin ("Target outside allowed range"), which used to end the dig.
  if(flatGap>20||Math.abs(step.y-self.y)>8){await life.travel(config.id,self,{x:step.x,y:step.y,z:step.z}).catch(()=>{});dig.stalls++;return;}
  if((dig.stalls>=2||dig.obstructed)&&flatGap>1.5&&flatGap<=32&&Math.abs(step.y-self.y)<=2){
    const ux=(step.x-self.x)/flatGap,uz=(step.z-self.z)/flatGap,seen=new Set();let opened=0;
    // The line toward the work at the tunnel's height, then - for a miner wedged in a one-block pocket beside the
    // tunnel, whose straight line is already open - the two blocks beside him toward the work, at his own height
    // (the pathfinder cannot cut a corner between two rock blocks).
    const fx=Math.floor(self.x),fz=Math.floor(self.z),fy=Math.floor(self.y),sx=Math.sign(Math.round(ux)),sz=Math.sign(Math.round(uz))||Math.sign(uz);
    const cells=[];for(let k=1;k<=4;k++)for(const y of [step.y,step.y+1])cells.push([Math.floor(self.x+ux*k),y,Math.floor(self.z+uz*k)]);
    for(const y of [fy,fy+1]){if(sx)cells.push([fx+sx,y,fz]);if(sz)cells.push([fx,y,fz+sz]);}
    for(const [x,y,z] of cells){
      const key=`${x},${y},${z}`;if(seen.has(key))continue;seen.add(key);
      const r=await act(config.id,{type:'mine',x,y,z}).catch(e=>({error:e.message}));
      if(r&&!r.error){opened++;dig.mined++;for(const [item,n] of Object.entries(r.drops??{}))dig.drops[item]=(dig.drops[item]??0)+n;}
      else if(DIG_HAZARD.test(r?.error??''))return finish(`stopped safely (${r.error})`);
    }
    // A hole in the tunnel floor (an old staircase shaft, a cave) stops the pathfinder: fill the floor along the line
    // with cobblestone from his pack (a block already there is simply "occupied").
    if((self.inventory?.COBBLESTONE??0)>0)for(let k=1;k<=4;k++){
      const x=Math.floor(self.x+ux*k),z=Math.floor(self.z+uz*k),key=`floor:${x},${z}`;if(seen.has(key))continue;seen.add(key);
      const r=await act(config.id,{type:'place',x,y:step.y-1,z,target:'COBBLESTONE'}).then(()=>'ok').catch(e=>e.message);
      if(r==='ok'){opened++;log('dig_floor_filled',{agent:config.id,dig:dig.name,at:{x,y:step.y-1,z}});}
    }
    const wasObstructed=dig.obstructed;dig.obstructed=false;
    if(!opened&&wasObstructed&&++dig.moveFails>=3)return finish('could not walk further on');   // solid rock and nothing to dig: give up
    if(opened){dig.stalls=Math.max(0,dig.stalls-2);dig.moveFails=0;log('dig_through',{agent:config.id,dig:dig.name,opened,toward:{x:step.x,y:step.y,z:step.z}});}
  }
  try{await walk(config.id,{type:'pathfind',x:step.x,y:step.y,z:step.z});dig.moveFails=0;}
  catch(error){if(/^Busy/.test(error.message))return;   // another job is finishing a walk: wait, it is not a failure
    log('dig_walk_failed',{agent:config.id,dig:dig.name,to:{x:step.x,y:step.y,z:step.z},at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)},error:error.message});
    // The spot to stand on is still rock (the gallery to it is not dug yet): dig toward it next tick, not a failure.
    if(/obstructed/i.test(error.message)){dig.obstructed=true;return;}
    if(++dig.moveFails>=3)return finish('could not walk further on');}
  dig.stalls++;
  if(dig.stalls>=12)log('dig_stalled',{agent:config.id,dig:dig.name,to:{x:step.x,y:step.y,z:step.z},at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)}});
}
async function farmStep(config,state,self){
  const farm=state.farm;
  if(Date.now()-farm.last<20000)return;
  if(Math.hypot(self.x-farm.x,self.z-farm.z)>3){
    if(!self.pathing)await walk(config.id,clampMove({type:'pathfind',x:farm.x,y:Math.round(self.y),z:farm.z},self)).catch(()=>{});
    return;
  }
  farm.last=Date.now();
  const result=await act(config.id,{type:'tend',x:Math.floor(farm.x),y:Math.floor(self.y),z:Math.floor(farm.z),width:farm.width,depth:farm.depth,target:farm.crop}).catch(error=>{log('farm_error',{agent:config.id,message:error.message});return null;});
  if(result&&(result.tilled||result.planted||result.harvested)){
    civic.award(config.id,'tend');if(result.harvested)civic.onHarvest(config.id,result.harvested);
    log('farm_tended',{agent:config.id,...result});
    if(result.harvested)ledger(config.id,`harvested ${result.harvested} crops: ${Object.entries(result.items).map(([k,v])=>`${v} ${k}`).join(', ')}`);
  }
}
// Status line shown when a player shift-right-clicks an agent; sent only when it changes.
const shownStatus=new Map(),statusSent=new Map(),inWater=new Map(),navStall=new Map();
function statusOf(config,state){
  const job=state.project?`building ${state.project.name} (${state.project.placed}/${state.project.total})`
    :state.dig?`digging ${state.dig.name} (${state.dig.mined} mined)`
    :state.farm?`tending a ${state.farm.crop.toLowerCase().replace(/_/g,' ')} farm`
    :config.role==='guardian'?`guarding ${config.protect??'the town'}`:config.role==='fisher'?fisher.status(state):specialists?.status(config,state)??'free to help';
  return `${config.role??'citizen'} - ${job}${state.mood?` - feeling ${state.mood}`:''}`.slice(0,200);
}
// Idle reflex: keeps agents from standing stacked or frozen when they have no job.
const lastMoved=new Map();
function trackMovement(id,self){
  const seen=lastMoved.get(id);
  if(!seen||Math.hypot(seen.x-self.x,seen.z-self.z)>1)lastMoved.set(id,{x:self.x,z:self.z,since:Date.now()});
}
async function idle(config,self){
  const others=snapshot.agents.filter(a=>a.id!==config.id);
  const post=Array.isArray(config.post)?{x:config.post[0]+0.5,z:config.post[1]+0.5}:undefined;
  const step=idleStep(self,others,{since:lastMoved.get(config.id)?.since??Date.now(),post});
  if(!step)return;
  lastMoved.set(config.id,{x:self.x,z:self.z,since:Date.now()});
  // Stand on the real ground at the chosen spot.
  const ground=await act(config.id,{type:'survey',x:Math.floor(step.x),y:0,z:Math.floor(step.z),width:1,depth:1}).catch(()=>null);
  const y=Number.isFinite(ground?.heights?.[0])?ground.heights[0]+1:Math.round(self.y);
  await walk(config.id,clampMove({type:'pathfind',x:step.x,y,z:step.z},self)).catch(()=>{});
}
async function groundAt(id,x,z,fallback){
  const ground=await act(id,{type:'survey',x:Math.floor(x),y:0,z:Math.floor(z),width:1,depth:1}).catch(()=>null);
  return Number.isFinite(ground?.heights?.[0])?ground.heights[0]+1:Math.round(fallback);
}
// The town on the live map (BlueMap via the plugin): sites, buildings, homes, farms, damage, and the trees and ores
// the citizens remember (a hidden layer you can switch on).
let lastMapPush=0;
async function pushMap(){
  lastMapPush=Date.now();
  const id=snapshot?.agents?.[0]?.id;if(!id)return;
  const resources=(intel?.spatial.all({limit:500})??[]).filter(m=>m.category==='tree'||m.category==='ore').map(m=>({id:String(m.memory_id),
    label:String(m.item??m.category).toLowerCase().replace(/_/g,' '),detail:`${m.category==='tree'?'Trees':'Ore'} seen by ${configs.find(c=>c.id===m.observed_by)?.name??m.observed_by}`,x:m.x,y:m.y,z:m.z}));
  // The plugin drops the connection over 8192 characters per message, so the town layers and the resources go
  // separately (each list replaces its own layer), trimmed to fit, and only when they changed.
  const {places,points}=civic.mapLayers();
  for(const spec of [fitMapSpec({places,points},'points'),fitMapSpec({resources},'resources')]){
    const text=JSON.stringify(spec),key=Object.keys(spec).join();
    if(mapSent.get(key)?.text===text&&Date.now()-mapSent.get(key).at<600000)continue;
    await act(id,{type:'mapdata',x:0,y:0,z:0,spec});mapSent.set(key,{text,at:Date.now()});
  }
}
const mapSent=new Map();
const homeFloors=new Map();
// Where to stand inside a 5x5 house (blueprints.mjs): not the centre, which holds the floor lantern the
// pathfinder treats as an obstacle, not the bed, and not the cell just inside the doorway. Prefer beside the bed.
function sleepSpot(lot){
  const door=lot.door??'south',bx=door==='west'?3:1,bz=door==='north'?2:1;
  const bed=[[bx,bz],[bx,bz+1]],inner={east:[3,2],west:[1,2],south:[2,3],north:[2,1]}[door];
  const blocked=([i,k])=>(i===2&&k===2)||bed.some(([a,b])=>a===i&&b===k)||(i===inner[0]&&k===inner[1]);
  const cells=[];for(let i=1;i<=3;i++)for(let k=1;k<=3;k++)if(!blocked([i,k]))cells.push([i,k]);
  cells.sort((a,b)=>Math.hypot(a[0]-bx,a[1]-bz-0.5)-Math.hypot(b[0]-bx,b[1]-bz-0.5));
  const [i,k]=cells[0];
  return {x:lot.x+i+0.5,z:lot.z+k+0.5};
}
const insideHome=(lot,p)=>p.x>=lot.x+1&&p.x<lot.x+4&&p.z>=lot.z+1&&p.z<lot.z+4;
// Night: walk home and stay there. The house floor is one block above ground, so stand on it.
/**
 * Into bed (plugin "sleep", Citizens' sleep pose) once home at night: the bed is against the wall opposite the door,
 * foot then head (blueprints.mjs house). A house without a bed where it should be is retried every 10 minutes.
 */
async function goToBed(config,state,self,lot){
  if(Date.now()-(state.bedTry??0)<15000||(state.bed?.failedAt&&Date.now()-state.bed.failedAt<600000))return;
  state.bedTry=Date.now();
  const door=lot.door??'south',bx=lot.x+(door==='west'?3:1),bz=lot.z+(door==='north'?2:1),y=homeFloors.get(config.id)??Math.floor(self.y);
  const tries=state.bed?.x!==undefined?[[state.bed.x,state.bed.y,state.bed.z]]:[];
  // The bed actually in the house first (the door side only tells where it should be: Jasper's door was moved and
  // he no longer found his bed - a new one was asked for and set on his roof).
  const scan=await act(config.id,{type:'scan',x:lot.x+1,y:y-2,z:lot.z+1,width:3,height:4,depth:3}).catch(()=>null);
  const beds=(scan?.cells??[]).filter(c=>/_BED$/.test(c[3])).map(c=>[c[0],c[1],c[2]]);
  tries.push(...beds);
  for(const [x,z] of [[bx,bz],[bx,bz+1]])for(const yy of [y,y-1,y-2,y+1])tries.push([x,yy,z]);
  for(const [x,yy,z] of tries){
    const ok=await act(config.id,{type:'sleep',x,y:yy,z}).then(()=>true).catch(()=>false);
    if(ok){state.bed={x,y:yy,z};log('went_to_bed',{agent:config.id,bed:[x,yy,z]});return;}
  }
  state.bed={failedAt:Date.now()};log('no_bed',{agent:config.id,lot:[lot.x,lot.z],door});
  // No bed in the house: Bram (the repair crew) brings one and puts it where the house plan has it, foot then head.
  if(scan&&!beds.length)civic.requestFurnish?.({x:bx,y,z:bz,block:'RED_BED',facing:'SOUTH',for:config.id});   // only when there truly is none
}
async function homeStep(config,state,self){
  const lot=homeOf(config.id);
  if(!lot)return;
  // Home at night: to bed until morning (the worker gets them up at dawn).
  // Inside means on the house floor too: standing on the roof above it is not home (Antoine "went to bed" up there).
  const hf=homeFloors.get(config.id),onFloor=hf!==undefined&&Math.abs(self.y-hf)<=1.5;   // floor not measured yet: measure first (below)
  if(insideHome(lot,self)&&onFloor){if(!self.pathing&&!self.sleeping&&isNight(snapshot?.worldTime))await goToBed(config,state,self,lot);return;}
  if(self.pathing)return;
  // The survey at the house centre would return the roof (which overhangs a block); measure the ground two blocks out from the doorway
  // instead and stand on the floor (one block above the ground).
  const out={east:[6,2],west:[-2,2],south:[2,6],north:[2,-2]}[lot.door??'south'];
  if(!homeFloors.has(config.id)){
    const guess=await groundAt(config.id,lot.x+out[0],lot.z+out[1],self.y)+1;
    // Read the floor at the sleeping spot itself: the lowest solid block with two free blocks above it.
    const column=await act(config.id,{type:'scan',x:Math.floor(lot.spot.x),y:guess-6,z:Math.floor(lot.spot.z),width:1,height:12,depth:1}).catch(()=>null);
    const solid=new Set((column?.cells??[]).filter(c=>c[4]).map(c=>c[1])),taken=new Set((column?.cells??[]).map(c=>c[1]));
    const floor=[...solid].sort((a,b)=>a-b).find(y=>!taken.has(y+1)&&!taken.has(y+2));
    homeFloors.set(config.id,floor!==undefined?floor+1:guess);
  }
  const y=homeFloors.get(config.id),spot=lot.spot;
  // No progress since the last try (the pathfinder found no route to the next leg): switch to the plugin's
  // travel, which walks short legs with detours; still nowhere after that, get unstuck and start over.
  const t=state.homeTry;
  if(t&&Date.now()-t.at<8000)return;   // give the last request time to get going
  if(['moving','loading'].includes(self.navigation?.status))return;
  const moved=!t||Date.now()-t.at>120000||Math.hypot(self.x-t.x,self.z-t.z)>1;
  state.homeTry={x:self.x,z:self.z,at:Date.now(),n:moved?0:(t.n+1)};
  const n=state.homeTry.n,near=Math.hypot(self.x-spot.x,self.z-spot.z)<=6;
  // The plugin's travel counts a couple of blocks as arrived (the doorway), so the last steps are a plain pathfind.
  const result=n>=8?(state.homeTry.n=0,await act(config.id,{type:'unstick',x:0,y:0,z:0}).then(()=>({unstick:true})).catch(error=>({error:error.message})))
    :near?await walk(config.id,{type:'pathfind',x:spot.x,y,z:spot.z}).catch(error=>({error:error.message}))
    :n>=2?await act(config.id,{type:'travel',x:spot.x,y,z:spot.z}).then(r=>({travel:r})).catch(error=>({error:error.message}))
    :await life.travel(config.id,self,{x:spot.x,y,z:spot.z}).catch(error=>({error:error.message}));
  if(Date.now()-(homeTrace.get(config.id)??0)>30000){homeTrace.set(config.id,Date.now());log('home_step',{agent:config.id,from:[self.x,self.y,self.z],to:[spot.x,y,spot.z],pathing:!!self.pathing,nav:self.navigation?.status,result:JSON.stringify(result)?.slice(0,160)});}
}
const homeTrace=new Map();
/**
 * Sitting down (SIDLocal 2.18.0 "sit": a stair or slab seat nearby - benches, pews, the jury box - else where they
 * stand): at a gathering, in court, on the holy day or idle, after standing still for 15 seconds. Guards stay on
 * their feet. Any walk gets them up again (the plugin stands them first).
 */
const SIT_KINDS=new Set(['life','court','holy day','routine / idle']),stillSince=new Map();
function maybeSit(config,state,self,kind){
  const p=stillSince.get(config.id);
  if(!p||Math.hypot(p.x-self.x,p.z-self.z)>0.4||self.pathing){stillSince.set(config.id,{x:self.x,z:self.z,at:Date.now()});return;}
  if(self.sitting||self.sleeping||!SIT_KINDS.has(kind)||['guardian','sheriff'].includes(config.role)||state.order)return;
  if(kind!=='court'&&civic.inHall?.(self))return;   // the hall's chairs are assigned at meetings (civic hallSeat)
  if(Date.now()-p.at<15000||Date.now()-(state.sitTry??0)<60000)return;
  state.sitTry=Date.now();
  act(config.id,{type:'sit',x:0,y:0,z:0}).then(r=>log('sat_down',{agent:config.id,kind,seat:!!r?.seat})).catch(()=>{});
}
async function orderStep(config,state,self){
  const order=state.order,player=playerByName(order.player);
  if(order.kind==='stay'){if(order.until&&Date.now()>order.until)state.order=null;return;}
  if(order.kind==='home'){
    if(!isNight(snapshot?.worldTime)&&Date.now()-order.since>120000){state.order=null;return;}
    return homeStep(config,state,self);
  }
  // Follow: Citizens' own follow (SIDLocal 2.18.0) keeps a couple of blocks behind, through doors; the old step-by-step
  // walk is the fallback if the plugin cannot.
  if(order.kind==='follow'&&player&&self.following!==order.player&&!state.followFallback){
    const ok=await act(config.id,{type:'follow',x:0,y:0,z:0,to:order.player}).then(()=>true).catch(()=>false);
    if(ok)return;state.followFallback=Date.now();
  }
  if(order.kind==='follow'&&self.following===order.player)return;
  if(state.followFallback&&Date.now()-state.followFallback>300000)state.followFallback=null;
  if(!player||self.pathing)return;
  const distance=Math.hypot(player.x-self.x,player.z-self.z);
  if(order.kind==='come'&&distance<=3.5){state.order={kind:'stay',player:order.player,since:Date.now(),until:Date.now()+180000};await say(config.id,`Here I am, ${order.player}. What do you need?`);return;}
  if(distance<=3.5)return;
  const dx=self.x-player.x,dz=self.z-player.z,len=Math.hypot(dx,dz)||1;
  await walk(config.id,clampMove({type:'pathfind',x:Math.round((player.x+dx/len*2)*2)/2,y:Math.round(player.y),z:Math.round((player.z+dz/len*2)*2)/2},self)).catch(()=>{});
}
// Builder starts the next unbuilt home when it has nothing else to do in daylight.
async function nextHome(config,state){
  const homes=memory.data.village;
  // A home that failed is tried again two hours later (it used to be given up for good after two tries, leaving four
  // citizens homeless); homes come before the town's other building work (civic builderWork).
  homes.attemptAt??={};
  const todo=configs.map(c=>c.id).find(a=>homeOf(a)&&!homes.built[a]&&((homes.attempts[a]??0)<2||Date.now()-(homes.attemptAt[a]??0)>7200000));
  if(!todo)return false;
  const lot=homeOf(todo);
  const spec={shape:'house',width:5,depth:5,height:3,material:lot.material,trim:lot.trim,roof:lot.roof,floor:lot.floor,door:lot.door,bed:lot.bed??true,chest:true,windows:true};
  // Something already stands on the lot? Its ground inside is well above the ground just outside it (the survey reads a
  // roof as the ground): the house is there - never a second one on its roof (the fisher's and the priest's homes were
  // planned at y74-79 on top of their own houses). It counts as built; a missing bed is asked for at bedtime.
  {const sv=await act(config.id,{type:'survey',x:lot.x-2,y:0,z:lot.z-2,width:9,depth:9}).catch(()=>null);
    const h=sv?.heights;
    if(Array.isArray(h)&&h.length===81){
      const inner=[],ring=[];
      for(let i=0;i<9;i++)for(let k=0;k<9;k++){const v=h[i*9+k];   // the inner 5x5 and the ring are symmetric: row order does not matterif(!Number.isFinite(v))continue;
        const dx=i-2,dz=k-2;if(dx>=0&&dx<=4&&dz>=0&&dz<=4)inner.push(v);else if(dx<-1||dx>5||dz<-1||dz>5)ring.push(v);}
      const mode=a=>{const c=new Map();a.forEach(v=>c.set(v,(c.get(v)??0)+1));return [...c].sort((x,y)=>y[1]-x[1])[0]?.[0];};
      const inside=mode(inner),outside=mode(ring);
      if(Number.isFinite(inside)&&Number.isFinite(outside)&&inside-outside>=3){
        homes.built[todo]=true;
        log('home_found_existing',{home:todo,lot:[lot.x,lot.z],inside,outside});
        ledger(config.id,`found ${todo}'s house already standing on its lot - no second one on the roof`);
        return false;
      }
    }}
  try{
    await dispatch(config.id,{type:'blueprint',x:lot.x,y:0,z:lot.z,target:'',text:'',to:'',blocks:[],count:1,spec},state);
    state.project.homeFor=todo;state.project.name=`home for ${todo}`;
    ledger(config.id,`started building a home for ${todo} on the village street`);
    await say(config.id,todo===config.id?'Time I built myself a little home on the village street!':`Building a home for ${todo} on the village street!`);
    return true;
  }catch(error){homes.attempts[todo]=(homes.attempts[todo]??0)+1;homes.attemptAt[todo]=Date.now();log('home_error',{home:todo,message:error.message});return false;}
}
function tagOf(config,state){
  const title=config.id[0].toUpperCase()+config.id.slice(1);
  const night=isNight(snapshot?.worldTime);
  const job=state.order?{follow:`following ${state.order.player}`,come:`coming to ${state.order.player}`,stay:'staying put',home:'going home'}[state.order.kind]
    :config.role==='guardian'?(playerByName(config.protect)?`guarding ${config.protect}`:'on patrol')
    // At night: asleep at home only when actually inside it; the homeless sleep out on their lot until it is built.
    :night&&selfOf(config.id)?.sleeping?'asleep in bed'
    :night&&homeBuilt(config.id)&&homeOf(config.id)&&selfOf(config.id)&&insideHome(homeOf(config.id),selfOf(config.id))?'at home, off to bed'
    :night&&homeBuilt(config.id)?'heading home'
    :night&&!homeBuilt(config.id)&&config.role!=='visitor'?'sleeping under the stars'
    :state.project?`${state.project.name} ${state.project.placed}/${state.project.total}`
    :state.dig?`digging (${state.dig.mined})`
    :state.farm?`farming ${state.farm.crop.toLowerCase().replace(/_seeds$/,'').replace(/_/g,' ')}`
    :config.role==='fisher'?fisher.status(state)
    :config.role==='lumberjack'?(lumberjack?.status(config,state)??'among the trees')
    :config.role==='chef'?(chef?.status(config,state)??'in the kitchen')
    :specialists?.status(config,state)??'free';
  const emote=life?.emote(config)??'';
  // The nametag already shows the name; this line shows mood and job.
  return `${emote?emote+' §r':''}${job}`;
}
const inCombat=id=>Date.now()-(combat.get(id)?.lastThreat??0)<10000;
// Validated action execution for the goal executor and reflections (same checks as planned actions).
async function performAction(id,action){
  const self=selfOf(id),config=configs.find(c=>c.id===id);if(!self||!config)throw Error('World state became stale');
  const a=assertAction(clampMove(action,self),self,configs.map(c=>c.id));
  if(a.type==='blueprint')civic.checkBlueprint(id,a);
  if(a.type==='farm'&&String(a.spec.crop).toLowerCase()!=='cancel')civic.checkFarm(a);
  return dispatch(id,a,memory.agent(config));
}
const RESOURCE_QUERIES={miner:'iron coal ore',farmer:'wheat carrots crops',builder:'wood stone',smith:'iron coal',herbalist:'flowers berries cane',fisher:'berries mushrooms',
  crafter:'wood coal wheat',courier:'food',scout:'flowers wood',guardian:'monsters',merchant:'food chest',governor:'food chest',scribe:'structures'};
// Work orders and quests between citizens are paid inside the bank: from the issuer's account, else from the town's
// reserves (the town carries a citizen who cannot pay); null when neither can (the warehouse treasury is tried next).
/** A court fine (skills/justice.mjs): from the debtor's account to the creditor (or the town), as much as the account holds. */
async function collectFine(debtor,creditor,amount,memo){
  if(!bank||!(amount>0))return {paid:0};
  const n=Math.min(amount,bank.balance(debtor).balance??0);if(n<1)return {paid:0};
  await bank.transfer(debtor,creditor&&isCitizen(creditor)?creditor:'~town',n,{memo,kind:'fine'});
  return {paid:n};
}
/** A summoned citizen: to their stand in the courtroom, then wait there until the court adjourns. */
async function courtStep(config,self,summons){
  const st=summons.stand;if(!st)return;
  if(Math.hypot(self.x-st.x,self.z-st.z)>1.5){if(!self.pathing)await life.travel(config.id,self,{x:st.x,y:Math.round(st.y??self.y),z:st.z}).catch(()=>{});return;}
  if(!courtNoted.has(`${config.id}:${summons.conflict_id}`)){courtNoted.add(`${config.id}:${summons.conflict_id}`);log('court_attended',{agent:config.id,conflict_id:summons.conflict_id,role:summons.role});}
}
const courtNoted=new Set();
async function payFromBank(issuer,contractor,amount,memo,{player=false}={}){
  if(!bank||issuer===contractor||(!player&&!isCitizen(contractor)))return null;
  const kind=player?'payment':'wage';   // players are not taxed; citizens' income tax is withheld
  let source=null;
  if(isCitizen(issuer)&&(bank.state.accounts[issuer]?.balance??0)>=amount){await bank.transfer(issuer,contractor,amount,{memo,kind});source='account';}
  else if(bank.state.municipal_vault.total_tax_reserves>=amount){await bank.transfer('~town',contractor,amount,{memo,kind});source='town';}
  else if(player){
    // A player delivered real goods into the town: the bank may mint the reward against them (within today's cap).
    const st=memory.data.bank.labor,day=new Date().toISOString().slice(0,10);if(st.minted?.day!==day)st.minted={day,count:0};
    const cap=Number(process.env.BANK_MINT_PER_DAY??256);
    if(st.minted.count+amount<=cap){await bank.mint(amount);st.minted.count+=amount;await bank.payWage(contractor,amount,{memo:`${memo} (minted against goods delivered)`,taxFree:true});source='minted';}
  }
  if(!source)return null;
  if(player){const near=configs.find(c=>c.id===issuer)?.id??bankOfficer();
    act(near,{type:'whisper',x:0,y:0,z:0,to:contractor,text:`${amount} emeralds for ${memo} are in your town bank account (balance ${bank.balance(contractor).balance}). Collect them from Finneas with /sid bank cashout.`}).catch(()=>{});}
  log('bank_paid',{to:contractor,amount,source,memo,player});
  return {source};
}
intel=createIntelligence({onOrderOverdue:o=>justice?.considerContract(o),knownStock:id=>lifesim?.knownStock(id),payFromBank:(...a)=>payFromBank(...a),onLabor:(id,a,u)=>economy?.labor(id,a,u),stateDir:process.env.STATE_DIR||'./state',lm,log,ledger,say,act,configs,memory,isOffline,HOSTILE,getSnapshot:()=>fresh()?snapshot:null,valuesOf:id=>cognition?.valuesOf(id),
  travel:(...a)=>life.travel(...a),civic:()=>civic,perform:performAction,isNight:t=>isNight(t),
  restSpot:id=>{const h=homeOf(id);if(h&&homeBuilt(id))return {x:h.cx,z:h.cz};const p=configs.find(c=>c.id===id)?.post;return p?{x:p[0]+0.5,z:p[1]+0.5}:null;},resourceQueryFor:c=>RESOURCE_QUERIES[c.role??c.id]??'food wood',
  playerPos:name=>[...players.entries()].find(([uuid])=>(names.get(uuid)??uuid)===name)?.[1],baseWeights:id=>cognition?.baseWeights(id)});
cognition=createCognition({configs,memory,getSnapshot:()=>fresh()?snapshot:null,hostile:HOSTILE,chats:()=>chats,log,homeOf,homeBuilt,intel:()=>intel,civic:()=>civic,
  players:()=>[...players].filter(([,p])=>Date.now()-p.time<300000&&Number.isFinite(p.x)).map(([uuid,p])=>({name:names.get(uuid)??uuid,x:p.x,y:p.y,z:p.z})),
  travel:(...a)=>life.travel(...a)});
life=createLife({valuesOf:id=>cognition?.valuesOf(id),bank:()=>bank,economy:()=>economy,justice:()=>justice,warehouseSpot:()=>{const w=civic?.sites?.warehouse;return w?{x:w.x+4,y:64,z:w.z+3}:null;},configs,memory,act,say,walk,clampMove,log,ledger,conversation,lm,bridge,players,names,homeOf,homeBuilt,playerByName,ROADS,intel:()=>intel,
  getSnapshot:()=>fresh()?snapshot:null,inCombat,raidActive:()=>civic?.raidActive(),lmOnline:()=>lm.online,homeFloor:id=>homeFloors.get(id),
  onAreaChanged:area=>{if(home)home.radius=area.radius-4;}});
civic=createCivic({homeLots:()=>configs.filter(c=>c.role!=='visitor'&&homeOf(c.id)&&homeBuilt(c.id)).map(c=>({id:c.id,name:(c.name??c.id).split(' ')[0],...village.homes[c.id]})),bedtime:(c,s,self)=>homeStep(c,s,self),insideHome,clerkAvailable:()=>{const c=configs.find(x=>x.role==='clerk'),s=c&&fresh()&&snapshot?.agents?.find(a=>a.id===c.id);
  return !!s&&!!clerk&&!isNight(snapshot.worldTime)&&clerk.onDuty()&&!justice?.restricted(c.id)&&!intel?.motivation?.napping?.(c.id);},
  mineSite:()=>{const v=miner?.view();if(!v)return undefined;return v.phase==="CLAY"?"the clay pit":v.phase==="EXPANSION"?"opening a new mine level":v.next<v.of?`mine level ${v.level}`:undefined;},construction:()=>construction,knownStock:id=>lifesim?.knownStock(id),onVote:(...a)=>lifesim?.onVote(...a),moodOf:id=>lifesim?.moodFor(id),economy:()=>economy,justice:()=>justice,quests:()=>quests,affectOf:id=>cognition?.affectOf(id),feel:(id,k,s)=>cognition?.feel(id,k,s),faith:()=>priest,configs,memory,act,say,walk,clampMove,dispatch,log,ledger,conversation,playerByName,homeOf,homeBuilt,lm,HOSTILE,travel:life.travel,inCombat,intel:()=>intel,buildMaterials:()=>bridge.info?.materials??[],valuesOf:id=>cognition?.valuesOf(id),
  getSnapshot:()=>fresh()?snapshot:null,idle:(c,self)=>idle(c,self)});
fisher=createFisher({memory,act,say,walk,clampMove,log,ledger,conversation,lm,playerByName,travel:life.travel,getSnapshot:()=>fresh()?snapshot:null,
  award:(...a)=>civic.award(...a),postQuest:(...a)=>civic.postQuest(...a),goToWarehouse:civic.goToWarehouse,deposit:civic.deposit,ready:civic.ready});
priest=createPriest({persuadability:id=>lifesim?.persuadability(id)??1,memory,configs,act,say,log,ledger,lm,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),
  cognition:()=>cognition,intel:()=>intel,civic:()=>civic,homeOf,homeBuilt});
chef=createChef({memory,configs,act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,civic:()=>civic,travel:(...a)=>life.travel(...a)});
miner=createMiner({orders:()=>civic.minerOrders(),memory,configs,act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),civic:()=>civic,dayPhase:phaseOf});
lumberjack=createLumberjack({memory,configs,act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),civic:()=>civic,intel:()=>intel});
specialists=createSpecialists({herbShed:()=>civic?.workshopSpot?.('herb_shed')??null,infirmaryLayout:()=>civic?.infirmaryLayout?.()??null,memory,act,say,walk,clampMove,log,ledger,lm,playerByName,configs,travel:life.travel,getSnapshot:()=>fresh()?snapshot:null,intel:()=>intel,
  award:(...a)=>civic.award(...a),postQuest:(...a)=>civic.postQuest(...a),goToWarehouse:civic.goToWarehouse,deposit:civic.deposit,withdraw:civic.withdraw,ready:civic.ready,
  placeToolOrder:(...a)=>civic.placeToolOrder(...a)});
quests=createQuests({board:intel.board,executor:intel.executor,configs,act,say,log,ledger,nameOf:intel.nameOf,roleOf:id=>configs.find(c=>c.id===id)?.role??id,getSnapshot:()=>fresh()?snapshot:null,
  civic:()=>civic,travel:(...a)=>life.travel(...a),award:(...a)=>civic.award(...a),valueOf:item=>civic.prices()?.[item]?.value??1,onServiceDone:(id,o)=>justice?.onServiceDone(id,o),
  onQuestDone:(id,o)=>{const a={PATROL_TERRITORY:'PATROL',INVESTIGATE_DISPUTE:'INVESTIGATION'}[o.order_type];if(a)economy?.labor(id,a,1);}});
justice=createJustice({relation:(a,b)=>intel.social.relationship(a,b),memory,configs,act,say,log,ledger,lm,getSnapshot:()=>fresh()?snapshot:null,nameOf:intel.nameOf,quests:()=>quests,valuesOf:id=>cognition?.valuesOf(id),
  trust:(a,b)=>intel.social.view(a,b)?.trust_score??50,adjustTrust:(a,b,delta,why)=>{try{intel.social.adjust(a,b,{trust:delta,reliability:delta/2},'court',why);}catch{}},
  // The court sits in the courthouse once it stands (the bench), before that in the town hall.
  courtSpots:()=>civic.hallCourt(),
  courtPlace:()=>{const room=civic.courtLayout();if(room)return {x:room.bench.x,z:room.bench.z};const hc=civic.hallCourt();if(hc)return {x:hc.place.x,z:hc.place.z};const h=civic.sites.town_hall;return memory.data.town?.built?.town_hall&&h?{x:h.x+5.5,z:h.z+4.5}:{x:SQUARE_X,z:SQUARE_Z};},
  courtLayout:()=>civic.courtLayout(),jailSite:()=>civic.jailSite(),collectFine:(...a)=>collectFine(...a),
  traitsOf:id=>lifesim?.traitsOf(id),remember:(id,m)=>cognition?.remember(id,m),
  chronicle:text=>ledger(justice.magistrate()??'town',text.slice(0,300)),
  square:{x:283.5,z:93.5},onVerdict:(c,s)=>{const k=(memory.data.town.cases??[]).find(x=>x.conflict_id===c.conflict_id);if(k)k.status=['jail','fine'].includes(s.outcome)?'convicted':s.outcome;}});
memory.data.bank??=emptyBank();memory.data.bank.labor??={};
const isCitizen=id=>configs.some(c=>c.id===id&&c.role!=='visitor');
// The vault: the plugin keeps the coins in the bank's vault chests (or the strongbox before the bank stands).
const bankOfficer=()=>configs.find(c=>c.role==='banker'&&snapshot?.agents.some(a=>a.id===c.id))?.id??snapshot?.agents?.[0]?.id;
const vaultCall=(agent,op,count)=>{const box=civic.bankVault();return act(agent,{type:'vault',x:box?.x??0,y:box?.y??0,z:box?.z??0,width:box?.width??0,height:box?.height??1,depth:box?.depth??0,text:op,count:Math.max(1,count)});};
bank=createBank(memory.data.bank,{log,physical:({op,agent,count})=>vaultCall(agent??bankOfficer(),op,count)});
const funding=createFunding({bank,save:()=>memory.flush(),log,physical:({op,count})=>vaultCall(bankOfficer(),op,count)});
economy=createEconomy({isHauler:id=>(configs.find(c=>c.id===id)?.role??id)==='courier',bank,state:memory.data.bank.labor,log,ledger,isCitizen,levelOf:id=>civic.levelFor(id),baseRates:DEFAULT_WAGE_RATES,bankerId:()=>configs.find(c=>c.role==='banker')?.id});
// One-time correction (2 Oct): the courier was paid for thousands of hauled wheat seeds and other people's crops (a
// valuation bug); everything in its account above the holding-fee threshold goes back to the town reserves, which then
// fund back pay, stipends and quest rewards. Logged and written in the ledger.
if(!memory.data.bank.correctionV1){memory.data.bank.correctionV1=true;
  const c=configs.find(x=>(x.role??x.id)==='courier'),bal=c?memory.data.bank.accounts?.[c.id]?.balance??0:0,excess=bal-(memory.data.bank.tax_config?.holding_free??64);
  if(c&&excess>0)setTimeout(()=>bank.transfer(c.id,'~town',excess,{memo:'correction: hauling was overpaid (seed valuation bug)',kind:'fee'})
    .then(()=>{log('bank_correction',{agent:c.id,amount:excess});ledger('banker',`returned ${excess} emeralds of overpaid hauling pay from ${c.name??c.id}'s account to the town reserves`);})
    .catch(e=>log('bank_correction_failed',{message:e.message})),5000);}
// One-time: what the merchant still owed producers (the treasury was empty) becomes pay owed by the bank.
if(!memory.data.bank.owedMigrated){memory.data.bank.owedMigrated=true;for(const [id,v] of Object.entries(memory.data.town?.owed??{}))if(v>0&&isCitizen(id)){memory.data.bank.labor.pending[id]=(memory.data.bank.labor.pending[id]??0)+v;memory.data.bank.labor.mintable=(memory.data.bank.labor.mintable??0)+v;}
  if(memory.data.town)memory.data.town.owed={};log('bank_opened',{owedMigrated:Object.keys(memory.data.bank.labor.pending??{}).length});}
banker=createBanker({act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),bank:()=>bank,economy:()=>economy,
  physical:({op,count})=>vaultCall(bankOfficer(),op,count),nameOf:intel.nameOf,isCitizen,restricted:id=>justice.restricted(id),treasury:()=>memory.data.town?.stock?.items?.EMERALD??0,
  wageMultiplier:()=>memory.data.town?.policy?.wageMultiplier??1,mintCap:Number(process.env.BANK_MINT_PER_DAY??256),day:()=>memory.data.town?.day,
  needs:()=>({pantryStatus:civic.pantryStatus(),shortages:[],threats:memory.data.town?.weekThreats??0}),counter:()=>civic.bankCounter(),
  citizens:()=>configs.filter(c=>isCitizen(c.id)).map(c=>c.id)});
lifesim=createLifeSim({valuesOf:id=>cognition?.valuesOf(id),warehouseSpot:()=>{const w=civic.sites?.warehouse;return w&&memory.data.town?.built?.warehouse?{x:w.x+4,y:null,z:w.z+3}:null;},stock:()=>civic.stockItems(),memory,configs,act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),nameOf:intel.nameOf,social:()=>intel.social,homeOf,homeBuilt,
  eatJob:(...a)=>civic.eatJob(...a),affectOf:id=>cognition?.affectOf(id),restricted:id=>justice.restricted(id),inCombat,sheltered:id=>civic.sheltering(id),tavernSpot:()=>civic.tavernSpot(),
  befriend:(a,b,n)=>intel.social.adjustPair(a,b,{trust:n},'gathering','spent the evening together'),conflict:id=>justice.find(id),justice:()=>justice,magistrate:()=>civic.governorOf()?.id,
  warrantsFor:()=>[...justice.warrants().map(w=>w.suspect),...justice.investigations().flatMap(c=>[c.party_a,c.party_b])]});
construction=createConstruction({staleProject:p=>!p?.completing&&p?.completionPlan===undefined&&!p?.finishing&&!!p?.homeFor&&homeBuilt(p.homeFor),act,walk,placeAll,nextBuildStep,recordPlacements,civic:()=>civic,memory,log,ledger,say,reach:BUILD_REACH,
  travel:(...a)=>life.travel(...a),nameOf:id=>intel.nameOf(id),traits:id=>lifesim.traitsOf(id)});
// One-time (2026-10-03): the fisher's house already stands on its lot (walls, roof, windows - from before the world
// restore) but was not marked built; the builder planned a second house on its roof (y79) and stood stuck there all
// day, holding up every other building. Marked built; the bed, chest and lantern it lacks go to the repair crew.
{const v=memory.data.village,b=memory.data.agents.builder;
  if(!v.fisherHomeFixV1){v.fisherHomeFixV1=true;
    if(b?.project?.homeFor==='fisher'&&!b.project.placed){log('project_cancelled',{agent:'builder',name:b.project.name,why:'the house already stands; the plan was on its roof'});b.project=null;}
    v.built.fisher=true;
    const lot=homeOf('fisher');
    if(lot)setTimeout(()=>{for(const item of [{x:lot.x+1,y:70,z:lot.z+1,block:'RED_BED',facing:'SOUTH',for:'fisher'},{x:lot.x+1,y:70,z:lot.z+3,block:'CHEST',for:'fisher-chest'},{x:lot.x+2,y:70,z:lot.z+2,block:'LANTERN',for:'fisher-lantern'}])civic?.requestFurnish?.(item);},30000);
  }}
clerk=createClerk({chef:()=>configs.find(c=>c.role==='chef')?.id??null,chestsView:()=>clerk?.chests(),phase:()=>phaseOf(snapshot?.worldTime),memory,act,say,log,ledger,civic:()=>civic,merchant:()=>configs.find(c=>c.role==='merchant')?.id??null,
  posOf:id=>snapshot?.agents?.find(a=>a.id===id)??null,travel:(...a)=>life.travel(...a),nameOf:id=>intel.nameOf(id),
  walkTo:(id,p)=>walk(id,{type:'pathfind',x:p.x,y:p.y,z:p.z})});
restPolicy=createRestPolicy({memory,configs,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),
  shrine:()=>{const s=civic.sites.shrine;return memory.data.town?.built?.shrine&&s?{x:s.x+2.5,z:s.z+2.5}:{x:SQUARE_X,z:SQUARE_Z};}});
healthcare=createHealthcare({memory,configs,act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),nameOf:id=>intel.nameOf(id),
  feedsStarving:()=>configs.some(c=>c.role==='courier'),infirmaryLayout:()=>civic.infirmaryLayout(),fetchFood:(...a)=>civic.fetchFood(...a)});
judge=createJudge({memory,configs,act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),justice:()=>justice,nameOf:id=>intel.nameOf(id),
  courtLayout:()=>civic.courtLayout(),courtSpots:()=>civic.hallCourt(),courtPlace:()=>{const hc=civic.hallCourt();if(hc)return {x:hc.place.x,z:hc.place.z};const h=civic.sites.town_hall;return memory.data.town?.built?.town_hall&&h?{x:h.x+5.5,z:h.z+4.5}:{x:SQUARE_X,z:SQUARE_Z};}});
sheriff=createSheriff({memory,configs,act,say,log,ledger,getSnapshot:()=>fresh()?snapshot:null,travel:(...a)=>life.travel(...a),justice:()=>justice,quests:()=>quests,board:()=>intel.board,
  onShift:id=>economy.labor(id,'PATROL',0.5)});
const percy=createPercy({memory,configs,justice:()=>justice,getSnapshot:()=>fresh()?snapshot:null,tavernSpot:()=>civic.tavernSpot(),jailSite:()=>civic.jailSite(),say,travel:(...a)=>life.travel(...a),log});
// The worker runs once per world snapshot (the plugin sends one a second), with a 1.5 s fallback, and never
// faster than every 400 ms: no ticks on stale data, no idle polling.
let lastWorkerTick=0,lastFurnish=Date.now()-480000;
async function nextWorkerTick(){
  const gap=Date.now()-lastWorkerTick;if(gap<400)await pause(400-gap);
  await new Promise(resolve=>{const timer=setTimeout(()=>{snapshotWaiter=null;resolve();},1500);snapshotWaiter=()=>{clearTimeout(timer);snapshotWaiter=null;resolve();};});
  lastWorkerTick=Date.now();
}
(async function worker(){
  while(!stopping){
    await nextWorkerTick();
    try{cognition.tick();}catch(error){log('cognition_error',{where:'tick',message:error.message});}
    if(fresh())await civic.tick().catch(error=>log('civic_error',{message:error.message}));
    if(fresh()&&Date.now()-lastMapPush>60000)pushMap().catch(error=>log('map_error',{message:error.message}));
    if(fresh())try{intel.tick();}catch(error){log('intel_error',{where:'tick',message:error.message});}
    if(fresh())await life.tick().catch(error=>log('life_error',{message:error.message}));
    if(fresh())await justice.tick().catch(error=>log('justice_error',{message:error.message}));
    if(fresh())try{restPolicy.tick({day:memory.data.town?.day??0,phase:phaseOf(snapshot.worldTime)});}catch(error){log('rest_error',{message:error.message});}
    if(fresh())try{lifesim.tick();}catch(error){log('lifesim_error',{where:'tick',message:error.message});}
    if(fresh()&&Date.now()-lastFurnish>600000){lastFurnish=Date.now();lifesim.furnish().catch(error=>log('lifesim_error',{where:'furnish',message:error.message}));}
    if(memory.data.town?.policy?.marketFee!=null)bank.state.tax_config.sales_tax_rate=memory.data.town.policy.marketFee;
    for(const config of configs)try{
      const self=selfOf(config.id),state=memory.data.agents[config.id];
      // A job running for over two minutes is almost certainly stuck: say so once (with what it was).
      if(self&&working.has(config.id)){const j=jobInfo.get(config.id);if(j&&!j.warned&&Date.now()-j.since>120000){j.warned=true;log('job_stuck',{agent:config.id,job:j.kind,seconds:Math.round((Date.now()-j.since)/1000)});}}
      if(self){// Stranded in water - checked for everyone, mid-job too (a job stuck because no path starts in water never ends) (e.g. fell off a bridge being built): after 20 s, move to safe ground.
      const feet=self.blocks?.find(b=>b.x===Math.floor(self.x)&&b.y===Math.floor(self.y)&&b.z===Math.floor(self.z));
      // ...or floating on top of it (Jasper trod water off the north lake's shore for half an hour: feet in the air,
      // water underneath - nothing noticed, and no path starts from a water cell).
      const under=self.blocks?.find(b=>b.x===Math.floor(self.x)&&b.y===Math.floor(self.y)-1&&b.z===Math.floor(self.z));
      // (seagrass and kelp are water too: Dorn stood on the lake bed in seagrass for a day, never noticed)
      const wet=t=>/^(WATER|SEAGRASS|TALL_SEAGRASS|KELP|KELP_PLANT|BUBBLE_COLUMN)$/.test(t??'');
      if((wet(feet?.type)||(wet(under?.type)&&(!feet||feet.type==='AIR')))&&!self.boating){   // in a boat (a ferry crossing, SIDLocal 2.23.0) is not stranded
        const since=inWater.get(config.id)??Date.now();inWater.set(config.id,since);
        // After 6 s: out onto the nearest bank (SIDLocal 2.23.1 'ashore'); only with no bank in reach, back to the spawn spot.
        if(Date.now()-since>6000){inWater.delete(config.id);state.waterDetourUntil=Date.now()+300000;   // its trips go round (plugin travel) for 5 minutes
          act(config.id,{type:'ashore',x:0,y:0,z:0}).catch(()=>act(config.id,{type:'unstick',x:0,y:0,z:0})).then(()=>log('unstuck',{agent:config.id,from:'water',at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)},job:state.project?.name??state.errand?.kind??null,target:state.project?.queue?.[0]??null})).catch(()=>{});continue;}
      }else inWater.delete(config.id);
      }
      if(!self||working.has(config.id))continue;
      if(civic.skip(config)&&!life.happy(config))continue;   // happy agents keep their pace   // hungry or exhausted agents work at half pace
      trackMovement(config.id,self);
      // A walk that has not moved the citizen for 25 s (the pathfinder found no way, or a long trip circles a wall)
      // is cancelled so its job can try another way; three in a row and the citizen is helped onto open ground.
      if(self.pathing||['moving','loading'].includes(self.navigation?.status)){
        const n=navStall.get(config.id);
        if(!n||Math.hypot(self.x-n.x,self.z-n.z)>1||Math.abs(self.y-n.y)>1.5)navStall.set(config.id,{x:self.x,y:self.y,z:self.z,since:Date.now(),count:0});
        else if(Date.now()-n.since>25000){
          n.count++;n.since=Date.now();
          const to=self.navigation?{x:self.navigation.x,y:self.navigation.y,z:self.navigation.z}:null;
          // Stuck up high (a roof, a scaffold) with somewhere lower to go: help it down now, not after three tries.
          // (Not the miner on his way down the mine: lifting him "onto open ground" put him back on the surface.)
          const perched=to&&Number.isFinite(to.y)&&self.y-to.y>=5&&!(config.role==='miner'&&self.y<60);
          const unstick=(n.count>=3||perched)&&!(config.role==='miner'&&self.y<60);if(n.count>=3||perched)n.count=0;   // underground the miner digs or climbs his own way out
          // The same destination failing twice in 10 minutes is a dead end for now: jobs get an immediate "no way"
          // instead of walking into the same wall again (cleared after 10 minutes).
          if(to){const k=destKey(to),b=navBlocked.get(config.id)??new Map(),f=b.get(k)??{n:0,first:Date.now(),until:0};
            if(Date.now()-f.first>600000)Object.assign(f,{n:0,first:Date.now()});
            f.n++;if(f.n>=2){f.until=Date.now()+600000;log('nav_unreachable',{agent:config.id,to,job:jobInfo.get(config.id)?.kind});}
            b.set(k,f);navBlocked.set(config.id,b);}
          navLeases.delete(config.id);
          log('nav_stalled',{agent:config.id,at:{x:Math.round(self.x),y:Math.round(self.y),z:Math.round(self.z)},to,job:jobInfo.get(config.id)?.kind,unstick,perched});
          // The miner down a hole with somewhere higher to go: he builds himself up on dirt (or cobblestone) from his
          // pack, digging headroom as he goes (plugin 2.30.0 "pillar"), instead of waiting to be lifted out.
          if(config.role==='miner'&&to&&Number.isFinite(to.y)&&to.y-self.y>=3&&Math.hypot(to.x-self.x,to.z-self.z)<=24){
            jobCtx.run({agent:config.id,job:'watchdog',override:true},()=>climbOut(config,self,to)).catch(()=>{});continue;
          }
          jobCtx.run({agent:config.id,job:'watchdog',override:true},()=>act(config.id,unstick?{type:'unstick',x:0,y:0,z:0}:{type:'wait',x:0,y:0,z:0})).catch(()=>{});
          continue;
        }
      }else if(navStall.get(config.id)&&Date.now()-navStall.get(config.id).since>120000)navStall.delete(config.id);
      if(justice.restricted(config.id)){
        percy.observeCustody(config,state);
        const inmate=justice.jailed(config.id);
        if(inmate&&shownStatus.get(config.id)!=='jail'){shownStatus.set(config.id,'jail');act(config.id,{type:'status',x:0,y:0,z:0,text:`In jail: ${Math.ceil(inmate.remaining_ticks/1200)} min`,tag:'jail'}).catch(()=>shownStatus.delete(config.id));}
        const jailWork=justice.jailJob(config,state,self);
        if(jailWork){working.add(config.id);jobInfo.set(config.id,{since:Date.now(),kind:'jail'});jailWork().catch(error=>log('worker_error',{agent:config.id,job:'jail',message:error.message})).finally(()=>working.delete(config.id));}
        continue;
      }
      const status=statusOf(config,state),tag=tagOf(config,state),shown=status+'|'+tag;
      // At most one status/tag update per agent every 5 s (build progress changes constantly).
      const lastStatus=statusSent.get(config.id)??0;
      if(shownStatus.get(config.id)!==shown&&Date.now()-lastStatus>5000){shownStatus.set(config.id,shown);statusSent.set(config.id,Date.now());act(config.id,{type:'status',x:0,y:0,z:0,text:status,tag}).catch(()=>shownStatus.delete(config.id));}
      // Anyone standing inside another agent steps aside first, except a farmer working its plot.
      const night=isNight(snapshot.worldTime),resting=night&&(homeBuilt(config.id)||config.camp)&&config.role!=='guardian';
      // Good morning: resting agents wake up and head back to their posts.
      if(state.resting&&!resting){state.resting=false;act(config.id,{type:'wake',x:0,y:0,z:0}).catch(()=>{});if(Math.random()<0.5)say(config.id,'Good morning!');}
      if(resting&&!state.resting){state.resting=true;log('resting',{agent:config.id});}
      const crowded=!self.pathing&&!state.project&&!state.dig&&!(state.farm&&config.role==='farmer')&&!inCombat(config.id)&&state.order?.kind!=='stay'&&!resting&&!civic.sheltering(config.id)
        &&!civic.warehouseExit(self)   // inside the warehouse people just get on with it (sending one out made them churn through the door)
        // Off since SIDLocal 2.16.2: citizens pass through each other, and the plugin separates two standing in one block.
        // "Step aside" from anyone within 1.5 blocks sent people at the warehouse counter (and in doorways) on 3.5-block
        // detours - onto walls even - and back again: the spinning at the warehouse door.
        &&false;
      if(crowded){const other=snapshot.agents.find(o=>o.id!==config.id&&Math.hypot(o.x-self.x,o.z-self.z)<1.5);if(other)civic.onSeparate(config.id,other.id);}
      const urgent=!crowded&&!state.order?civic.urgentJob(config,state,self,guardStep):null;
      // Intrinsic motivation: a critical need suspends the goal queue and runs a survival subroutine; a calm, idle
      // citizen may start a curiosity or altruism goal instead (those run below as ordinary goal milestones).
      // The citizen's job owner (a project or a dig) keeps control; routines, gatherings, new contracts and model
      // plans queue behind it. Emergencies (critical hunger or exhaustion, danger, alerts) still interrupt.
      const owner=state.project&&state.project.status!=='PARKED'?'build':state.dig?'dig':null;
      // Critical: starving, worn out (the rest mandate - skills/rest.mjs - takes even a builder or miner off the job), or fighting.
      const builderDuty=hasBuilderDuty(config.role,night,state,memory.data.town??{});
      const percyWork=percy.job(config,state,self,night);
      const percyJob=!crowded&&!state.order&&!urgent&&!owner&&!resting?percyWork:null;
      const critical=(state.needs?.hunger??20)<=5||(state.needs?.energy??100)<=REST_START||inCombat(config.id);
      let survival=null;
      // A nap that has begun runs to 75% even for a builder or miner (otherwise the project took back control at 21%).
      const napping=!!intel.motivation?.napping?.(config.id);
      if(!crowded&&!state.order&&!urgent&&(!owner||critical||napping))try{survival=intel.survivalJob(config,state,self,{night,busy:!!(state.project||state.dig||state.errand||state.angler?.trip),free:/\bfree\b/.test(tag)});}catch(error){log('intel_error',{where:'motivation',agent:config.id,message:error.message});}
      let living=!crowded&&!state.order&&!urgent&&!survival&&config.role!=='guardian'?life.job(config,state,self,night):null;
      // Jasper's working hours belong to the warehouse (roles/clerk.mjs): no strolls, gatherings, quests or hobbies.
      const clerkDuty=config.role==='clerk'&&!night&&clerk.onDuty();
      // Marlo's working hours belong to the market hall (civic.traderJob): he sells there, then goes home to sleep.
      // The essential workers keep to their posts whenever they are awake, so citizens can always find them: Marlo in the
      // market hall, Antoine in the bakery kitchen, Finneas at the bank (Jasper in the warehouse: clerkDuty). Court,
      // emergencies, holy days, meals and sleep still come first; no strolls, gatherings, quests or errands meanwhile.
      // Rosa the Herbalist's post is the infirmary (once built): she leaves it for patients and herb trips only.
      const traderDuty=!night&&(config.role==='merchant'?!!civic.marketSpot():config.role==='herbalist'?!!civic.infirmaryLayout():['chef','banker'].includes(config.role));
      if((owner||clerkDuty||traderDuty||builderDuty||percyJob)&&living!=='shelter')living=null;
      // The daily rhythm (skills/needs.mjs): breakfast at dawn, the evening gathering at dusk.
      let rhythm=null;
      if(!crowded&&!state.order&&!urgent&&!survival&&!resting&&!owner&&!clerkDuty&&!traderDuty&&!builderDuty)try{rhythm=lifesim.job(config,state,self,night);}catch(error){log('lifesim_error',{where:'job',agent:config.id,message:error.message});}
      // Work orders (claimed contracts, urgent requests) and goal milestones come before the usual role loops.
      let intelJob=null;
      // Barnaby the Runner: building materials (and the overflow for the shops) before any work order or goal - the
      // herb shed waited on 'the courier is bringing the reserved materials' while he fetched eggs for the chef.
      const runnerFirst=config.role==='courier'&&!night&&!!civic.runnerDue?.();
      if(!crowded&&!state.order&&!urgent&&!survival&&!owner&&!clerkDuty&&!traderDuty&&!runnerFirst&&!builderDuty)try{intelJob=intel.job(config,state,self,{night,busy:!!(state.project||state.dig||state.errand||state.angler?.trip)});}catch(error){log('intel_error',{where:'job',agent:config.id,message:error.message});}
      const communityJob=!night&&!crowded&&!state.order&&!urgent&&!survival&&!intelJob&&!owner&&!resting&&!runnerFirst&&!clerkDuty&&!traderDuty&&!builderDuty?civic.communityJob(config,state,self):null;
      if(communityJob&&living!=='shelter')living=null;
      const roleJob=!crowded&&!state.order&&!urgent&&!survival&&!intelJob&&!communityJob?builderDuty?(!state.project?civic.routineJob(config,state,self,night,nextHome):null):runnerFirst?civic.routineJob(config,state,self,night,nextHome):(config.role==='scout'||config.id==='scout')&&civic.scoutJob(config,state,self,night)?civic.scoutJob(config,state,self,night):(traderDuty?(civic.traderJob(config,state,self,night)??banker.job(config,state,self,night)??chef.job(config,state,self,night)??(config.role==='herbalist'?specialists.job(config,state,self,night)??clinicStep(config,self):null)??(()=>idle(config,self))):null)??(banker.job(config,state,self,night)??clerk.job(config,state,self,night)??sheriff.job(config,state,self,night)??quests.workJob(config,state,self)??quests.maybeTakeWork(config,state,{assignedOnly:true})??fisher.job(config,state,self,night)??specialists.job(config,state,self,night)??priest.job(config,state,self,night)??lumberjack.job(config,state,self,night)??miner.job(config,state,self,night)??chef.job(config,state,self,night)??(night||owner?null:quests.maybeTakeWork(config,state))):null;   // a builder mid-project takes no new open quests (Bram stood 10 minutes of service for 3 emeralds while the library waited)
      // Farm plots (farmland a player made for the town): the farmer tends them in turn; free citizens help when one is overdue.
      const plot=!crowded&&!state.order&&!urgent&&!survival&&!intelJob&&!roleJob&&!resting&&!state.project&&!state.dig&&!builderDuty&&config.role!=='guardian'?civic.plotJob(config,state,self,{night,free:/\bfree\b/.test(tag)}):null;
      // Eating needs no room: a hungry citizen with food on them eats even when someone is standing too close.
      const eatHere=crowded&&!state.order&&(state.needs?.hunger??20)<12&&!!edibleIn(self.inventory);
      // The court (skills/justice.mjs, roles/judge.mjs): the judge runs it, and a summoned citizen goes to their stand and
      // stays until the court adjourns - routines, projects and errands wait. Critical needs and fights come first.
      const summoned=!state.order&&!critical?justice.summonsFor(config.id):null;
      // Court duty (a party, the sheriff or a juror) pauses what they were doing; the project or dig itself stays in
      // their state untouched, so when the court adjourns they pick it up where they left it.
      if(summoned&&!state.courtPause){
        state.courtPause={since:Date.now(),conflict_id:summoned.conflict_id,role:summoned.role,was:jobInfo.get(config.id)?.kind??null,
          project:state.project?{name:state.project.name,placed:state.project.placed,of:state.project.placed+state.project.queue.length}:null,dig:state.dig?.name??null};
        log('court_duty_paused',{agent:config.id,...state.courtPause});
      }else if(!summoned&&state.courtPause){
        log('court_duty_resumed',{agent:config.id,conflict_id:state.courtPause.conflict_id,role:state.courtPause.role,resumes:state.courtPause.was,project:state.courtPause.project,dig:state.courtPause.dig,away:Math.round((Date.now()-state.courtPause.since)/1000)});
        state.courtPause=null;
      }
      const courtJob=!state.order&&!critical?(judge.job(config,state,self)??(summoned?()=>courtStep(config,self,summoned):null)):null;
      // Triage (skills/healthcare.mjs): the medic answers a critical or starving citizen before anything else, and a
      // critically wounded citizen goes to an infirmary bed; like court duty, their work waits in their state.
      const careJob=!state.order&&!inCombat(config.id)?healthcare.job(config,state,self):null;
      // The Holy Day: all non-emergency work pauses (court and triage still come first; the guard keeps an alert).
      const holyJob=!state.order&&!critical&&!careJob&&!courtJob&&!(config.role==='guardian'&&memory.data.town?.alert)?restPolicy.holyJob(config,state,self):null;
      if(!holyJob&&state.holyRest)state.holyRest=false;
      if((courtJob||careJob||holyJob)&&living!=='shelter')living=null;
      // Loitering in the warehouse door lane keeps the door from ever closing: step aside after 5 s.
      const doorway=!state.order&&!inCombat(config.id)?civic.doorwayExit(config.id,self):null;
      if(doorway)log('doorway_cleared',{agent:config.id,to:{x:doorway.x,z:doorway.z}});
      const job=doorway?()=>walk(config.id,{type:'pathfind',x:doorway.x,y:civic.warehouseFloor()??Math.round(self.y),z:doorway.z}).catch(()=>{})
        :careJob?careJob
        :courtJob?courtJob
        :holyJob?holyJob
        :eatHere?()=>civic.eatJob(config,state,self)
        // Crowded inside the warehouse: walk out through the door (a random step aside would hit a wall).
        :crowded&&civic.warehouseExit(self)?()=>life.travel(config.id,self,{...civic.warehouseExit(self),y:Math.round(self.y)}).catch(()=>{})
        :crowded?()=>idle(config,self)
        :state.order?()=>orderStep(config,state,self)
        :urgent?urgent
        :survival?survival
        :percyJob?percyJob
        :rhythm?rhythm
        :intelJob?intelJob
        :communityJob?communityJob
        :roleJob?roleJob
        :config.role==='guardian'?(intel.guardJob(config,state,self)??(()=>guardStep(config,self)))
        :resting?()=>homeStep(config,state,self)
        :state.project?()=>buildStep(config,state,self)
        :state.dig?()=>digStep(config,state,self)
        :plot?plot
        :state.farm&&!night?()=>farmStep(config,state,self)
        // Free time: a hobby (faith.mjs), otherwise the behaviour machine, otherwise a stroll.
        :civic.routineJob(config,state,self,night,nextHome)??priest.leisureJob(config,state,self,{night,raining:!!snapshot.weather?.storm})??cognition.idleJob(config,state,self,{night})??(()=>idle(config,self));
      const chosen=living==='shelter'?()=>homeStep(config,state,self):living??job;
      if(!state.project?.completing&&state.project?.completionPlan===undefined&&!state.project?.finishing&&state.project?.publicWork==='library'&&memory.data.town?.built?.library){log('project_cancelled',{agent:config.id,name:state.project.name,why:'the library is finished (the first one kept)'});state.project=null;continue;}
      if(!state.project?.completing&&state.project?.completionPlan===undefined&&!state.project?.finishing&&state.project?.homeFor&&homeBuilt(state.project.homeFor)){log('project_cancelled',{agent:config.id,name:state.project.name,why:'that home is already built'});state.project=null;continue;}
      if(!job)continue;
      // A guard in a fight (Sentinel's combat AI, SIDLocal 2.18.0) is left to it until the fight is over.
      if(self.fighting){jobInfo.set(config.id,{since:Date.now(),kind:'fighting'});if(Date.now()-(state.fightLog??0)>60000){state.fightLog=Date.now();log('guard_fighting',{agent:config.id});}continue;}
      working.add(config.id);
      jobInfo.set(config.id,{since:Date.now(),kind:living==='shelter'?'shelter':living?'life':careJob&&!doorway?'triage':courtJob&&!doorway?'court':holyJob&&!doorway?'holy day':eatHere?'eat (crowded)':crowded&&civic.warehouseExit(self)?'leave warehouse':crowded?'step aside':state.order?`order:${state.order.kind}`:urgent?'urgent':survival?`survival:${state.motivation?.need??'?'}`:rhythm?`rhythm:${state.schedule_phase}`
        :percyJob?'tavern regular':intelJob?'work order / goal':communityJob?'daily community milestone':roleJob?'role':config.role==='guardian'?'guard':resting?'home (night)':state.project?'build':state.dig?'dig':plot?'farm plot':state.farm&&!night?'farm':state.leisure&&Date.now()<state.leisure.until?`hobby: ${state.leisure.hobby}`:'routine / idle'});
      // Resting at night is not idle: after settling in, do indoor chores (bake, cook, craft).
      const run=resting?async()=>{await chosen();await civic.nightChore(config,state,self);}:chosen;
      const kind=jobInfo.get(config.id)?.kind??'job';
      maybeSit(config,state,self,kind);
      jobCtx.run({agent:config.id,job:kind,worker:true,priority:navPriority(kind)},run).catch(error=>log('worker_error',{agent:config.id,job:jobInfo.get(config.id)?.kind,message:error.message,stack:String(error.stack??'').split('\n').slice(1,3).join(' | ').slice(0,200)})).finally(()=>working.delete(config.id));
    }catch(error){log('worker_error',{agent:config.id,message:`choosing a job: ${error.message}`});}
  }
})();

async function evolve(config,state){
  const recent=state.episodes.slice(-EVOLVE_EVERY).map(e=>e.error?{error:e.error}:{reflection:e.reflection,action:e.action?.type,text:e.action?.text,result:e.ack,project:e.project,defeated:e.defeated});
  const talk=state.talk??{};
  const update=await lm.evolve({name:config.id,core:config.personality,personality:state.personality??config.personality,mood:state.mood??'content',relationships:state.relationships??{},goal:state.goal,recent,chat:chats.slice(-10),
    learnedFromConversations:(talk.learned??[]).slice(-8).map(l=>`${l.text} (from ${l.from})`),recentConversations:Object.entries({...talk.pairs,...talk.players}).flatMap(([who,p])=>(p.notes??[]).slice(-1).map(n=>`with ${who}: ${n.text}`)).slice(0,8)});
  state.personalityHistory=[...(state.personalityHistory??[]),{time:Date.now(),personality:state.personality??config.personality,mood:state.mood}].slice(-5);
  Object.assign(state,update);
  log('personality_evolved',{agent:config.id,mood:update.mood,personality:update.personality});ledger(config.id,`now feels ${update.mood}`);
}

// Read-only dashboard for phones on the LAN: http://<ct119>:8088 (add ?key=... if DASHBOARD_TOKEN is set).
const dashboardHtml=await readFile(new URL('./dashboard.html',import.meta.url),'utf8');
function summarize(line){
  switch(line.type){
    case 'action':return `${line.action}${line.text?': '+line.text:typeof line.result==='string'?' ('+line.result+')':''}`;
    case 'reply':return `replied to ${line.to}: ${line.text}`;
    case 'command':return `/sid ${(line.args??[]).join(' ')}`;
    case 'guardian_attack':return `hit a ${line.target.toLowerCase()} (${line.damage} damage)`;
    case 'farm_tended':return `tended the farm (tilled ${line.tilled}, planted ${line.planted}, harvested ${line.harvested})`;
    case 'agent_error':case 'worker_error':return `trouble: ${line.message}`;
    default:return line.type.replace(/_/g,' ')+(line.summary?': '+line.summary:line.name?': '+line.name:'');
  }
}
function dashboardState(){
  const agents=configs.map(c=>{
    const s=memory.data.agents[c.id]??{},a=snapshot?.agents.find(x=>x.id===c.id),lot=homeOf(c.id);
    const progress=s.project?{done:s.project.placed,total:s.project.total}:null;
    return {id:c.id,name:c.displayName??c.name??c.id,moodNow:life.moodOf(c),role:c.role,online:!!a,x:a&&Math.round(a.x),y:a&&Math.round(a.y),z:a&&Math.round(a.z),held:a?.held,inventory:a?.inventory,
      tag:tagOf(c,s),status:statusOf(c,s),mood:s.mood,personality:s.personality??c.personality,relationships:s.relationships,order:s.order,resting:!!s.resting,
      home:lot?{x:lot.x,z:lot.z,built:homeBuilt(c.id)}:null,pathing:!!a?.pathing,navigation:a?.navigation??null,progress,health:a?.health,armor:a?.armor,...civic.agentView(c,s),talk:life.talkView(c.id),...(cognition?.view(c.id)??{}),...(priest?.agentView(c.id)??{}),...(lumberjack?.agentView(c.id)??{}),...(chef?.agentView(c.id)??{}),
      job:jobInfo.get(c.id)?{kind:jobInfo.get(c.id).kind,seconds:Math.round((Date.now()-jobInfo.get(c.id).since)/1000),running:working.has(c.id)}:null};
  });
  const homes=Object.entries(village.homes??{}).map(([id,lot])=>({id,x:lot.x,z:lot.z,built:homeBuilt(id),building:Object.values(memory.data.agents).some(s=>s.project?.homeFor===id)}));
  return {time:Date.now(),bridgeReady:bridge.ready,lm:{online:lm.online,since:lm.offlineSince,queued:life.tasks.length+civic.tasks.length,endpoints:lm.status()},snapshotAge:received?Math.round((Date.now()-received)/1000):null,worldTime:snapshot?.worldTime,night:isNight(snapshot?.worldTime),
    players:[...players].filter(([,p])=>Date.now()-p.time<120000).map(([uuid,p])=>({name:names.get(uuid)??uuid})),
    agents,homes,homesBuilt:homes.filter(h=>h.built).length,homesTotal:homes.length,
    charter:{rules:memory.data.charter.rules,proposals:memory.data.charter.proposals.map(p=>({id:p.id,by:p.by,text:p.text,yes:Object.values(p.votes).filter(v=>v==='yes').length,no:Object.values(p.votes).filter(v=>v==='no').length}))},
    ledger:memory.data.ledger.slice(-60).reverse(),town:civic.view(),life:life.view(),fisher:fisher.view(),specialists:specialists.view(),faith:priest.view(),justice:justice.view(),health:healthcare.view(),warehouse:clerk.view(),rest:restPolicy.view(),quests:quests.list(),lifesim:lifesim.view(),bank:{funding:funding.view(),accounts:Object.fromEntries(Object.entries(bank.state.accounts).map(([k,a])=>[k,{name:intel.nameOf(k),balance:a.balance,recent:a.transaction_history.slice(0,5)}])),vault:bank.state.municipal_vault,liabilities:bank.liabilities(),wage_rates:bank.state.wage_rates,tax_config:bank.state.tax_config,lastAudit:bank.state.lastAudit,economy:economy.view()},conversations:memory.data.conversations.slice(-150).reverse(),
    activity:recent.filter(l=>!['resting','project_started'].includes(l.type)).slice(-40).reverse().map(l=>({time:l.time,agent:l.agent,player:l.player,summary:summarize(l)}))};
}
const dashboardToken=process.env.DASHBOARD_TOKEN,SQUARE_X=283.5,SQUARE_Z=93.5;
// Browsers on the home network need no key (DASHBOARD_TRUSTED_NETS, comma-separated IPv4 CIDRs; "none" turns it off).
const TRUSTED_NETS=(process.env.DASHBOARD_TRUSTED_NETS??'10.0.0.0/24,127.0.0.1/32').split(',').map(x=>x.trim()).filter(x=>x&&x!=='none').map(cidr=>{
  const [ip,bits='32']=cidr.split('/'),n=Number(bits),mask=n===0?0:(~0<<(32-n))>>>0;
  return {net:(ipv4(ip)&mask)>>>0,mask};
});
function ipv4(text){const p=String(text).replace(/^::ffff:/,'').split('.').map(Number);return p.length===4&&p.every(x=>Number.isInteger(x)&&x>=0&&x<=255)?((p[0]<<24)|(p[1]<<16)|(p[2]<<8)|p[3])>>>0:null;}
const trusted=address=>{const ip=ipv4(address);return ip!==null&&TRUSTED_NETS.some(t=>((ip&t.mask)>>>0)===t.net);};
// Item pictures for the dashboard: the wiki's inventory icons, fetched once and kept in the state folder.
const ICON_DIR=`${process.env.STATE_DIR||'./state'}/icons`,iconMiss=new Map(),iconWait=new Map();
async function itemIcon(item){
  const {mkdir,readFile:rf,writeFile}=await import('node:fs/promises');
  const file=`${ICON_DIR}/${item}.png`;
  try{return await rf(file);}catch{}
  if((iconMiss.get(item)??0)>Date.now())return null;
  if(!iconWait.has(item))iconWait.set(item,iconTurn(async()=>{
    const title=item.toLowerCase().split('_').map((w,i)=>i===0?w[0].toUpperCase()+w.slice(1):w).join('_');
    let notFound=true;
    const wiki={CHICKEN:'Raw_Chicken',BEEF:'Raw_Beef',MUTTON:'Raw_Mutton',PORKCHOP:'Raw_Porkchop',RABBIT:'Raw_Rabbit',COD:'Raw_Cod',SALMON:'Raw_Salmon',
      HAY_BLOCK:'Hay_Bale',WRITABLE_BOOK:'Book_and_Quill',SNOW_BLOCK:'Snow_Block'}[item];
    const words=item.toLowerCase().split('_').map((w,i)=>i>0&&/^(of|the|and|on|a|with)$/.test(w)?w:w[0].toUpperCase()+w.slice(1)).join('_');
    for(const name of [wiki,words,title].filter(Boolean)){
      try{const r=await fetch(`https://minecraft.wiki/w/Special:FilePath/Invicon_${name}.png`,{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'sid-local-dashboard'}});
        if(r.ok&&String(r.headers.get('content-type')).startsWith('image/')){const buf=Buffer.from(await r.arrayBuffer());await mkdir(ICON_DIR,{recursive:true});await writeFile(file,buf);return buf;}
        if(r.status!==404)notFound=false;}catch{notFound=false;}
    }
    // The wiki has no such picture: not asked again for a day. Throttled or offline: tried again in a couple of minutes.
    iconMiss.set(item,Date.now()+(notFound?86400000:120000));return null;
  }).finally(()=>iconWait.delete(item)));
  return iconWait.get(item);
}
// Two downloads at a time - a page of 200 items at once gets throttled by the wiki.
let iconBusy=0;const iconQueue=[];
function iconTurn(job){return new Promise((ok,fail)=>{iconQueue.push(()=>job().then(ok,fail).finally(()=>{iconBusy--;iconQueue.length&&(iconBusy++,iconQueue.shift()());}));if(iconBusy<2){iconBusy++;iconQueue.shift()();}});}
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://dashboard');
  const icon=/^\/icon\/([A-Z0-9_]{1,60})\.png$/.exec(url.pathname);
  if(icon&&req.method==='GET'){
    itemIcon(icon[1]).then(buf=>{if(buf)res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=604800'}).end(buf);else res.writeHead(404,{'Cache-Control':'no-store'}).end();}).catch(()=>res.writeHead(500).end());
    return;
  }
  if(dashboardToken&&url.searchParams.get('key')!==dashboardToken&&!trusted(req.socket.remoteAddress)){res.writeHead(403).end('Forbidden');return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(dashboardHtml);return;}
  if(req.method==='POST'&&url.pathname.startsWith('/api/')){
    // Dashboard controls act as the owner (DASHBOARD_PLAYER or the first PLAYER_NAMES entry).
    let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>4096)req.destroy();});
    req.on('end',async()=>{
      const reply=(code,body)=>res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(body));
      let body;try{body=JSON.parse(raw||'{}');}catch{return reply(400,{ok:false,message:'Bad JSON'});}
      const player=process.env.DASHBOARD_PLAYER||[...names.values()][0]||'owner';
      try{
        if(url.pathname==='/api/bank/fund'){
          const remote=String(req.socket.remoteAddress).replace(/^::ffff:/,'');
          if(dashboardToken&&url.searchParams.get('key')!==dashboardToken&&!['127.0.0.1','::1'].includes(remote))return reply(403,{ok:false,message:'Open the dashboard with its access key to fund the bank'});
          if(!fresh()||!bankOfficer())return reply(503,{ok:false,message:'The Minecraft bank is offline; no funds were moved'});
          try{
            const r=await funding.run({source:body.source,amount:body.amount,actor:player,opId:body.opId,memo:body.memo});
            if(!r.repeated)ledger(player,`bank funding: ${r.amount} emeralds via ${body.source} (${r.status})`);
            return reply(200,{ok:r.status==='done',...r});
          }catch(error){return reply(400,{ok:false,message:error.message});}
        }
        if(url.pathname==='/api/chat'){
          const agent=configs.find(c=>c.id===body.agent),text=String(body.text??'').trim().slice(0,240);
          if(!agent||!text)return reply(400,{ok:false,message:'Pick a bot and write a message'});
          conversation({from:`${player} (dashboard)`,to:agent.id,kind:'player',text});intel?.archive.playerSaid(player,text);
          if(!priority.some(q=>q.id===agent.id))priority.push({id:agent.id,from:player,text,time:Date.now()});
          return reply(200,{ok:true,message:`${agent.id} will answer shortly`});
        }
        if(url.pathname==='/api/endorse'){
          try{return reply(200,{ok:true,message:`You endorsed ${life.endorse(player,String(body.candidate??''))}`});}
          catch(error){return reply(400,{ok:false,message:error.message});}
        }
        if(url.pathname==='/api/vote'){
          const p=memory.data.charter.proposals.find(x=>x.id===String(body.id));
          if(!p)return reply(404,{ok:false,message:'That proposal is no longer open'});
          p.playerVote={player,vote:body.vote==='yes'?'yes':'no',veto:!!body.veto};resolveProposals();await memory.save();
          return reply(200,{ok:true,message:`Proposal #${p.id} ${p.playerVote.vote==='yes'?'approved':'rejected'}`});
        }
        if(url.pathname==='/api/command'){
          const args=String(body.command??'').replace(/^\/?sid\s*/i,'').trim().split(/\s+/).filter(Boolean).slice(0,8);
          const pos=[...players.entries()].find(([uuid])=>(names.get(uuid)??uuid)===player)?.[1];
          if(args[0]==='build'&&pos?.x===undefined)return reply(400,{ok:false,message:`${player} must be in the game for /sid build`});
          await handleCommand({player,args,x:pos?.x??SQUARE_X,y:pos?.y??70,z:pos?.z??SQUARE_Z,yaw:0});
          return reply(200,{ok:true,message:`Sent /sid ${args.join(' ')}`});
        }
        reply(404,{ok:false,message:'Unknown action'});
      }catch(error){reply(500,{ok:false,message:error.message});}
    });
    return;
  }
  if(url.pathname.startsWith('/api/intel')||url.pathname.startsWith('/api/conversations')){intelApi(url,res).catch(error=>{if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));});return;}
  if(url.pathname==='/api/minds'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({...minds.view(configs.map(c=>c.id)),map:process.env.BLUEMAP_URL||'http://10.0.0.58:8100'}));return;}
  if(url.pathname==='/api/relationships'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(intel.social.relationships(configs.filter(c=>c.role!=='visitor').map(c=>c.id))));return;}
  if(url.pathname==='/api/pantry'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({pantry:fisher.pantry(),finley:fisher.view()}));return;}
  if(url.pathname==='/api/state'){
    try{res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(dashboardState()));}
    catch(error){res.writeHead(500).end(JSON.stringify({error:error.message}));}
    return;
  }
  res.writeHead(404).end('Not found');
}).on('error',error=>log('dashboard_error',{message:error.message})).listen(Number(process.env.DASHBOARD_PORT||8088),'0.0.0.0',()=>log('dashboard_ready',{port:Number(process.env.DASHBOARD_PORT||8088)}));

// Intelligence & Economy and Settlement Conversations: read-only APIs and the Excel export.
let ExcelJS=null;
async function intelApi(url,res){
  const send=body=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(body));
  const p=k=>url.searchParams.get(k)||undefined;
  if(url.pathname==='/api/intel')return send({...intel.dashboard(),models:lm.teamStatus(),attention:cognition.attention(),memoryWrites:memory.writes});
  if(url.pathname==='/api/intel/spatial'){
    const from=p('x')&&p('z')?{x:Number(p('x')),z:Number(p('z'))}:{x:272.5,z:96.5};
    const hits=p('q')||p('category')?intel.spatial.query(null,p('q')??'',Math.min(50,Number(p('limit')??20)),p('radius')?Number(p('radius')):null,{from,category:p('category')}):[];
    return send({hits,all:intel.spatial.all({category:p('category'),limit:600}),agents:(snapshot?.agents??[]).map(a=>({id:a.id,name:intel.nameOf(a.id),x:Math.round(a.x),z:Math.round(a.z)}))});
  }
  const filters={participant:p('participant'),from:p('from'),to:p('to'),q:p('q')};
  if(url.pathname==='/api/conversations')return send({...intel.archive.query({...filters,limit:Math.min(200,Number(p('limit')??50)),offset:Number(p('offset')??0)}),people:intel.archive.people(),stats:intel.archive.stats()});
  if(url.pathname==='/api/conversations/export/xlsx'){
    ExcelJS??=(await import('exceljs')).default;
    const {conversations}=intel.archive.query({...filters,limit:100000});
    const wb=buildWorkbook(conversations.map(c=>intel.archive.get(c.conversation_id)).filter(Boolean),ExcelJS);
    const name=`settlement-conversations-${new Date().toISOString().slice(0,10)}.xlsx`;
    res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${name}"`});
    await wb.xlsx.write(res);res.end();return;
  }
  const one=url.pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})$/);
  if(one){const c=intel.archive.get(one[1]);return c?send(c):res.writeHead(404).end('Not found');}
  res.writeHead(404).end('Not found');
}

// One agent's thinking turn: plan with the model, validate, act, reflect on failures, then one settlement task.
// Prompt order for the model servers' prompt cache: what every agent shares first, then what changes slowly for this
// agent, then the live state. A request reuses the cached tokens up to the first difference, so the town-wide part
// is computed once instead of for every agent.
const PREFIX_KEYS=['buildMaterials','area','charter','agent','you','role','protect','home','personality','relationships','goal','mood'];
function prefixStable(context){
  return Object.fromEntries([...PREFIX_KEYS.filter(k=>k in context).map(k=>[k,context[k]]),...Object.entries(context).filter(([k])=>!PREFIX_KEYS.includes(k))]);
}
// Who needs the whole team list with inventories: the logistics roles. Everyone else sees who is nearby.
const TEAM_ROLES=new Set(['merchant','crafter','scribe','courier','governor']);
const BUILD_ROLES=new Set(['builder','governor','crafter']);
// Settlement writing tasks (diary, chronicle, meeting or festival speech): one at a time, in their own slot.
// A task cut short by the model going offline goes back to the front of the queue.
async function runSettlementTask(){
  const thinker=t=>[t?.id,t?.a,t?.b,t?.agent].find(id=>configs.some(c=>c.id===id));
  if(life.tasks.length){const task=life.tasks.shift(),who=thinker(task);if(who)minds.start(who,task.kind,task.kind);await life.runTask(task).finally(()=>who&&minds.end(who,{task:task.kind})).catch(error=>{if(isOffline(error))life.tasks.unshift(task);else log('task_error',{task:task.kind,message:error.message});});}
  if(civic.tasks.length){const task=civic.tasks.shift(),who=thinker(task);if(who)minds.start(who,task.kind,task.kind);await civic.runTask(task).finally(()=>who&&minds.end(who,{task:task.kind})).catch(error=>{if(isOffline(error))civic.tasks.unshift(task);else log('task_error',{task:task.kind,agent:task.id,message:error.message});});}
}
async function agentTurn(config,self,state,inbox,why='always'){
    cognition.noteThought(config,state,why);
    const outcome=evaluate(state.last,self);
    const context={agent:config.id,role:config.role,protect:config.protect,personality:state.personality??config.personality,mood:state.mood,relationships:state.relationships,
      goal:state.goal,self,inbox,timeOfDay:isNight(snapshot.worldTime)?'night':'day',resting:!!state.resting,order:state.order??undefined,home:homeOf(config.id)?{x:homeOf(config.id).cx,z:homeOf(config.id).cz,built:homeBuilt(config.id)}:undefined,
      team:snapshot.agents.filter(a=>a.id!==config.id&&(TEAM_ROLES.has(config.role)||Math.hypot(a.x-self.x,a.z-self.z)<=48)).map(({id,x,y,z,held,inventory})=>{const s=memory.data.agents[id];return {id,role:configs.find(c=>c.id===id)?.role,x:Math.round(x),y:Math.round(y),z:Math.round(z),held,
        // Full team inventories only for logistics roles; keeps everyone else's prompt small.
        inventory:['merchant','crafter','scribe'].includes(config.role)?inventory:undefined,
        working:s?.project?.name??s?.dig?.name??(s?.farm?`farm at ${Math.floor(s.farm.x)},${Math.floor(s.farm.z)}`:undefined)};}),
      charter:{rules:memory.data.charter.rules.slice(-8).map(r=>`#${r.id} ${String(r.text).slice(0,110)}`),proposals:memory.data.charter.proposals.map(p=>({id:p.id,by:p.by,text:p.text,yes:Object.values(p.votes).filter(v=>v==='yes').length,no:Object.values(p.votes).filter(v=>v==='no').length,myVote:p.votes[config.id]}))},
      ledger:memory.data.ledger.slice(config.role==='scribe'?-12:-5).map(e=>`${e.by}: ${String(e.text).slice(0,140)}`),
      mining:config.role==='miner'?{maxY:bridge.info?.mineMaxY,shafts:bridge.info?.mineShafts,dig:state.dig?{name:state.dig.name,mined:state.dig.mined}:null}:undefined,
      farming:state.farm?{plot:state.farm}:undefined,board:memory.data.board.slice(-4),
      // Recent steps plus what the citizen recalls (salient, relevant memories), and only the chat it could hear.
      memory:state.episodes.slice(-2),events:events.filter(e=>e.event!=='chat').slice(-6),evaluation:outcome,area:home,chat:cognition.heardChat(config,state,8),
      ...cognition.context(config,state,self),thinkingBecause:why,
      ...civic.context(config,state),...life.context(config,state),...fisher.context(config,state),...specialists.context(config,state),...priest.context(config),...lumberjack.context(config,state),...miner.context(config),...chef.context(config,state),...justice.context(config),...judge.context(config),...healthcare.context(config),...clerk.context(config),...restPolicy.context(config),...sheriff.context(config),...banker.context(config),...lifesim.context(config),myBank:{balance:bank.balance(config.id).balance,payOwed:Math.round((economy.view().owed[config.id]??0)*10)/10},...intel.context(config,state,self),you:config.name??config.id,
      buildMaterials:bridge.info?.build&&(BUILD_ROLES.has(config.role)||state.project)?bridge.info.materials:undefined,
      projectStatus:state.project?{name:state.project.name,placed:state.project.placed,remaining:state.project.queue.length,deferred:state.project.deferred?.length??0,status:state.project.status,blocker:state.project.blocker?.text,inspected:state.project.inspection??null,truth:construction.statusLine(state.project)}:null,
      intention:state.intention?{goal:state.intention.text,since:Math.round((Date.now()-state.intention.since)/60000)+' min',keep:'Keep to it through meals and chat; change plans only if something important changes.'}:undefined,
      recentBuilds:state.episodes.filter(e=>e.project||['build','place','break','blueprint'].includes(e.action?.type)).slice(-3).map(e=>e.project??{type:e.action.type,result:e.ack}),
      players:[...players].filter(([,p])=>Date.now()-p.time<300000&&p.x!==undefined).map(([uuid,p])=>({name:names.get(uuid)??uuid,x:p.x,y:p.y,z:p.z,distance:Math.round(Math.hypot(p.x-self.x,p.y-self.y,p.z-self.z)),secondsAgo:Math.round((Date.now()-p.time)/1000)})),
      recentDestinations:state.episodes.filter(e=>['move','pathfind'].includes(e.action?.type)).slice(-5).map(e=>[e.action.x,e.action.y,e.action.z])};
    const prompt=prefixStable(context),promptChars=JSON.stringify(prompt).length;
    try {
      const plan=await lm.plan(prompt);
      minds.end(config.id,{reflection:String(plan.reflection??'').slice(0,400),plan:String(plan.plan??'').slice(0,300),action:plan.action?{type:plan.action.type,text:plan.action.text||undefined,to:plan.action.to||undefined,target:plan.action.target||undefined}:undefined});
      if(plan.action.type==='chat')plan.action.text=truthful(config.id,state,await lm.speak({personality:context.personality,mood:state.mood,feeling:context.feeling?.word,intent:plan.action.text,goal:state.goal,chat:cognition.heardChat(config,state,6)}));
      // Revalidate using fresh state after potentially slow inference.
      const now=selfOf(config.id);if(!now)throw Error('World state became stale');
      let action=assertAction(clampMove(plan.action,now),now,configs.map(c=>c.id));
      // "wait" during a project just means keep working (the plugin's wait would cancel the walk).
      if((state.project||state.dig)&&action.type==='wait'){memory.add(config.id,{time:Date.now(),reflection:plan.reflection,action,ack:'kept working'});state.turns=(state.turns??0)+1;await memory.save();return;}
      if(state.project&&!['chat','tell','blueprint','record','propose','vote','complain','turn_in_quest','progress_quest'].includes(action.type))throw Error(`Busy building ${state.project.name}; chat, tell, or blueprint with shape "cancel"`);
      if(state.dig&&!['chat','tell','dig','record','propose','vote'].includes(action.type))throw Error(`Busy digging ${state.dig.name}; chat, tell, or dig with shape "cancel"`);
      if(action.type==='attack'&&snapshot.agents.some(a=>a.uuid===action.target))throw Error('Cannot attack teammate');
      if(action.type==='blueprint')civic.checkBlueprint(config.id,action);
      if(action.type==='farm'&&String(action.spec.crop).toLowerCase()!=='cancel')civic.checkFarm(action);
      const talkOnly=['chat','tell','record','propose','vote','wait','appraise','give','eat','quest','zone','mediate','goal','claim_quest','progress_quest','turn_in_quest','complain','pardon','get_balance'];
      if(state.resting&&!talkOnly.includes(action.type))throw Error("It's night and you are resting at home; you can chat, tell, record, vote or wait");
      if(state.order&&['move','pathfind','blueprint','dig','farm'].includes(action.type))throw Error(`${state.order.player} asked you to ${state.order.kind}; chat instead until they use /sid free`);
      const nearPlayer=[...players.values()].some(p=>p.x!==undefined&&Math.hypot(p.x-action.x,p.z-action.z)<=6);
      // A step of a few blocks is not worth a walk (or a retry): the citizen just looks around where it is.
      if(['move','pathfind'].includes(action.type)&&!nearPlayer&&Math.hypot(action.x-now.x,action.z-now.z)<MIN_MOVE){
        memory.add(config.id,{time:Date.now(),reflection:plan.reflection,action:{...action,type:'wait'},ack:'looked around'});log('action',{agent:config.id,action:'look',result:'stayed (destination too close)',why,ctx:promptChars});
        state.turns=(state.turns??0)+1;await memory.save();return;
      }
      let ack;
      if(action.type==='tell'){
        memory.tell(config.id,action.to,action.text);ack='delivered';civic.onTell(config.id,action.to);
        conversation({from:config.id,to:action.to,kind:'tell',text:action.text});
        await act(config.id,{type:'chat',x:0,y:0,z:0,text:`@${action.to}: ${action.text}`.slice(0,240)}).catch(()=>{});
      }
      else{
        intel.beforeAction(config.id,action);
        try{({ack,action}=await dispatch(config.id,action,state));}
        catch(error){
          if(isOffline(error))throw error;
          // ReAct: reflect on the failure (utility model, or rules) and try one corrective action instead of repeating it.
          const r=await intel.onActionFailed(config,state,action,error,now).catch(()=>null);
          if(r?.strategy==='alternate_action'&&r.action){
            try{
              const fixed=assertAction(clampMove({x:0,y:0,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{},...r.action},now),now,configs.map(c=>c.id));
              intel.beforeAction(config.id,fixed);
              ({ack,action}=await dispatch(config.id,fixed,state));ack={corrected:r.reflection,after:error.message,result:ack};
            }catch(second){intel.reflector.noteFailure(config.id,r.action,second.message);throw Error(`${error.message} (then: ${second.message}). Reflection: ${r.reflection}`);}
          }else throw Error(r?`${error.message}. Reflection: ${r.reflection} (${r.strategy})`:error.message);
        }
      }
      state.last={action,ack,distance:Math.hypot(now.x-action.x,now.y-action.y,now.z-action.z)};
      state.inbox=state.inbox.filter(i=>!inbox.includes(i));if(state.cog)state.cog.inboxTries=0;
      memory.add(config.id,{time:Date.now(),reflection:plan.reflection,plan:plan.plan,action,ack,evaluation:outcome});
      log('action',{agent:config.id,action:action.type,result:ack,why,ctx:promptChars,...(action.text?{to:action.to||undefined,text:action.text}:{})});
    }catch(error){
      if(isOffline(error))return 'offline';memory.add(config.id,{time:Date.now(),error:error.message});log('agent_error',{agent:config.id,message:error.message,why});
      // Messages get two tries; after that they are dropped so a failing turn does not re-trigger thinking forever.
      const c=state.cog;if(c&&inbox.length&&(c.inboxTries=(c.inboxTries??0)+1)>=2){state.inbox=state.inbox.filter(i=>!inbox.includes(i));c.inboxTries=0;}
    }
    state.turns=(state.turns??0)+1;
    if(state.turns%EVOLVE_EVERY===0)await evolve(config,state).catch(error=>log('evolve_error',{agent:config.id,message:error.message}));
    if(!lm.online)return 'offline';
    await memory.save();
}

let round=0;
// Agents still thinking, by id. Turns carry over between rounds: a round never waits for its slowest agent,
// so agents on the fast model are not held up by a long plan on the other one.
const thinking=new Map(),lastTurn=new Map();
const minds=createMinds({act:(id,a)=>act(id,a),log,names:id=>configs.find(c=>c.id===id)?.name??id});
while(!stopping){
  round++;
  try {
    // Never spin: while the game connection is down, wait instead of looping (a pending reply must not
    // turn the loop into a busy-wait that starves the socket reader).
    if(!fresh()){await pause(1000);continue;}
    if(!lm.online){
      while(priority.length){const r=priority.shift(),c=configs.find(x=>x.id===r.id);if(c)await offlineReply(c,memory.agent(c),r);}
      await pause(1000);continue;
    }
    if(!lmReady){await lm.init();lmReady=true;log('lm_ready',lm.status());}
    const cap=()=>Math.max(1,Math.min(lm.capacity||1,Number(process.env.AGENT_CONCURRENCY||6)));
    if((life.tasks.length||civic.tasks.length)&&!thinking.has('~tasks')&&thinking.size<cap()){
      const t=runSettlementTask().catch(error=>log('task_error',{message:error.message}));thinking.set('~tasks',t);t.finally(()=>thinking.delete('~tasks'));
    }
    for(let next=0;next<configs.length||priority.length;){
      if(stopping||!fresh())break;
      const urgent=priority.shift();
      const config=urgent?configs.find(c=>c.id===urgent.id):configs[next++];
      const self=selfOf(config.id);if(!self)continue;
      const state=memory.agent(config),inbox=state.inbox.slice();
      if(urgent){minds.start(config.id,'addressed','reply');await quickReply(config,state,urgent).finally(()=>minds.stop(config.id)).catch(async error=>{if(isOffline(error))await offlineReply(config,state,urgent);else log('reply_error',{agent:config.id,message:error.message});});await memory.save();continue;}
      // A guardian fighting nearby mobs keeps its reflexes; it thinks again once things are calm.
      if(inCombat(config.id)||thinking.has(config.id))continue;
      // In survival mode the body comes first: no new plans until the crisis is over.
      if(intel?.motivation?.busy(config.id))continue;
      // Background roles (scribe, governor, merchant, crafter) think at most once every `every` minutes to share the model.
      if((config.every??1)>1&&!state.inbox.length&&Date.now()-(lastTurn.get(config.id)??0)<config.every*60000)continue;
      // Attention: plan with the model only when something calls for it; the behaviour machine carries on otherwise.
      const why=cognition.shouldThink(config,state,self);if(!why)continue;
      lastTurn.set(config.id,Date.now());
      // As many agents think at once as the online servers have slots (Muse 4 + Gemma 2 in teamwork mode);
      // AGENT_CONCURRENCY caps it.
      minds.start(config.id,why,'plan');
      const turn=jobCtx.run({agent:config.id,job:'model turn',model:true},()=>agentTurn(config,self,state,inbox,why)).catch(error=>{minds.end(config.id,{error:error.message.slice(0,200)});log('agent_error',{agent:config.id,message:error.message});});
      thinking.set(config.id,turn);turn.finally(()=>{thinking.delete(config.id);minds.stop(config.id);});
      if(thinking.size>=cap())await Promise.race(thinking.values());
      if(!lm.online)break;
    }
  }catch(error){if(!isOffline(error))log('runtime_error',{message:error.message});lmReady=false;}
  for(let slept=0;!stopping&&!priority.length&&slept<Number(process.env.LOOP_MS||2000);slept+=500)await pause(500);
}
await Promise.allSettled(thinking.values());
await memory.flush();log('stopped');


