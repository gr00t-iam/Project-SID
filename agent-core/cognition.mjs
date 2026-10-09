// Cognitive engine: what a citizen senses, feels, values and remembers, when it bothers to think (call the
// model), and what it does on its own in between. Complements the intrinsic motivation engine (intel/motivation.mjs),
// which owns the drives (survival, curiosity, social) and goal preemption.
//
//   Perception   once per snapshot and citizen: who and what is near, hazards, weather and time of day, and the
//                chat it could actually hear (16 blocks), instead of every chat line in town.
//   Affect       morale and stress (0-100) moved by events (meals, praise, danger, failures, rain, company) and
//                drifting back to a personal baseline.
//   Values       a value matrix per citizen (self-preservation, community, craftsmanship, curiosity, sociability,
//                tradition), derived once from role and personality; it sets the motivation engine's weights.
//   Episodic     salient experiences (salience = feeling x novelty x social weight), recalled by who is present,
//   memory       where the citizen is and what it is doing, not just by recency.
//   Attention    the model is asked to plan only when something calls for it (a message, a voice nearby, a player
//                arriving, a failure, a change of day phase, a jolt of feeling, or a heartbeat), not every loop.
//   Behaviour    between plans a small state machine moves the citizen: shelter from rain, go home tired and nap,
//                gather at the market on market days, visit a friend when lonely; otherwise the usual idle wander.
import {isMarketDay} from './town.mjs';

const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,v));
const round=(v,d=1)=>Math.round(v*10**d)/10**d;
const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)/4294967295;};
export const HEARING=16;

// ================================================================ values ========================================
export const VALUE_KEYS=['selfPreservation','community','craftsmanship','curiosity','sociability','tradition'];
const ROLE_VALUES={
  guardian:{selfPreservation:0.35,community:0.9,craftsmanship:0.5,curiosity:0.3,sociability:0.45,tradition:0.75},
  builder:{selfPreservation:0.5,community:0.7,craftsmanship:0.9,curiosity:0.4,sociability:0.5,tradition:0.55},
  farmer:{selfPreservation:0.55,community:0.75,craftsmanship:0.7,curiosity:0.35,sociability:0.6,tradition:0.7},
  scout:{selfPreservation:0.45,community:0.55,craftsmanship:0.4,curiosity:0.9,sociability:0.6,tradition:0.3},
  miner:{selfPreservation:0.5,community:0.55,craftsmanship:0.75,curiosity:0.6,sociability:0.35,tradition:0.5},
  merchant:{selfPreservation:0.55,community:0.6,craftsmanship:0.5,curiosity:0.5,sociability:0.85,tradition:0.45},
  crafter:{selfPreservation:0.5,community:0.6,craftsmanship:0.9,curiosity:0.55,sociability:0.45,tradition:0.55},
  governor:{selfPreservation:0.5,community:0.9,craftsmanship:0.45,curiosity:0.45,sociability:0.8,tradition:0.75},
  scribe:{selfPreservation:0.55,community:0.7,craftsmanship:0.6,curiosity:0.7,sociability:0.55,tradition:0.85},
  fisher:{selfPreservation:0.5,community:0.65,craftsmanship:0.6,curiosity:0.65,sociability:0.6,tradition:0.55},
  courier:{selfPreservation:0.5,community:0.75,craftsmanship:0.45,curiosity:0.5,sociability:0.8,tradition:0.45},
  smith:{selfPreservation:0.5,community:0.65,craftsmanship:0.95,curiosity:0.4,sociability:0.4,tradition:0.7},
  herbalist:{selfPreservation:0.5,community:0.85,craftsmanship:0.7,curiosity:0.75,sociability:0.65,tradition:0.6},
};
const WORDS={selfPreservation:/cautious|careful|wary|prudent|anxious|nervous/,community:/loyal|dutiful|protective|devoted|civic|caring|kind|generous/,
  craftsmanship:/meticulous|diligent|precise|skilled|proud of (his|her|their) work|perfectionist|hard.?working/,curiosity:/curious|inquisitive|adventurous|explor|wonder/,
  sociability:/friendly|chatty|cheerful|warm|outgoing|talkative|sociable|gregarious/,tradition:/traditional|orderly|rule|proper|old.?fashioned|dutiful|steady/};
