// Intrinsic Motivation Engine (IME): the drives behind a citizen's own choices, layered on the rest of the
// intelligence stack (needs, the trust matrix, spatial memory, goal trees and the micro executor).
//
//   Survival   homeostasis over health, hunger, energy (0-100) and threat risk (0-1). A critical state preempts
//              the goal queue: every active goal is SUSPENDED (saved with its context) and a survival
//              subroutine runs (eat / ask a friend for food, nap, retreat to safety, seek the healer).
//   Curiosity  an ICM-style signal: the forward model's prediction error on action outcomes plus the novelty of
//              places, creatures and items (visit counts). High curiosity in a calm, idle moment becomes an
//              exploratory "hypothesis" goal (investigate a new creature, test a recipe, scout the least-known area).
//   Social     a directed bond graph (trust from the trust matrix + familiarity, shared history, alignment).
//              Theory of mind: a citizen notices a bonded peer in distress and helps (brings food, raises the
//              alarm). Cultural memes (recipes, norms, knowledge) spread between bonded citizens and fade.
//
// The orchestrator weighs the drives, W_s*D_s + W_c*D_c + W_so*D_so, to score candidate actions against the
// current goal. Goals created here run on the normal executor (goal milestones), so nothing bypasses the rules.
import {json} from './db.mjs';
import {RECIPES} from './executor.mjs';

const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
const round=(v,d=3)=>Math.round(v*10**d)/10**d;
export const EDIBLE=/^(BREAD|COOKED_[A-Z_]+|BAKED_POTATO|APPLE|CARROT|SWEET_BERRIES|MUSHROOM_STEW|PUMPKIN_PIE|GOLDEN_CARROT|MELON_SLICE)$/;

// ================================================================ survival ======================================
// Critical thresholds (preempt below/above these) and the recovery levels that end survival mode (hysteresis,
// so a citizen does not flip between eating and working at the boundary).
// Energy: rest at 20% and keep resting to 75% (skills/rest.mjs) - 15% -> 45% was a minute's rest, and citizens were
// back to "I need a rest before I drop" a few minutes later.
import {restInPlace} from '../skills/rest.mjs';
export const CRITICAL={health:35,hunger:25,energy:20,threat:0.7};
export const RECOVERED={health:60,hunger:55,energy:75,threat:0.3};
export const PREEMPT=0.75;   // survival drive at which goals are suspended (reached exactly at a critical threshold)
export const STABLE=0.35;    // below this the citizen is calm enough for curiosity and helping others
const DANGER={CREEPER:1,WARDEN:1,RAVAGER:1,EVOKER:0.9,VINDICATOR:0.8,WITCH:0.7,PILLAGER:0.7};

/**
 * Threat risk 0-1 from hostile mobs near `pos` (closer and more dangerous = higher; several combine like
 * independent risks), plus the town alert and night.
 */
export function threatOf(entities,pos,{hostile=new Set(),alert=null,night=false,radius=24}={}){
  let safe=1;
  for(const e of entities??[]){
    if(!hostile.has(e.type))continue;
    const d=Math.hypot(e.x-pos.x,e.z-pos.z);if(d>radius)continue;
    safe*=1-clamp((radius-d)/radius)*(DANGER[e.type]??0.6);
  }
  const base=1-safe,extra=(alert==='red'?0.3:alert==='yellow'?0.1:0)+(night?0.05:0);
  return round(clamp(base+extra*(1-base)));
}
/** The homeostatic state vector, all on 0-100 (100 = fully satisfied) plus threat 0-1. */
export function survivalVector({health,needs,threat=0}){
  return {health:round(clamp((health??20)/20,0,1)*100,1),hunger:round(clamp((needs?.hunger??20)/20,0,1)*100,1),
    energy:round(clamp(needs?.energy??100,0,100),1),threat:round(clamp(threat),3)};
}
// Squared deficit, scaled so that each need's urgency is exactly PREEMPT at its critical threshold.
const scale=k=>PREEMPT/((100-CRITICAL[k])/100)**2;
/** Urgency 0-1 of each need. */
export function urgencies(v){
  const u={};
  for(const k of ['health','hunger','energy'])u[k]=round(clamp(((100-v[k])/100)**2*scale(k)));
  u.threat=round(clamp((v.threat/CRITICAL.threat)**2*PREEMPT));
  return u;
}
const LOSS_W={health:1.2,hunger:1,energy:0.7,threat:1.5};
/** Homeostatic loss: weighted mean squared deviation from the set points (0 = all satisfied, 1 = all at worst). */
export function homeostaticLoss(v){
  const dev={health:(100-v.health)/100,hunger:(100-v.hunger)/100,energy:(100-v.energy)/100,threat:v.threat};
  const sum=Object.values(LOSS_W).reduce((a,b)=>a+b,0);
  return round(Object.entries(LOSS_W).reduce((s,[k,w])=>s+w*dev[k]**2,0)/sum);
}
/** Survival drive D_s: the most urgent need dominates (a starving citizen is not comforted by being well rested). */
export function survivalDrive(v){
  const u=urgencies(v),top=Math.max(...Object.values(u));
  return round(clamp(top+0.15*homeostaticLoss(v)*(1-top)));
}
/** Needs past their critical threshold, most urgent first. */
export function criticalNeeds(v){
  const u=urgencies(v);
  return Object.keys(u).filter(k=>k==='threat'?v.threat>=CRITICAL.threat:v[k]<=CRITICAL[k]).sort((a,b)=>u[b]-u[a]);
}
/** Every need back above its recovery level. */
export const recovered=v=>v.health>=RECOVERED.health&&v.hunger>=RECOVERED.hunger&&v.energy>=RECOVERED.energy&&v.threat<=RECOVERED.threat;

// ================================================================ curiosity =====================================
/** Novelty of something seen `count` times before: 1 for the first sight, fading with familiarity. */
export const noveltyOf=count=>round(1/Math.sqrt(1+Math.max(0,count)));
/**
 * Forward model update: predicted success p (EMA) and duration for an action kind; returns the prediction error
 * (0-1): surprise at the outcome plus surprise at how long it took.
 */