/** The value matrix (0-1 each): role template, nudged by personality words, plus a small stable personal twist. */
export function deriveValues(id,role,personality=''){
  const base=ROLE_VALUES[role]??Object.fromEntries(VALUE_KEYS.map(k=>[k,0.5])),text=String(personality).toLowerCase();
  return Object.fromEntries(VALUE_KEYS.map(k=>[k,round(Math.max(0.05,Math.min(0.98,base[k]+(WORDS[k].test(text)?0.12:0)+(hash(id+k)-0.5)*0.16)),2)]));
}
/** Motivation weights from values: caution feeds survival, curiosity feeds curiosity, community+sociability feed social. */
export const valueWeights=v=>({survival:round(0.7+0.6*v.selfPreservation,2),curiosity:round(0.15+0.85*v.curiosity,2),social:round(0.3+0.7*(v.community+v.sociability)/2,2)});
export const topValues=(v,n=3)=>Object.entries(v).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,x])=>`${k.replace(/[A-Z]/g,c=>' '+c.toLowerCase())} ${x}`);

// ================================================================ affect ========================================
// Changes per event (who is affected is decided by onLog).
export const AFFECT={
  ate:{morale:2,stress:-3},meal_missed:{morale:-3,stress:5},rested:{morale:3,stress:-8},
  conversation:{morale:3,stress:-3},argument:{morale:-4,stress:6},gift_received:{morale:8,stress:-4},gift_given:{morale:4,stress:-1},
  befriended:{morale:5,stress:-3},fell_out:{morale:-5,stress:6},achievement:{morale:8,stress:-5},small_success:{morale:1,stress:-1},
  failure:{morale:-2,stress:3},gave_up:{morale:-6,stress:6},danger:{morale:-3,stress:14},hurt:{morale:-5,stress:12},
  player_talk:{morale:4,stress:-2},vandalism:{morale:-6,stress:6},victory:{morale:6,stress:-4},
};
export const baselineOf=v=>({morale:round(50+25*(v.sociability-0.5)+15*(v.community-0.5),1),stress:round(25+20*(v.selfPreservation-0.5),1)});
export function applyAffect(a,kind,scale=1){const e=AFFECT[kind];if(!e)return a;return {morale:round(clamp(a.morale+e.morale*scale)),stress:round(clamp(a.stress+e.stress*scale))};}
/** Drift toward the baseline (half-life 30 minutes). */
export function driftAffect(a,base,ms){const k=1-2**(-ms/1800000);return {morale:round(a.morale+(base.morale-a.morale)*k),stress:round(a.stress+(base.stress-a.stress)*k)};}
export function feelingOf({morale,stress}){
  if(stress>=70)return morale<40?'overwhelmed':'on edge';
  if(morale>=70)return stress<30?'content':'driven';
  if(morale<35)return stress>=45?'miserable':'glum';
  return stress>=50?'uneasy':'steady';
}

// ================================================================ episodic memory ===============================
/** Salience 0-1 from how strongly it was felt, how new it was, and how much it involved others. */
export const salienceOf=({emotion=0,novelty=0,social=0})=>round(Math.min(1,0.45*Math.min(1,emotion)+0.25*novelty+0.3*social),2);
/** Recall score: salience, recency (half-life 6 h) and relevance to the present cue. */
export function recallScore(m,cue,now){
  const recency=2**(-(now-m.t)/(6*3600000));
  let rel=0;
  if(cue.who?.length&&m.who?.some(w=>cue.who.includes(w)))rel+=1;
  if(cue.where&&m.where&&Math.hypot(m.where.x-cue.where.x,m.where.z-cue.where.z)<=24)rel+=0.5;
  if(cue.words?.length&&cue.words.some(w=>m.text.toLowerCase().includes(w)))rel+=0.3;
  return round(0.45*m.salience+0.35*recency+0.2*Math.min(1,rel),3);
}
const MEMORY_CAP=60;

// ================================================================ perception ====================================
export function phaseOf(worldTime){
  if(!Number.isFinite(worldTime))return 'day';
  const t=((worldTime%24000)+24000)%24000;
  return t<1000||t>=23000?'dawn':t<11500?'day':t<13000?'dusk':'night';
}
/** What one citizen can perceive in a snapshot. chats: [{time,from,text,x,z}]; players: [{name,x,y,z}]. */
export function perceive(self,snap,{ids=[],hostile=new Set(),chats=[],players=[],since=0,now=Date.now(),hearing=HEARING,aliases=[self.id]}={}){
  const d=p=>Math.round(Math.hypot(p.x-self.x,p.z-self.z));
  const citizens=(snap?.agents??[]).filter(a=>a.id!==self.id&&ids.includes(a.id)).map(a=>({id:a.id,d:d(a)})).filter(a=>a.d<=32).sort((a,b)=>a.d-b.d);
  const near=(players??[]).filter(p=>Number.isFinite(p.x)).map(p=>({name:p.name,d:d(p)})).filter(p=>p.d<=32).sort((a,b)=>a.d-b.d);
  const ents=self.entities??[];
  const hostiles=ents.filter(e=>hostile.has(e.type)).map(e=>({type:e.type,d:d(e)})).sort((a,b)=>a.d-b.d);
  const creatures=[...new Set(ents.filter(e=>!hostile.has(e.type)&&!/DISPLAY|ARMOR_STAND|^ITEM|ORB|ARROW|^PLAYER$/.test(e.type)).map(e=>e.type))];
  const feet=(self.blocks??[]).find(b=>b.x===Math.floor(self.x)&&b.y===Math.floor(self.y)&&b.z===Math.floor(self.z));
  const hazards=[...(feet?.type==='WATER'?['in water']:[]),...((self.blocks??[]).some(b=>b.type==='LAVA'&&Math.hypot(b.x-self.x,b.z-self.z)<=4)?['lava close']:[]),
    ...(hostiles.some(h=>h.d<=8)?[`${hostiles[0].type.toLowerCase()} ${hostiles[0].d} blocks away`]:[])];
  // Addressed: the line names this citizen (id or first name) as a word.
  const named=text=>aliases.some(a=>new RegExp(`(^|[^a-z0-9_])@?${String(a).toLowerCase().replace(/[^a-z0-9_]/g,'')}([^a-z0-9_]|$)`).test(String(text).toLowerCase()));
  const heard=chats.filter(c=>c.time>since&&c.from!==self.id&&(c.x==null||Math.hypot(c.x-self.x,c.z-self.z)<=hearing)).map(c=>({from:c.from,text:c.text,time:c.time,player:!ids.includes(c.from),addressed:named(c.text)}));
  const weather=snap?.weather?.thunder?'thunderstorm':snap?.weather?.storm?'rain':'clear';
  return {citizens,players:near,hostiles,creatures,hazards,weather,phase:phaseOf(snap?.worldTime),heard,time:now};
}

// ================================================================ attention =====================================
/**
 * Whether a citizen should plan with the model now, and why (null = let the behaviour machine carry on).
 * Messages always count; other reasons respect a minimum gap; the heartbeat keeps everyone thinking now and then.
 */