export function forwardUpdate(model,ok,ms,{alpha=0.2}={}){
  const m=model??{n:0,p:0.5,ms:null};
  const outcome=ok?1:0,errOutcome=Math.abs(outcome-m.p);
  const errTime=m.ms&&ms?clamp(Math.abs(Math.log((ms+1)/(m.ms+1)))/3):0;
  const error=round(m.n===0?0.5:clamp(0.8*errOutcome+0.2*errTime));
  return {error,model:{n:m.n+1,p:round(m.p+alpha*(outcome-m.p)),ms:ms?(m.ms?m.ms+alpha*(ms-m.ms):ms):m.ms}};
}
/** Curiosity drive D_c from recent novelty, prediction error, boredom and unexplained stimuli. */
export function curiosityDrive({novelty=0,predError=0,idleMinutes=0,stimuli=0}){
  const boredom=clamp(idleMinutes/90,0,0.35);
  return round(clamp(0.45*novelty+0.35*predError+boredom+(stimuli?0.2:0)));
}
/** Intrinsic reward multiplier: how much a curious citizen values an action that teaches it something. */
export const intrinsicMultiplier=(novelty,predError)=>round(1+novelty+predError,2);

// ================================================================ social ========================================
/** Affinity 0-1 of `source` toward `target` from the four bond dimensions (trust 0-100, familiarity 0-100, history count, alignment -1..1). */
export function affinityOf({trust=50,familiarity=0,shared_history=0,alignment=0}){
  return round(clamp(0.45*trust/100+0.25*familiarity/100+0.15*(1-Math.exp(-shared_history/10))+0.15*(alignment+1)/2));
}
// Memes: what spreads, how easily, and how fast it fades (half-life in hours) unless used or retold.
export const MEME_KINDS={recipe:{spread:0.5,halfLife:168},norm:{spread:0.4,halfLife:72},knowledge:{spread:0.35,halfLife:24}};
/** Chance that a meme held with `strength` passes to a receiver with `affinity` toward the sender. */
export const transmitProbability=(strength,affinity,kind,boost=1)=>round(clamp(strength*affinity*(MEME_KINDS[kind]?.spread??0.3)*boost));
/** Strength after `ms` without reinforcement. */
export const decayed=(strength,ms,kind)=>round(strength*2**(-ms/((MEME_KINDS[kind]?.halfLife??24)*3600000)),4);

// ================================================================ orchestrator ==================================
// Base weights by role: the scout and herbalist are the curious ones, the governor and courier the social ones.
export const ROLE_BIAS={scout:{curiosity:0.9},herbalist:{curiosity:0.7},fisher:{curiosity:0.65},governor:{social:0.9},courier:{social:0.85},merchant:{social:0.8,curiosity:0.4},
  guardian:{curiosity:0.25,social:0.8},builder:{curiosity:0.35},miner:{curiosity:0.55}};
export const BASE_WEIGHTS={survival:1,curiosity:0.5,social:0.7};
/**
 * Dynamic drive weights. Survival pressure crowds out the others (hungry citizens do not go sightseeing);
 * curiosity only gets room when survival is quiet. Raw weights score candidates; normalizeWeights is for display.
 */
export function driveWeights(D,base=BASE_WEIGHTS){
  return {survival:round(base.survival*(1+3*D.survival**2)),curiosity:round(base.curiosity*(1-D.survival)**2),social:round(base.social*(1-0.6*D.survival))};
}
export const normalizeWeights=W=>{const sum=W.survival+W.curiosity+W.social||1;return {survival:round(W.survival/sum),curiosity:round(W.curiosity/sum),social:round(W.social/sum)};};
/**
 * Utility of a candidate: sum over drives of W_i * D_i * gain_i, where gain_i (0-1) is how much of that drive
 * the candidate satisfies, plus its extrinsic value (commitments: a player's request, a promise, work in progress).
 */
export function utilityOf(candidate,D,W){
  const g=candidate.gains??{};
  return round((W.survival*D.survival*(g.survival??0)+W.curiosity*D.curiosity*(g.curiosity??0)+W.social*D.social*(g.social??0))+(candidate.extrinsic??0));
}
/** How much an active goal is worth keeping (who asked for it, how far along it is). */
export function commitmentOf(goal,progress=0){
  const src=String(goal?.source??'self');
  const base=src.startsWith('player:')?0.6:src==='altruism'?0.5:src==='curiosity'?0.25:0.35;
  return round(base+0.15*clamp(progress));
}
/**
 * The decision: the best candidate, or "continue" when nothing beats the current goal by the margin.
 * A survival drive at PREEMPT always wins (hard override from the spec).
 */
export function decide(candidates,D,W,{current=null,margin=0.1,floor=0.12}={}){
  const scored=candidates.map(c=>({...c,utility:utilityOf(c,D,W)})).sort((a,b)=>b.utility-a.utility);
  const survival=scored.find(c=>c.drive==='survival');
  if(survival&&D.survival>=PREEMPT)return {choice:survival,scored,reason:'survival override'};
  const best=scored[0];
  if(!best)return {choice:null,scored,reason:'no candidates'};
  if(current){const keep=commitmentOf(current.goal,current.progress);
    return best.utility>keep+margin?{choice:best,scored,reason:`${best.utility} > goal ${keep}+${margin}`}:{choice:null,scored,reason:`keeps goal (${keep})`};}
  return best.utility>=floor?{choice:best,scored,reason:`idle, ${best.utility} >= ${floor}`}:{choice:null,scored,reason:'nothing compelling'};
}

// ================================================================ the engine ====================================
// Explore only inside the loaded town area (chunks outside are not simulated).
export const BOUNDS={x1:72,x2:472,z1:-104,z2:296};   // 200 blocks around the town centre
const CELL=16;
// Entities that are not creatures (plugin holograms, dropped items, projectiles, vehicles, other players and NPC bodies).
export const NOT_CREATURE=/DISPLAY|ARMOR_STAND|^ITEM|ORB|ARROW|TRIDENT|MARKER|INTERACTION|FALLING|PAINTING|FRAME|BOAT|RAFT|MINECART|^PLAYER$|FIREWORK|SNOWBALL|EGG$|POTION|LEASH|FISHING_BOBBER/;
const cellOf=p=>`${Math.floor(p.x/CELL)},${Math.floor(p.z/CELL)}`;