export function reasonToThink({inbox=0,percept,cog,affect,resting=false,every=1,now=Date.now(),heartbeatMs=300000,restingHeartbeatMs=600000,minGapMs=15000,lastError=null}){
  const since=now-(cog.lastThink??0);
  if(inbox>0)return 'message';
  if(since<minGapMs)return null;
  // Hearing: being spoken to wakes the mind at once, a player talking nearby after 30 s. Citizens chatting among
  // themselves are only heard at the next thought (as a trigger they start endless chains of replies).
  const heard=percept?.heard??[];
  if(heard.some(h=>h.addressed))return 'addressed';
  if(heard.some(h=>h.player)&&since>=30000)return 'heard';
  const newPlayer=(percept?.players??[]).find(p=>p.d<=12&&now-(cog.metPlayers?.[p.name]??0)>120000);
  if(newPlayer)return `encounter:${newPlayer.name}`;
  if(resting)return since>=restingHeartbeatMs?'heartbeat':null;
  if(lastError&&lastError.time>(cog.lastThink??0)&&now-lastError.time>=20000)return 'failure';
  // Dawn and dusk change what a citizen should be doing; the switch into full day or night does not need a thought.
  if(cog.lastPhase&&percept?.phase&&percept.phase!==cog.lastPhase&&['dawn','dusk'].includes(percept.phase))return `phase:${percept.phase}`;
  if(affect&&cog.affectAtThink&&(Math.abs(affect.morale-cog.affectAtThink.morale)>=15||Math.abs(affect.stress-cog.affectAtThink.stress)>=15))return 'feeling';
  if((percept?.hostiles??[]).some(h=>h.d<=10)&&now-(cog.lastDanger??0)>60000)return 'danger';
  return since>=Math.max(heartbeatMs,every>1?every*60000:0)?'heartbeat':null;
}