export function createMotivation(d){
  const {db,social,goals,configs,memory,getSnapshot,log=()=>{},ledger=()=>{},say=async()=>{},act=async()=>{},travel,civic=()=>null,postOrder=()=>null,
    nameOf=id=>id,roleOf=id=>id,hostile=new Set(),isNight=()=>false,restSpot=()=>null,now=()=>Date.now(),rng=Math.random,bounds=BOUNDS}=d;
  const ids=()=>configs.map(c=>c.id);
  const stateOf=id=>memory.data.agents[id];
  const town=()=>memory.data.town??{};
  const mot=id=>{const s=stateOf(id);if(!s)return null;return s.motivation??={mode:null,stack:[],driveGoal:null,nap:false,novelty:0,predError:0,lastNovelty:null,lastIdle:null};};
  const cache=new Map();        // id -> latest drives
  const stimuli=new Map();      // id -> [{kind,key,x,z,at}]
  const helping=new Map();      // distressed peer -> {helper, until}
  const timers=new Map();
  const every=(k,ms)=>{const t=timers.get(k)??0;if(now()-t<ms)return false;timers.set(k,now());return true;};
  const event=(agent,drive,kind,detail,utility=null)=>{
    db.run('INSERT INTO motivation_events(agent,drive,kind,detail,utility,time) VALUES(?,?,?,?,?,?)',agent,drive,kind,String(detail).slice(0,240),utility,now());
    log('motivation',{agent,drive,kind,detail,utility});
  };

  // ---------------------------------------------------------------- perception
  const selfOf=id=>getSnapshot()?.agents?.find(a=>a.id===id)??null;
  function vectorOf(id,self=selfOf(id)){
    const s=stateOf(id);if(!s||!self)return null;
    return survivalVector({health:self.health,needs:s.needs,threat:threatOf(self.entities,self,{hostile,alert:town().alert?.level??null,night:isNight(getSnapshot()?.worldTime)})});
  }
  const edibleIn=inv=>Object.entries(inv??{}).filter(([k,n])=>EDIBLE.test(k)&&n>0);

  // ---------------------------------------------------------------- novelty memory
  /** Counts a sighting; returns its novelty (before counting). */
  function see(agent,kind,key,pos){
    const r=db.get('SELECT count FROM novelty WHERE agent=? AND kind=? AND key=?',agent,kind,key);
    const n=noveltyOf(r?.count??0);
    db.run(`INSERT INTO novelty(agent,kind,key,count,x,z,first_seen,last_seen) VALUES(?,?,?,1,?,?,?,?)
      ON CONFLICT(agent,kind,key) DO UPDATE SET count=count+1,last_seen=excluded.last_seen`,agent,kind,key,pos?Math.round(pos.x):null,pos?Math.round(pos.z):null,now(),now());
    return {novelty:n,first:!r};
  }
  const townCount=(kind,key)=>db.get('SELECT coalesce(sum(count),0) n FROM novelty WHERE kind=? AND key=?',kind,key).n;
  function observe(id,self){
    const m=mot(id);if(!m)return;
    // The very first look (a new citizen, or the engine's first run) is a baseline, not a surprise.
    const baseline=!db.get('SELECT 1 FROM novelty WHERE agent=? LIMIT 1',id);
    const cell=see(id,'cell',cellOf(self),self),seen=[{novelty:cell.novelty,first:false}];   // new ground is novel, but no surprise
    const types=new Map();for(const e of self.entities??[])if(!types.has(e.type)&&!NOT_CREATURE.test(e.type))types.set(e.type,e);
    for(const [type,e] of types){const r=see(id,'entity',type,e);seen.push(r);
      if(r.first&&!baseline&&!hostile.has(type))pushStimulus(id,{kind:'entity',key:type,x:Math.round(e.x),z:Math.round(e.z)});}
    for(const item of Object.keys(self.inventory??{})){const r=see(id,'item',item,null);seen.push(r);if(r.first&&!baseline)pushStimulus(id,{kind:'item',key:item});}
    if(baseline)return;
    const peak=Math.max(...seen.map(r=>r.novelty));
    // A first sighting is an orienting response (an immediate jump); familiar sights only nudge the average.
    m.novelty=round(Math.max(0.8*m.novelty+0.2*peak,seen.some(r=>r.first)?0.75*peak:0));
    if(peak>=0.7)m.lastNovelty=now();
  }
  function pushStimulus(id,st){const l=(stimuli.get(id)??[]).filter(x=>now()-x.at<600000&&x.key!==st.key);l.push({...st,at:now()});stimuli.set(id,l.slice(-5));}
  const liveStimuli=id=>(stimuli.get(id)??[]).filter(x=>now()-x.at<600000);

  // ---------------------------------------------------------------- forward model (called for every action)
  const TRIVIAL=new Set(['chat','status','emote','look','unstick']);
  function observeOutcome(id,action,ok,ms){
    if(!action||TRIVIAL.has(action.type)||!stateOf(id))return null;
    const key=`${action.type}:${String(action.target??'').toUpperCase().slice(0,40)}`;
    const row=db.get('SELECT * FROM forward_model WHERE agent=? AND key=?',id,key);
    const {error,model}=forwardUpdate(row&&{n:row.n,p:row.p,ms:row.ms},ok,ms);
    db.run(`INSERT INTO forward_model(agent,key,n,p,ms,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(agent,key) DO UPDATE SET n=excluded.n,p=excluded.p,ms=excluded.ms,updated=excluded.updated`,
      id,key,model.n,model.p,model.ms,now());
    const m=mot(id);m.predError=round(0.85*m.predError+0.15*error);
    // A successful craft is a recipe the citizen now knows (and can teach).
    if(ok&&action.type==='craft'&&action.target){const item=String(action.target).toUpperCase();see(id,'recipe',item,null);seedMeme(id,'recipe',`recipe:${item}`,`how to make ${item.toLowerCase().replace(/_/g,' ')}`,1);}
    return error;
  }

  // ---------------------------------------------------------------- social bonds
  const bond=(a,b)=>db.get('SELECT * FROM social_bonds WHERE source=? AND target=?',a,b)??{source:a,target:b,familiarity:0,shared_history:0,alignment:0};
  function bump(a,b,{familiarity=0,shared_history=0,alignment=0}){
    if(!a||!b||a===b)return;
    const o=bond(a,b);
    db.run(`INSERT INTO social_bonds(source,target,familiarity,shared_history,alignment,updated) VALUES(?,?,?,?,?,?)
      ON CONFLICT(source,target) DO UPDATE SET familiarity=excluded.familiarity,shared_history=excluded.shared_history,alignment=excluded.alignment,updated=excluded.updated`,
      a,b,round(clamp(o.familiarity+familiarity,0,100),2),round(o.shared_history+shared_history,2),round(clamp(o.alignment+alignment,-1,1),3),now());
  }
  const edge=(a,b)=>{const o=bond(a,b),t=social.view(a,b);return {trust:t.trust_score,reliability:t.reliability_score,familiarity:o.familiarity,shared_history:o.shared_history,alignment:o.alignment};};
  const affinity=(a,b)=>affinityOf(edge(a,b));
  /** Time spent near each other breeds familiarity. */
  function proximity(snap){
    const on=snap.agents.filter(a=>ids().includes(a.id));
    db.tx(()=>{for(let i=0;i<on.length;i++)for(let j=i+1;j<on.length;j++){
      const a=on[i],b=on[j],dd=Math.hypot(a.x-b.x,a.z-b.z);if(dd>8)continue;
      bump(a.id,b.id,{familiarity:0.4});bump(b.id,a.id,{familiarity:0.4});
      if(dd<=6&&every(`meet:${[a.id,b.id].sort()}`,120000)){exchange(a.id,b.id);exchange(b.id,a.id);}
    }});
  }
  /** Shared experiences from the trust log (conversations, deliveries, food, arguments) build shared history. */
  function history(){
    const last=Number(db.meta('ime_social_event')??0);
    const rows=db.all('SELECT * FROM social_events WHERE id>? ORDER BY id LIMIT 500',last);if(!rows.length)return;
    const agentSet=new Set(ids());
    db.tx(()=>{for(const r of rows){
      if(!agentSet.has(r.source_agent)||!agentSet.has(r.target_agent))continue;
      bump(r.source_agent,r.target_agent,{shared_history:1,familiarity:['conversation','argument'].includes(r.kind)?3:1});
      if(['conversation','argument'].includes(r.kind))for(const x of [r.source_agent,r.target_agent]){const mm=mot(x);if(mm)mm.lastSocial=Math.max(mm.lastSocial??0,r.time??now());}
      // A conversation is also where culture passes on (both ways, a little likelier than a chance meeting).
      if(r.kind==='conversation'&&every(`talk-meme:${[r.source_agent,r.target_agent].sort()}`,60000)){exchange(r.source_agent,r.target_agent,1.5);exchange(r.target_agent,r.source_agent,1.5);}
    }});
    db.meta('ime_social_event',rows.at(-1).id);
  }
  /** Voting alike on the charter aligns values; opposing votes pull apart. Each vote pair counts once. */
  function alignment(){
    const agentSet=new Set(ids());
    for(const p of memory.data.charter?.proposals??[]){
      const votes=Object.entries(p.votes??{}).filter(([k])=>agentSet.has(k));
      for(let i=0;i<votes.length;i++)for(let j=i+1;j<votes.length;j++){
        const [a,va]=votes[i],[b,vb]=votes[j];
        if(db.get('SELECT 1 FROM bond_votes WHERE proposal=? AND a=? AND b=?',String(p.id),a,b))continue;
        db.run('INSERT INTO bond_votes(proposal,a,b) VALUES(?,?,?)',String(p.id),a,b);
        const same=va===vb;
        for(const [x,y] of [[a,b],[b,a]]){const al=bond(x,y).alignment;bump(x,y,{alignment:same?0.15*(1-al):-0.15*(1+al)});}
      }
    }
  }
  /** Familiarity fades without contact (half-life two days). */
  function fade(ms){db.run('UPDATE social_bonds SET familiarity=round(familiarity*?,2)',2**(-ms/(48*3600000)));}

  // ---------------------------------------------------------------- memes
  function seedMeme(agent,kind,id,content,strength,origin=agent,via=null){
    const o=db.get('SELECT strength FROM memes WHERE agent=? AND meme_id=?',agent,id);
    if(o&&o.strength>=strength)return false;
    db.run(`INSERT INTO memes(agent,meme_id,kind,content,strength,origin,via,first_at,updated) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent,meme_id) DO UPDATE SET strength=excluded.strength,updated=excluded.updated`,agent,id,kind,String(content).slice(0,200),round(strength),origin,via,now(),now());
    return !o;
  }
  /** `from` shares its strongest memes with `to`; each passes with a chance set by strength and `to`'s affinity for `from`. */
  function exchange(from,to,boost=1){
    const aff=affinity(to,from);let n=0;
    for(const m of db.all('SELECT * FROM memes WHERE agent=? AND strength>=0.2 ORDER BY strength DESC LIMIT 5',from)){
      if(rng()>=transmitProbability(m.strength,aff,m.kind,boost))continue;
      // Recipes and norms are worth a line in the record; everyday knowledge spreads quietly.
      if(seedMeme(to,m.kind,m.meme_id,m.content,m.strength*(0.6+0.3*aff),m.origin,from)){n++;if(m.kind!=='knowledge')event(to,'social','meme_learned',`${m.kind}: ${m.content} (from ${nameOf(from)})`);}
    }
    return n;
  }
  /** Seeds from the world: adopted charter rules (their proposers) and what citizens learned in conversation. */
  function seedCulture(){
    for(const r of memory.data.charter?.rules??[])if(ids().includes(r.by))seedMeme(r.by,'norm',`norm:${r.id}`,r.text,1);
    // Knowledge learned in conversation is seeded once (then it fades unless retold).
    for(const id of ids())for(const l of stateOf(id)?.talk?.learned??[]){
      const key=`knowledge:${l.text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().slice(0,60)}`;
      if(db.get("SELECT 1 FROM novelty WHERE agent=? AND kind='meme' AND key=?",id,key))continue;
      see(id,'meme',key,null);
      const from=configs.find(c=>nameOf(c.id)===l.from||c.name===l.from)?.id??l.from;
      seedMeme(id,'knowledge',key,l.text,0.8,from,from);
    }
  }
  function decayMemes(ms){
    for(const m of db.all('SELECT agent,meme_id,kind,strength FROM memes')){
      const s=decayed(m.strength,ms,m.kind);
      if(s<0.05)db.run('DELETE FROM memes WHERE agent=? AND meme_id=?',m.agent,m.meme_id);else db.run('UPDATE memes SET strength=? WHERE agent=? AND meme_id=?',s,m.agent,m.meme_id);
    }
  }
  const beliefs=(id,n=4)=>db.all('SELECT kind,content,strength,origin FROM memes WHERE agent=? AND strength>=0.3 ORDER BY strength DESC LIMIT ?',id,n);
  const knows=(id,memeId)=>(db.get('SELECT strength FROM memes WHERE agent=? AND meme_id=?',id,memeId)?.strength??0)>=0.3;

  // ---------------------------------------------------------------- drives
  /** Theory of mind: the peers this citizen can perceive (nearby, or pleading on the order board) and their distress. */
  function perceivedPeers(id,self){
    const snap=getSnapshot();if(!snap||!self)return [];
    const pleading=new Set((d.board?.open()??[]).filter(o=>o.priority==='EMERGENCY').map(o=>o.issuer_name));
    return snap.agents.filter(p=>p.id!==id&&ids().includes(p.id)&&(Math.hypot(p.x-self.x,p.z-self.z)<=32||pleading.has(p.id))).map(p=>{
      const v=vectorOf(p.id,p);if(!v)return null;
      const e=edge(id,p.id);
      return {id:p.id,x:p.x,y:p.y,z:p.z,vector:v,distress:survivalDrive(v),critical:criticalNeeds(v),affinity:affinityOf(e),trust:e.trust,inventory:p.inventory};
    }).filter(Boolean);
  }
  function drives(id){
    const self=selfOf(id),m=mot(id),v=vectorOf(id,self);if(!v||!m)return null;
    const Ds=survivalDrive(v);
    const idleMinutes=m.lastIdle?(now()-m.lastIdle)/60000:0;
    const Dc=curiosityDrive({novelty:m.novelty,predError:m.predError,idleMinutes,stimuli:liveStimuli(id).length});
    const peers=perceivedPeers(id,self);
    const pull=Math.max(0,...peers.map(p=>p.affinity*p.distress));
    const lonely=clamp(((now()-(m.lastSocial??now()))/60000)/200,0,0.3);
    const Dso=round(clamp(pull+lonely));
    const role=roleOf(id),base=d.baseWeights?.(id)??{...BASE_WEIGHTS,...(ROLE_BIAS[role]??{})};
    const D={survival:Ds,curiosity:Dc,social:Dso},W=driveWeights(D,base);
    const contrib={survival:W.survival*Ds,curiosity:W.curiosity*Dc,social:W.social*Dso};
    const dominant=Object.entries(contrib).sort((a,b)=>b[1]-a[1])[0][0];
    const out={id,vector:v,loss:homeostaticLoss(v),critical:criticalNeeds(v),D,W,shares:normalizeWeights(W),dominant,multiplier:intrinsicMultiplier(m.novelty,m.predError),
      peers:peers.filter(p=>p.distress>=0.5).map(p=>({id:p.id,distress:p.distress,affinity:p.affinity,critical:p.critical})),stimuli:liveStimuli(id),mode:m.mode};
    cache.set(id,out);
    return out;
  }

  // ---------------------------------------------------------------- goal preemption
  /** Suspends every active goal (saving where it was) so a drive can take over. Returns what was suspended. */
  function suspendAll(id,drive,reason){
    const m=mot(id),out=[];
    for(let cur=goals.current(id);cur;cur=goals.current(id)){
      const g=cur.goal;
      const saved={by:drive,reason,at:now(),prevStatus:g.status,milestone:cur.milestone?.title??null,milestoneState:cur.milestone?.spec?.state??null,
        position:(()=>{const s=selfOf(id);return s?{x:Math.round(s.x),y:Math.round(s.y),z:Math.round(s.z)}:null;})(),inventory:selfOf(id)?.inventory??{}};
      const spec=json(g.spec_json,{})??{};
      db.run("UPDATE agent_goals SET status='SUSPENDED',spec_json=?,updated=? WHERE goal_id=?",JSON.stringify({...spec,suspended:saved,history:[...(spec.history??[]),{suspended:saved.at,by:drive,reason}].slice(-10)}),now(),g.goal_id);
      m.stack.push({goalId:g.goal_id,title:g.title,prevStatus:g.status,drive,reason,at:now()});out.push(g.title);
      if(g.goal_id===m.driveGoal)m.driveGoal=null;
    }
    if(out.length){event(id,drive,'goal_suspended',`${out.join('; ')} -> ${reason}`);ledger(id,`put aside "${out[0]}" to ${reason}`);}
    return out;
  }
  /** Resumes suspended goals (most recent first) with their saved state. */
  function resumeAll(id,why){
    const m=mot(id),back=[];
    while(m.stack.length){
      const e=m.stack.pop(),g=goals.get(e.goalId);
      if(!g||g.status!=='SUSPENDED')continue;
      const spec=json(g.spec_json,{})??{};const {suspended,...rest}=spec;
      db.run('UPDATE agent_goals SET status=?,spec_json=?,updated=? WHERE goal_id=?',suspended?.prevStatus??e.prevStatus??'IN_PROGRESS',JSON.stringify({...rest,history:[...(rest.history??[]),{resumed:now(),why}].slice(-10)}),now(),g.goal_id);
      back.push(g.title);
    }
    if(back.length){event(id,'orchestrator','goal_resumed',`${back.join('; ')} (${why})`);ledger(id,`went back to "${back.at(-1)}"`);}
    return back;
  }
  /** Goals left SUSPENDED without a record (e.g. after a restart) are resumed. */
  function orphanCheck(){
    for(const g of db.all("SELECT goal_id,agent,title,spec_json FROM agent_goals WHERE kind='goal' AND status='SUSPENDED'")){
      const m=mot(g.agent);if(!m||m.mode||m.stack.some(e=>e.goalId===g.goal_id))continue;
      const spec=json(g.spec_json,{})??{};
      db.run('UPDATE agent_goals SET status=?,updated=? WHERE goal_id=?',spec.suspended?.prevStatus??'IN_PROGRESS',now(),g.goal_id);
      event(g.agent,'orchestrator','goal_resumed',`${g.title} (orphaned suspension)`);
    }
  }

  // ---------------------------------------------------------------- survival subroutines
  const ready=(k,ms)=>every(k,ms);
  function survivalJob(c,s,self,need){
    const id=c.id,m=mot(id);
    if(need==='hunger')return async()=>{
      await civic()?.eatJob?.(c,s,self);
      const fresh=selfOf(id)??self;
      // Nothing to eat on hand or in the warehouse: ask the friend most likely to help who is carrying food.
      if(!edibleIn(fresh.inventory).length&&!Object.keys(civic()?.stockItems?.()??{}).some(k=>EDIBLE.test(k))&&ready(`ask-food:${id}`,300000)){
        const best=perceivedPeers(id,fresh).concat((getSnapshot()?.agents??[]).filter(p=>p.id!==id&&ids().includes(p.id)).map(p=>({id:p.id,inventory:p.inventory,affinity:affinity(id,p.id)})))
          .filter(p=>edibleIn(p.inventory).length).sort((a,b)=>b.affinity-a.affinity)[0];
        if(best){await say(id,`@${best.id}: I'm starving and there's no food in the warehouse. Could you spare something to eat?`);
          postOrder(id,edibleIn(best.inventory)[0][0],3,{note:'I am starving',priority:'EMERGENCY',preferred:best.id,targetLocation:'agent',reward:1});
          event(id,'survival','asked_for_food',`asked ${nameOf(best.id)} (affinity ${best.affinity})`);}
      }
    };
    if(need==='energy')return async()=>{
      const spot=restSpot(id);
      // Home far away, or down the mine, or three walks that got nowhere: rest where they are (the miner at 0 energy
      // 45 blocks down kept setting off for home and never rested at all).
      const inPlace=restInPlace(self,spot)||(m.napWalks??0)>=3;
      if(spot&&!inPlace&&Math.hypot(self.x-spot.x,self.z-spot.z)>4&&travel){m.nap=false;m.napWalks=(m.napWalks??0)+1;await travel(id,self,{x:spot.x,y:Math.round(self.y),z:spot.z}).catch(()=>{});return;}
      if(!m.nap){m.nap=true;m.napWalks=0;event(id,'survival','nap',spot&&!inPlace?'resting at home':'resting where they are');await say(id,'I need a rest before I drop.').catch(()=>{});}
    };
    if(need==='threat'||need==='health')return async()=>{
      const food=edibleIn(self.inventory)[0];
      if(need==='health'&&food&&ready(`heal-eat:${id}`,5000))await act(id,{type:'eat',x:0,y:0,z:0,target:food[0]}).catch(()=>{});
      const threats=(self.entities??[]).filter(e=>hostile.has(e.type)&&Math.hypot(e.x-self.x,e.z-self.z)<=24);
      let dest=null;
      if(threats.length){const cx=threats.reduce((s,e)=>s+e.x,0)/threats.length,cz=threats.reduce((s,e)=>s+e.z,0)/threats.length;
        const dx=self.x-cx,dz=self.z-cz,len=Math.hypot(dx,dz)||1;dest={x:self.x+dx/len*10,z:self.z+dz/len*10};
        if(ready(`warn:${id}`,60000)){const g=configs.find(x=>roleOf(x.id)==='guardian');await say(id,`${g?`@${g.id}: `:''}${threats.length} ${threats[0].type.toLowerCase().replace(/_/g,' ')}${threats.length>1?'s':''} near ${Math.round(self.x)},${Math.round(self.z)} - I'm falling back!`).catch(()=>{});}}
      else if(need==='health'){
        // Hurt but not under attack: go to the herbalist, who treats the injured near her.
        const h=getSnapshot()?.agents.find(a=>roleOf(a.id)==='herbalist');
        if(h&&Math.hypot(h.x-self.x,h.z-self.z)>4&&Math.hypot(h.x-self.x,h.z-self.z)<120)dest={x:h.x+1.5,z:h.z+1.5};
        else dest=restSpot(id);
      }
      if(dest&&travel){dest.x=clamp(dest.x,bounds.x1,bounds.x2);dest.z=clamp(dest.z,bounds.z1,bounds.z2);await travel(id,self,{x:dest.x,y:Math.round(self.y),z:dest.z}).catch(()=>{});}
    };
    return null;
  }

  // ---------------------------------------------------------------- candidates: curiosity and altruism
  function curiosityCandidates(id,self){
    const out=[],m=mot(id);
    // 1. A creature never seen before: go and look.
    for(const st of liveStimuli(id).filter(x=>x.kind==='entity')){
      const n=noveltyOf(townCount('entity',st.key)-1);
      out.push({drive:'curiosity',kind:'investigate',title:`Investigate the ${st.key.toLowerCase().replace(/_/g,' ')} near ${st.x},${st.z}`,gains:{curiosity:clamp(0.6+0.4*n)},
        milestones:[{type:'GOTO',x:st.x,z:st.z,title:`Approach the ${st.key.toLowerCase().replace(/_/g,' ')}`},
          {type:'SAY',text:`Went to look: there is a ${st.key.toLowerCase().replace(/_/g,' ')} around ${st.x},${st.z}. Worth remembering.`,title:'Share the finding'}],stimulus:st});
    }
    // 2. A recipe the citizen has the ingredients for but has never made (and nobody taught it): test it.
    const inv=self.inventory??{};
    for(const [item,r] of Object.entries(RECIPES)){
      if(r.smelt||knows(id,`recipe:${item}`))continue;
      const ing=Object.entries(r).filter(([k])=>!['out','smelt'].includes(k));
      if(!ing.length||!ing.every(([k,n])=>(inv[k]??0)>=n))continue;
      if(db.get('SELECT 1 FROM novelty WHERE agent=? AND kind=? AND key=?',id,'recipe',item))continue;
      out.push({drive:'curiosity',kind:'experiment',title:`Test whether I can make ${item.toLowerCase().replace(/_/g,' ')}`,gains:{curiosity:0.7},
        milestones:[{type:'CRAFT',item,quantity:r.out??1,title:`Try crafting ${item.toLowerCase().replace(/_/g,' ')}`},
          {type:'SAY',text:`Experiment: I made ${item.toLowerCase().replace(/_/g,' ')} from ${ing.map(([k,n])=>`${n} ${k.toLowerCase().replace(/_/g,' ')}`).join(' and ')}!`,title:'Tell the others'}]});
      break;
    }
    // 3. The least-known patch of the town area within reach: scout it.
    let best=null;
    const cx0=Math.floor((self.x-80-bounds.x1)/CELL)*CELL+bounds.x1+8,cz0=Math.floor((self.z-80-bounds.z1)/CELL)*CELL+bounds.z1+8;
    for(let x=Math.max(bounds.x1+8,cx0);x<=Math.min(bounds.x2,self.x+80);x+=CELL)for(let z=Math.max(bounds.z1+8,cz0);z<=Math.min(bounds.z2,self.z+80);z+=CELL){
      const dd=Math.hypot(x-self.x,z-self.z);if(dd>80||dd<12)continue;
      const visits=townCount('cell',cellOf({x,z})),score=noveltyOf(visits)-dd/400;
      if(!best||score>best.score)best={x,z,visits,score};
    }
    if(best&&best.visits<30&&m.novelty+m.predError>=0.5)out.push({drive:'curiosity',kind:'explore',title:`Scout the little-known area around ${best.x},${best.z}`,gains:{curiosity:clamp(0.3+0.6*noveltyOf(best.visits))},
      milestones:[{type:'GOTO',x:best.x,z:best.z,title:`Walk to ${best.x},${best.z}`},{type:'WAIT',minutes:1,title:'Look around'}]});
    for(const cnd of out)cnd.gains.curiosity=clamp(cnd.gains.curiosity*Math.min(1.5,m.novelty+m.predError+0.6));
    return out;
  }
  // Social gain is relative to the strongest pull the citizen feels, so W_so*D_so*gain = W_so*affinity*distress.
  function altruismCandidates(id,self,Dso=1){
    const out=[],mine=edibleIn(self.inventory),rel=p=>clamp(p.affinity*p.distress/Math.max(0.01,Dso));
    for(const p of perceivedPeers(id,self)){
      // Only for someone this citizen cares about: a strong bond overall, or deep trust on its own.
      if(p.distress<0.5||(p.affinity<0.45&&p.trust<75))continue;
      const claim=helping.get(p.id);if(claim&&claim.helper!==id&&claim.until>now())continue;
      const why=p.critical[0]??Object.entries(urgencies(p.vector)).sort((a,b)=>b[1]-a[1])[0][0];
      // Feeding people is the courier's and the chef's work: the essential workers (the medic, the trader, the clerk,
      // the vault keeper, the chef) keep to their posts - Rosa's rounds had become food runs (82 a day), not care.
      if(['hunger','health'].includes(why)&&mine.length&&!['herbalist','merchant','clerk','banker','chef'].includes(roleOf(id))){
        const [food,have]=mine.sort((a,b)=>b[1]-a[1])[0];
        out.push({drive:'social',kind:'share_food',peer:p.id,title:`Bring food to ${nameOf(p.id)}`,gains:{social:rel(p)},
          milestones:[{type:'DELIVER',item:food,quantity:Math.min(4,have),to:p.id,title:`Hand ${nameOf(p.id)} some ${food.toLowerCase().replace(/_/g,' ')}`},
            {type:'SAY',text:`Here, ${nameOf(p.id)} - eat something. We look after each other.`,title:'Comfort them'}]});
      }else if(why==='threat'){
        const g=configs.find(x=>roleOf(x.id)==='guardian');
        out.push({drive:'social',kind:'raise_alarm',peer:p.id,title:`Get help for ${nameOf(p.id)}`,gains:{social:rel(p)},
          milestones:[{type:'SAY',text:`${g?`@${g.id} `:''}${nameOf(p.id)} is in danger near ${Math.round(p.x)},${Math.round(p.z)}!`,title:'Raise the alarm'},
            {type:'GOTO',x:Math.round(clamp(p.x,bounds.x1,bounds.x2)),z:Math.round(clamp(p.z,bounds.z1,bounds.z2)),title:`Go to ${nameOf(p.id)}`}]});
      }
    }
    return out;
  }
  /** Starts a drive goal (suspending the current one if needed). */
  function launch(id,cand,decision){
    const m=mot(id);
    if(goals.current(id))suspendAll(id,cand.drive,cand.title.charAt(0).toLowerCase()+cand.title.slice(1));
    const g=goals.create(id,cand.title,{source:cand.drive==='social'?'altruism':'curiosity',milestones:cand.milestones});
    m.driveGoal=g.goal_id;m.driveGoalAt=now();
    if(cand.peer)helping.set(cand.peer,{helper:id,until:now()+600000});
    if(cand.drive==='curiosity')m.lastCuriosity=now();else m.lastAltruism=now();
    if(cand.stimulus)stimuli.set(id,liveStimuli(id).filter(x=>x.key!==cand.stimulus.key));
    event(id,cand.drive,cand.kind,`${cand.title} (${decision.reason})`,cand.utility);
    return g;
  }

  // ---------------------------------------------------------------- the per-tick decision
  /**
   * Called from the worker loop before the executor's jobs. Returns a survival subroutine (the agent does that
   * now) or null. May suspend/resume goals and start curiosity or altruism goals as a side effect.
   */
  function job(c,s,self,{night=false,busy=false,free=true}={}){
    const id=c.id,m=mot(id);if(!m||!self)return null;
    const dr=drives(id);if(!dr)return null;
    const guardian=roleOf(id)==='guardian';
    // A finished (or stale) drive goal hands control back to what was suspended.
    if(m.driveGoal){const g=goals.get(m.driveGoal);
      if(!g||['COMPLETED','FAILED'].includes(g.status)||now()-(m.driveGoalAt??0)>20*60000){
        if(g&&!['COMPLETED','FAILED'].includes(g.status))goals.cancel(g.goal_id);
        event(id,'orchestrator','drive_goal_ended',`${g?.title??'goal'}: ${g?.status??'gone'}`);m.driveGoal=null;if(!m.mode)resumeAll(id,'drive goal finished');}}
    // ---- survival: enter at a critical state, leave only once recovered (hysteresis).
    if(!m.mode&&dr.D.survival>=PREEMPT&&dr.critical.length){
      m.mode='survival';m.modeSince=now();m.need=dr.critical[0];
      suspendAll(id,'survival',{hunger:'find food',energy:'rest',health:'recover from injuries',threat:'get to safety'}[m.need]);
      event(id,'survival','preempt',`${m.need} ${m.need==='threat'?dr.vector.threat:dr.vector[m.need]} (D_s ${dr.D.survival})`,dr.D.survival);
    }
    if(m.mode==='survival'){
      if(recovered(dr.vector)){
        event(id,'survival','recovered',`after ${Math.round((now()-m.modeSince)/1000)} s`);m.mode=null;m.nap=false;resumeAll(id,'recovered');
      }else{
        m.need=dr.critical[0]??m.need;
        if(guardian&&m.need!=='energy')return null;   // the guardian's own combat and healing reflexes handle the rest
        if(m.need!=='energy')m.nap=false;
        return ready(`survive:${id}`,4000)?survivalJob(c,s,self,m.need):()=>Promise.resolve();
      }
    }
    // ---- calm: consider helping someone, or following curiosity.
    if(dr.D.survival>=STABLE||night||m.driveGoal||!every(`consider:${id}`,15000))return null;
    // Idle: nothing on (the town's own "free" status: role loops like fishing or brewing count as work).
    const idle=free&&!busy&&!s.contract&&!goals.current(id);
    if(idle)m.lastIdle??=now();else m.lastIdle=null;
    const cands=[];
    if(!guardian&&now()-(m.lastAltruism??0)>300000)cands.push(...altruismCandidates(id,self,dr.D.social));
    if(idle&&!guardian&&now()-(m.lastCuriosity??0)>15*60000&&dr.D.curiosity>=0.4)cands.push(...curiosityCandidates(id,self));
    if(!cands.length)return null;
    const cur=goals.current(id);
    const progress=cur?cur.milestones.filter(x=>x.status==='COMPLETED').length/Math.max(1,cur.milestones.length):0;
    // Busy with a contract or a project: only helping someone can interrupt.
    const allowed=busy||s.contract?cands.filter(x=>x.drive==='social'):cands;
    const dec=decide(allowed,dr.D,dr.W,{current:cur?{goal:cur.goal,progress}:(busy||s.contract?{goal:{source:'self'},progress:0}:null)});
    if(dec.choice){launch(id,dec.choice,dec);m.lastIdle=null;}
    return null;
  }

  // ---------------------------------------------------------------- periodic upkeep
  let lastFade=now(),lastDecay=now();
  function tick(){
    const snap=getSnapshot();if(!snap)return;
    if(every('observe',5000))try{db.tx(()=>{for(const a of snap.agents)if(ids().includes(a.id))observe(a.id,a);});}catch(e){log('motivation_error',{where:'observe',message:e.message});}
    if(every('proximity',30000))proximity(snap);
    if(every('history',20000))history();
    if(every('align',60000))alignment();
    if(every('culture',60000))seedCulture();
    if(every('orphans',120000))orphanCheck();
    if(now()-lastFade>600000){fade(now()-lastFade);lastFade=now();}
    if(now()-lastDecay>600000){decayMemes(now()-lastDecay);lastDecay=now();}
    for(const [k,v] of helping)if(v.until<now())helping.delete(k);
  }

  // ---------------------------------------------------------------- views
  /** For the planning prompt: what the citizen feels driven to do and what it believes. */
  function context(id){
    const dr=cache.get(id)??drives(id);if(!dr)return {};
    const m=mot(id),pct=v=>Math.round(v*100);
    return {motivation:{
      drives:`survival ${pct(dr.D.survival)}% · curiosity ${pct(dr.D.curiosity)}% · social ${pct(dr.D.social)}% (strongest: ${dr.dominant})`,
      body:`health ${Math.round(dr.vector.health)} · food ${Math.round(dr.vector.hunger)} · energy ${Math.round(dr.vector.energy)} · danger ${pct(dr.vector.threat)}%`,
      ...(m.mode?{urgent:`SURVIVAL: ${m.need} is critical - take care of it before anything else`}:{}),
      ...(m.stack.length?{onHold:m.stack.map(e=>e.title).slice(-2)}:{}),
      ...(dr.peers.length?{worriedAbout:dr.peers.map(p=>`${nameOf(p.id)} (${p.critical.join(', ')||'struggling'})`)}:{}),
      ...(dr.stimuli.length?{curiousAbout:dr.stimuli.map(x=>x.kind==='entity'?`a ${x.key.toLowerCase().replace(/_/g,' ')} near ${x.x},${x.z}`:`new item ${x.key.toLowerCase().replace(/_/g,' ')}`)}:{}),
      beliefs:beliefs(id).map(b=>b.kind==='recipe'?`knows ${b.content}`:b.content),
    }};
  }
  function dashboard(){
    const agents=ids().map(id=>{const dr=cache.get(id)??drives(id),m=mot(id);if(!dr)return {id,name:nameOf(id),offline:true};
      return {id,name:nameOf(id),role:roleOf(id),D:dr.D,W:dr.W,dominant:dr.dominant,vector:dr.vector,loss:dr.loss,critical:dr.critical,mode:m.mode,need:m.need,nap:m.nap,
        suspended:m.stack.map(e=>e.title),driveGoal:m.driveGoal?goals.get(m.driveGoal)?.title??null:null,multiplier:dr.multiplier,peers:dr.peers,stimuli:dr.stimuli.map(s=>s.key)};});
    const memes=db.all('SELECT meme_id,kind,max(content) content,count(*) holders,round(avg(strength),2) strength,max(origin) origin FROM memes GROUP BY meme_id ORDER BY holders DESC,strength DESC LIMIT 14');
    const bonds=db.all('SELECT * FROM social_bonds ORDER BY familiarity+shared_history DESC LIMIT 12').map(b=>({source:nameOf(b.source),target:nameOf(b.target),familiarity:b.familiarity,shared_history:b.shared_history,alignment:b.alignment,affinity:affinity(b.source,b.target)}));
    const events=db.all('SELECT * FROM motivation_events ORDER BY id DESC LIMIT 25').map(e=>({...e,name:nameOf(e.agent)}));
    return {agents,memes,bonds,events};
  }
  return {tick,job,drives,context,dashboard,observeOutcome,suspendAll,resumeAll,affinity,edge,exchange,seedMeme,beliefs,see,
    busy:id=>mot(id)?.mode==='survival',napping:id=>!!mot(id)?.nap,stimuli:liveStimuli};
}