// ================================================================ the engine ====================================
export function createCognition(d){
  const {configs,memory,getSnapshot,hostile=new Set(),chats=()=>[],players=()=>[],homeOf=()=>null,homeBuilt=()=>false,travel,log=()=>{},
    intel=()=>null,civic=()=>null,now=()=>Date.now(),env=process.env,random=Math.random,market={x:278.5,z:105.5}}=d;
  const ids=()=>configs.map(c=>c.id);
  const conf=id=>configs.find(c=>c.id===id);
  const stateOf=id=>memory.data.agents[id];
  const vandalSeen=new Map();
  // One-time repair (v1): moods driven to the floor by the vandalism bug above go back to each citizen's baseline.
  if(!memory.data.affectResetV1){memory.data.affectResetV1=true;
    for(const cfg of configs){const s=stateOf(cfg.id);if(s?.affect){const v=s.values??deriveValues(cfg.id,cfg.role??cfg.id,cfg.personality);Object.assign(s.affect,baselineOf(v));}}}
  const gating=env.THINK_GATING!=='false';
  const heartbeatMs=Number(env.THINK_HEARTBEAT_MS||300000);
  const stats={thinks:{},skipped:0,since:now()};
  const cog=s=>s.cog??={lastThink:0,metPlayers:{}};
  function valuesOf(id){const s=stateOf(id),c=conf(id);if(!s||!c)return null;
    return s.values??=deriveValues(id,c.role??id,c.personality??s.personality??'');}
  function affectOf(id){const s=stateOf(id),v=valuesOf(id);if(!s||!v)return null;return s.affect??={...baselineOf(v),updated:now()};}
  function feel(id,kind,scale=1){const s=stateOf(id);if(!s||!AFFECT[kind])return;const a=affectOf(id);Object.assign(a,applyAffect(a,kind,scale),{updated:now()});}

  // ---------------------------------------------------------------- episodic memory
  function remember(id,{text,who=[],tags=[],emotion=0,novelty=0,social=0,valence=0}){
    const s=stateOf(id);if(!s)return;
    const self=getSnapshot()?.agents?.find(a=>a.id===id);
    const m={t:now(),day:memory.data.town?.day??null,text:String(text).slice(0,160),who:who.filter(Boolean),where:self?{x:Math.round(self.x),z:Math.round(self.z)}:null,tags,
      salience:salienceOf({emotion,novelty,social}),valence};
    if(m.salience<0.25)return;
    const list=(s.memories??=[]);
    // The same thing again soon after is one memory, a little stronger.
    const dup=list.find(x=>x.text===m.text&&m.t-x.t<3600000);
    if(dup){dup.salience=round(Math.min(1,dup.salience+0.05),2);dup.t=m.t;return;}
    list.push(m);
    if(list.length>MEMORY_CAP){const t=now();list.sort((a,b)=>recallScore(b,{},t)-recallScore(a,{},t));list.length=MEMORY_CAP;list.sort((a,b)=>a.t-b.t);}
  }
  function recall(id,cue={},n=3){
    const t=now();
    return (stateOf(id)?.memories??[]).map(m=>({m,score:recallScore(m,cue,t)})).sort((a,b)=>b.score-a.score).slice(0,n).map(({m})=>m);
  }
  const nameOf=id=>conf(id)?.name?.split(' the ')[0]??id;

  // ---------------------------------------------------------------- events -> feelings and memories
  function onLog(type,data={}){
    try{
      switch(type){
        case 'ate':feel(data.agent,'ate');if(data.restorative)feel(data.agent,'rested',0.5);break;   // a restorative broth calms
        case 'dialogue':{const bad=/disagree|argument/.test(data.topic??'');
          for(const [x,y] of [[data.a,data.b],[data.b,data.a]]){feel(x,bad?'argument':'conversation');remember(x,{text:`${bad?'Argued':'Talked'} with ${nameOf(y)} about ${data.topic}`,who:[y],tags:['talk'],emotion:bad?0.5:0.25,social:0.6});}
          break;}
        case 'reply':feel(data.agent,'player_talk');remember(data.agent,{text:`${data.to} talked to me; I said: ${data.text}`,who:[data.to],tags:['player'],emotion:0.35,social:0.9});break;
        case 'trade':if(data.kind==='give'&&data.to&&data.agent){
          if(stateOf(data.to)){feel(data.to,'gift_received');remember(data.to,{text:`${nameOf(data.agent)} gave me ${data.count??''} ${String(data.item??'').toLowerCase().replace(/_/g,' ')}`,who:[data.agent],tags:['gift'],emotion:0.6,social:0.9,valence:1});}
          if(stateOf(data.agent))feel(data.agent,'gift_given');}
          break;
        case 'social_shift':{const rank={HOSTILE:0,SUSPICIOUS:1,NEUTRAL:2,FRIENDLY:3},good=(rank[data.to]??2)>(rank[data.from]??2);
          feel(data.source,good?'befriended':'fell_out');
          remember(data.source,{text:`I now see ${nameOf(data.target)} as ${String(data.to).toLowerCase()} (${String(data.kind??'').replace(/_/g,' ')})`,who:[data.target],tags:['relationship'],emotion:0.6,social:1,valence:good?1:-1});break;}
        case 'goal_completed':feel(data.agent,'achievement');remember(data.agent,{text:`Finished: ${data.goal}`,tags:['achievement'],emotion:0.7,novelty:0.3});break;
        case 'project_done':feel(data.agent,data.stalled?'failure':'achievement');if(!data.stalled)remember(data.agent,{text:`Completed ${data.summary}`,tags:['achievement'],emotion:0.6,novelty:0.3});break;
        case 'milestone_done':case 'dig_done':case 'farm_tended':case 'cooked':feel(data.agent,'small_success');break;
        case 'agent_error':feel(data.agent,'failure');break;
        case 'reflection_gave_up':feel(data.agent,'gave_up');remember(data.agent,{text:`Gave up on ${data.subject?.startsWith?.('free:')?'what I was trying':'a task'} after repeated ${String(data.type??'failures').replace('Exception','').toLowerCase()} problems`,tags:['failure'],emotion:0.5});break;
        case 'resting':feel(data.agent,'rested');break;
        case 'guardian_attack':if(data.target_health===0){feel(data.agent,'victory');remember(data.agent,{text:`Defeated a ${String(data.target).toLowerCase()}`,tags:['fight'],emotion:0.5,novelty:0.2});}break;
        case 'vandalism':{
          // Every block broken used to upset the whole town - 139 blocks of the mayor's own landscaping left every
          // citizen "overwhelmed". The mayor's edits upset nobody; anyone else's spree is one upset (per 10 minutes)
          // for the citizens close enough to see it.
          const who=String(data.player??'').toLowerCase();
          if(who&&who===String(memory.data.town?.mayor??'').toLowerCase())break;
          if(now()-(vandalSeen.get(who)??0)<600000)break;vandalSeen.set(who,now());
          const snap=getSnapshot(),b=data.block;
          for(const id of ids()){const a=snap?.agents?.find(x=>x.id===id);if(!b||(a&&Math.hypot(a.x-b.x,a.z-b.z)<=32))feel(id,'vandalism');}
          break;}
        case 'motivation':
          if(data.kind==='preempt'){feel(data.agent,/threat|health/.test(data.detail)?'danger':'meal_missed');remember(data.agent,{text:`Crisis: ${data.detail.replace(/\(D_s.*\)/,'').trim()}`,tags:['survival'],emotion:0.9,novelty:0.4});}
          if(data.kind==='share_food'||data.kind==='raise_alarm')remember(data.agent,{text:data.detail.replace(/\(.*\)$/,'').trim(),tags:['helped'],emotion:0.5,social:0.9,valence:1});
          if(data.kind==='investigate'||data.kind==='experiment')remember(data.agent,{text:data.detail.replace(/\(.*\)$/,'').trim(),tags:['curiosity'],emotion:0.3,novelty:0.9});
          break;
      }
    }catch{/* feelings never break the log */}
  }

  // ---------------------------------------------------------------- perception (cached per snapshot)
  const percepts=new Map();
  function perceptOf(id,since){
    const snap=getSnapshot(),self=snap?.agents?.find(a=>a.id===id);if(!self)return null;
    const key=`${id}:${since}`,c=percepts.get(key);if(c&&c.snap===snap)return c.p;
    const p=perceive(self,snap,{ids:ids(),hostile,chats:chats(),players:players(),since,now:now(),aliases:[id,nameOf(id)]});
    percepts.set(key,{snap,p});if(percepts.size>200)percepts.clear();
    return p;
  }

  // ---------------------------------------------------------------- attention
  /** Why this citizen should call the model now, or null. */
  function shouldThink(config,state,self){
    const c=cog(state);
    if(!gating)return 'always';
    const p=perceptOf(config.id,c.lastThink??0);
    const lastEp=state.episodes?.at(-1);
    const why=reasonToThink({inbox:state.inbox?.length??0,percept:p,cog:c,affect:affectOf(config.id),resting:!!state.resting,every:config.every??1,now:now(),heartbeatMs,
      lastError:lastEp?.error?{time:lastEp.time}:null});
    if(!why)stats.skipped++;
    return why;
  }
  /** Records that the citizen is thinking now (so the same reason does not fire again). */
  function noteThought(config,state,why){
    const c=cog(state),p=perceptOf(config.id,c.lastThink??0);
    c.lastThink=now();c.lastPhase=p?.phase??c.lastPhase;c.affectAtThink={...affectOf(config.id)};
    for(const pl of p?.players??[])if(pl.d<=12)c.metPlayers[pl.name]=now();
    if(why==='danger')c.lastDanger=now();
    const k=String(why).split(':')[0];stats.thinks[k]=(stats.thinks[k]??0)+1;
  }

  // ---------------------------------------------------------------- behaviour machine (only when otherwise idle)
  const within=(self,p,r)=>Math.hypot(self.x-p.x,self.z-p.z)<=r;
  const spotNear=(p,r)=>{const a=random()*Math.PI*2,rr=1.5+random()*r;return {x:Math.round((p.x+Math.cos(a)*rr)*2)/2,z:Math.round((p.z+Math.sin(a)*rr)*2)/2};};
  function linger(c,until,at,why){c.linger={until,at,why};}
  /** A contextual job for an idle citizen, or null (the plain idle wander then runs). */
  function idleJob(config,state,self,{night=false}={}){
    const id=config.id,c=cog(state),snap=getSnapshot(),t=now(),role=config.role??id;
    if(night||role==='guardian'||state.order)return null;
    const s=state,v=valuesOf(id),energy=s.needs?.energy??100,home=homeOf(id)&&homeBuilt(id)?{x:homeOf(id).cx,z:homeOf(id).cz}:null;
    const go=(dest,why)=>async()=>{c.doing=why;if(!self.pathing&&!within(self,dest,2.5))await travel(id,self,{x:dest.x,y:Math.round(self.y),z:dest.z}).catch(()=>{});};
    // Finish a nap: rested, or no longer at home.
    if(s.motivation?.nap&&!s.motivation.mode&&(energy>=80||(home&&!within(self,home,4)))){s.motivation.nap=false;c.doing=null;}
    // 1. Rain: every citizen with a roof goes under it (the busy ones are handled by their own loops).
    // A thunderstorm, or the first 5 minutes of rain (after that, life goes on in the rain).
    if(!snap?.weather?.storm)c.rainSince=null;else c.rainSince??=t;
    if(snap?.weather?.storm&&(snap.weather.thunder||t-c.rainSince<300000)&&home&&!s.project){c.doing='sheltering from the rain';return within(self,home,2.5)?()=>Promise.resolve():go(home,'sheltering from the rain');}
    // 2. Tired (not yet critical): home for a nap in the day.
    if(energy<30&&home){
      if(!within(self,home,3))return go(home,'going home to rest');
      if(s.motivation&&!s.motivation.nap){s.motivation.nap=true;log('behaviour',{agent:id,what:'nap',energy:Math.round(energy)});}
      c.doing='napping';return ()=>Promise.resolve();
    }
    // Lingering somewhere on purpose (market, a friend's side): stay until it is time to move on.
    if(c.linger&&t<c.linger.until){c.doing=c.linger.why;return within(self,c.linger.at,4)?()=>Promise.resolve():go(c.linger.at,c.linger.why);}
    c.linger=null;
    // 3. Market day, late morning to afternoon: the sociable drift to the market for a while.
    const tod=((snap?.worldTime??6000)%24000+24000)%24000,town=memory.data.town??{};
    if(isMarketDay(town.day??1)&&tod>=2000&&tod<=10000&&t-(c.lastMarket??0)>20*60000&&random()<0.3+0.6*v.sociability){
      c.lastMarket=t;const at=spotNear(market,5);linger(c,t+90000+random()*90000,at,'browsing the market');log('behaviour',{agent:id,what:'market'});return go(at,'browsing the market');
    }
    // 4. Lonely: visit the friend this citizen feels closest to (not someone busy far away).
    const lonelyMin=(t-(s.motivation?.lastSocial??c.lastVisit??t-3600000))/60000;
    if(lonelyMin>=20&&v.sociability>=0.45&&t-(c.lastVisit??0)>15*60000){
      const ime=intel()?.motivation;
      // Not someone already surrounded: joining a crowd just piles people up.
      const crowdAround=a=>(snap?.agents??[]).filter(o=>o.id!==a.id&&o.id!==id&&within(o,a,3)).length;
      const friend=(snap?.agents??[]).filter(a=>a.id!==id&&ids().includes(a.id)&&within(self,a,80)&&!within(self,a,4)&&crowdAround(a)<2)
        .map(a=>({a,aff:ime?.affinity?.(id,a.id)??0})).filter(x=>x.aff>=0.4).sort((x,y)=>y.aff-x.aff)[0];
      if(friend){c.lastVisit=t;const at=spotNear(friend.a,2);linger(c,t+60000,at,`visiting ${nameOf(friend.a.id)}`);
        log('behaviour',{agent:id,what:'visit',friend:friend.a.id,affinity:friend.aff});return go(at,`visiting ${nameOf(friend.a.id)}`);}
    }
    c.doing=null;return null;
  }

  // ---------------------------------------------------------------- periodic upkeep
  let last=now();
  function tick(){
    const t=now(),ms=t-last;if(ms<5000)return;last=t;
    const snap=getSnapshot();
    for(const cfg of configs){
      const s=stateOf(cfg.id);if(!s)continue;
      const a=affectOf(cfg.id),base=baselineOf(valuesOf(cfg.id)),self=snap?.agents?.find(x=>x.id===cfg.id);
      Object.assign(a,driftAffect(a,base,ms));
      // Continuous pressures: hunger and exhaustion, danger nearby, being out in the rain.
      const hunger=s.needs?.hunger??20,energy=s.needs?.energy??100,min=ms/60000;
      let stress=0,morale=0;
      if(hunger<8)stress+=1.5*min;if(energy<25)stress+=1*min;
      if(self&&(self.entities??[]).some(e=>hostile.has(e.type)&&Math.hypot(e.x-self.x,e.z-self.z)<=12))stress+=4*min;
      if(snap?.weather?.storm&&!s.resting&&!(homeOf(cfg.id)&&homeBuilt(cfg.id)&&self&&within(self,{x:homeOf(cfg.id).cx,z:homeOf(cfg.id).cz},3)))morale-=0.4*min;
      a.stress=round(clamp(a.stress+stress));a.morale=round(clamp(a.morale+morale));a.updated=t;
    }
  }

  // ---------------------------------------------------------------- views
  /** For the planning prompt (compact). */
  function context(config,state,self){
    const id=config.id,c=cog(state),p=perceptOf(id,Math.max(0,(c.lastThink??0)-120000)),a=affectOf(id),v=valuesOf(id);
    const who=[...(p?.citizens??[]).filter(x=>x.d<=16).map(x=>x.id),...(p?.players??[]).filter(x=>x.d<=16).map(x=>x.name),...(state.inbox??[]).map(i=>i.from)];
    const words=String(state.goal??'').toLowerCase().split(/\W+/).filter(w=>w.length>4).slice(0,6);
    const recalled=recall(id,{who,where:self,words},3);
    return {
      feeling:a?{word:feelingOf(a),morale:Math.round(a.morale),stress:Math.round(a.stress)}:undefined,
      values:v?topValues(v):undefined,
      senses:p?{weather:p.weather,phase:p.phase,near:[...p.citizens.slice(0,5).map(x=>`${x.id} ${x.d}m`),...p.players.slice(0,3).map(x=>`${x.name} (player) ${x.d}m`)],
        ...(p.hostiles.length?{danger:p.hostiles.slice(0,3).map(h=>`${h.type.toLowerCase()} ${h.d}m`)}:{}),...(p.hazards.length?{hazards:p.hazards}:{}),...(p.creatures.length?{creatures:p.creatures.slice(0,4)}:{})}:undefined,
      recalled:recalled.map(m=>`${m.day!=null?`day ${m.day}: `:''}${m.text}`),
      ...(c.doing?{doingOnYourOwn:c.doing}:{}),
    };
  }
  /** What a citizen hears: local chat for the prompt (keeps the "chat" key the prompt expects). */
  function heardChat(config,state,n=8){
    const self=getSnapshot()?.agents?.find(a=>a.id===config.id);if(!self)return [];
    return chats().filter(ch=>ch.x==null||Math.hypot(ch.x-self.x,ch.z-self.z)<=HEARING||String(ch.text).toLowerCase().includes(config.id)).slice(-n).map(({time,from,text})=>({time,from,text}));
  }
  function view(id){
    const s=stateOf(id);if(!s)return null;
    const a=affectOf(id),v=valuesOf(id);
    return {affect:a?{morale:Math.round(a.morale),stress:Math.round(a.stress),word:feelingOf(a)}:null,values:v,doing:s.cog?.doing??null,
      memories:(s.memories??[]).slice().sort((x,y)=>y.salience-x.salience).slice(0,6).map(m=>({text:m.text,day:m.day,salience:m.salience,valence:m.valence,tags:m.tags}))};
  }
  const attention=()=>({...stats,minutes:Math.round((now()-stats.since)/60000)});
  return {tick,onLog,shouldThink,noteThought,idleJob,context,heardChat,view,attention,valuesOf,affectOf,remember,recall,perceptOf,feel,
    baseWeights:id=>{const v=valuesOf(id);return v?valueWeights(v):null;}};
}
