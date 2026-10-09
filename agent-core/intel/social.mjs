// Module 5: dynamic social relationship and trust matrix. Directional: how `source` sees `target`.
// trust (0-100): goodwill and faith in the other; reliability (0-100): do they keep their word.
// Replaces the old symmetric friendship scores (migrated once: trust = 50 + 4 x old score).

export const DEFAULT_TRUST=50,DEFAULT_RELIABILITY=50;
const clamp=v=>Math.max(0,Math.min(100,Math.round(v*10)/10));
/** FRIENDLY / NEUTRAL / SUSPICIOUS / HOSTILE from the two scores. */
export function labelFor(trust,reliability){
  if(trust<20)return 'HOSTILE';
  if(trust<40||reliability<40)return 'SUSPICIOUS';
  if(trust>=65&&reliability>=50)return 'FRIENDLY';
  return 'NEUTRAL';
}
// Standard adjustments from the spec.
export const EFFECTS={
  order_fulfilled:{trust:5,reliability:10},      // issuer about the contractor who delivered
  food_shared:{trust:5,reliability:10},          // receiver about the giver
  order_failed:{trust:-10,reliability:-15},      // issuer about the contractor who did not deliver
  order_withdrawn:{trust:-4,reliability:-6},     // issuer about a contractor who honestly handed a job back early
  starvation_ignored:{trust:-10,reliability:-15},// hungry agent about the one who ignored the request
  paid_on_time:{trust:2,reliability:5},          // contractor about the issuer who paid
  payment_missed:{trust:-10,reliability:-15},    // contractor about the issuer who did not pay
  bumped:{trust:-0.5,reliability:0},             // someone kept standing in my way (at most every 30 minutes per pair)
};
// Grudges and favours: the lasting memory behind the scores (relationships[a][b].grudges / .favors). Each one also moves
// trust when it happens (impact -1..1 -> up to 20 points) and fades from the affinity over time (half-life a day).
export const MARK_FROM_EVENT={order_fulfilled:['favor',0.25,'delivered what I asked for'],food_shared:['favor',0.3,'shared food with me'],
  paid_on_time:['favor',0.1,'paid me on time'],order_failed:['grudge',-0.3,'let me down on a job'],payment_missed:['grudge',-0.35,'never paid me'],
  starvation_ignored:['grudge',-0.45,'ignored me when I was starving'],theft:['grudge',-0.6,'stole from the town']};
export const MARK_HALF_LIFE_MS=24*3600000;
/** The relationship as -1..1 numbers plus its grudges and favours (marks: rows of relationship_marks). */
export function relationshipOf(view,marks=[],now=Date.now()){
  const fade=m=>m.impact*2**(-(now-m.time)/MARK_HALF_LIFE_MS);
  const trust=Math.max(-1,Math.min(1,(view.trust_score-50)/50));
  const felt=marks.reduce((s,m)=>s+fade(m),0);
  const affinity=Math.max(-1,Math.min(1,0.5*trust+felt));
  const list=kind=>marks.filter(m=>m.kind===kind).slice(-8).map(m=>({reason:m.reason,impact:Math.round(m.impact*100)/100,timestamp:new Date(m.time).toISOString()}));
  return {trust:Math.round(trust*100)/100,affinity:Math.round(affinity*100)/100,grudges:list('grudge'),favors:list('favor')};
}
// Like people, relationships drift back toward a baseline when nothing happens: grudges fade and so do unkept
// friendships. Half-life 6 hours of real time (several town days).
export const DRIFT_HALF_LIFE_MS=6*3600000;
/** Where trust settles for a pair: neighbours start warm; familiarity and a community-minded nature raise it. */
export const baselineTrust=({familiarity=0,community=0.5}={})=>Math.max(40,Math.min(75,55+0.15*familiarity+20*(community-0.5)));
/**
 * Will `contractor` take a job from someone it sees with these scores? Refuses the hostile and those it
 * distrusts deeply; asks half the reward up front from anyone with reliability under 40.
 */
export function contractTerms(view){
  if(view.affinity_label==='HOSTILE'||view.trust_score<25)return {accept:false,upfront:0,reason:`does not trust them (trust ${Math.round(view.trust_score)})`};
  if(view.reliability_score<40)return {accept:true,upfront:0.5,reason:`wants half up front (reliability ${Math.round(view.reliability_score)})`};
  return {accept:true,upfront:0,reason:'normal terms'};
}

export function createSocial(db,{now=()=>Date.now(),log=()=>{}}={}){
  const row=(s,t)=>db.get('SELECT * FROM social_matrix WHERE source_agent=? AND target_agent=?',s,t);
  const view=(s,t)=>row(s,t)??{source_agent:s,target_agent:t,trust_score:DEFAULT_TRUST,reliability_score:DEFAULT_RELIABILITY,affinity_label:labelFor(DEFAULT_TRUST,DEFAULT_RELIABILITY),last_updated:null};
  function set(s,t,trust,reliability){
    const label=labelFor(trust,reliability);
    db.run(`INSERT INTO social_matrix(source_agent,target_agent,trust_score,reliability_score,affinity_label,last_updated) VALUES(?,?,?,?,?,?)
      ON CONFLICT(source_agent,target_agent) DO UPDATE SET trust_score=excluded.trust_score,reliability_score=excluded.reliability_score,affinity_label=excluded.affinity_label,last_updated=excluded.last_updated`,
      s,t,trust,reliability,label,now());
    return label;
  }
  /** Changes how `source` sees `target`; kind names the reason (see EFFECTS) and is kept in the event log. */
  function adjust(source,target,{trust=0,reliability=0},kind='interaction',note=''){
    if(!source||!target||source===target)return null;
    const v=view(source,target),before=v.affinity_label;
    const t=clamp(v.trust_score+trust),r=clamp(v.reliability_score+reliability);
    const label=set(source,target,t,r);
    db.run('INSERT INTO social_events(source_agent,target_agent,kind,trust_delta,reliability_delta,note,time) VALUES(?,?,?,?,?,?,?)',source,target,kind,trust,reliability,String(note).slice(0,200),now());
    if(label!==before)log('social_shift',{source,target,from:before,to:label,trust:t,reliability:r,kind});
    return {trust:t,reliability:r,label};
  }
  const apply=(source,target,kind,note)=>{const r=adjust(source,target,EFFECTS[kind],kind,note);const m=MARK_FROM_EVENT[kind];if(m&&r)remember(source,target,m[0],note?`${m[2]} (${String(note).slice(0,60)})`:m[2],m[1]);return r;};
  /** Records a grudge or favour (no trust change: for events that already moved trust). */
  function remember(source,target,kind,reason,impact){
    if(!source||!target||source===target)return;
    db.run('INSERT INTO relationship_marks(source_agent,target_agent,kind,reason,impact,time) VALUES(?,?,?,?,?,?)',source,target,kind,String(reason).slice(0,120),impact,now());
  }
  /** A grudge or favour that also moves trust (impact -1..1 -> up to 20 trust points). */
  function mark(source,target,kind,reason,impact){
    if(!source||!target||source===target)return null;
    const size=Math.min(1,Math.abs(impact)),signed=kind==='grudge'?-size:size;
    remember(source,target,kind,reason,signed);
    log(kind==='grudge'?'grudge':'favor',{source,target,reason,impact:signed});
    return adjust(source,target,{trust:signed*20,reliability:signed*8},kind,reason);
  }
  const marksOf=(s,t)=>db.all('SELECT * FROM relationship_marks WHERE source_agent=? AND target_agent=? ORDER BY time',s,t);
  /** relationships[a][b] = {trust, affinity (-1..1), grudges, favors}. */
  const relationship=(a,b)=>relationshipOf(view(a,b),marksOf(a,b),now());
  const relationships=ids=>Object.fromEntries(ids.map(a=>[a,Object.fromEntries(ids.filter(b=>b!==a).map(b=>[b,relationship(a,b)]))]));
  /** Both directions at once (shared experiences: chats, arguments, votes). */
  const adjustPair=(a,b,deltas,kind,note)=>{adjust(a,b,deltas,kind,note);adjust(b,a,deltas,kind,note);};
  /**
   * Moves every relationship part of the way back to its baseline (trust to baselineOf(source,target), reliability
   * to 55) for the time elapsed. Not logged as events: it is the passage of time, not something that happened.
   */
  function drift(ms,baselineOf=()=>DEFAULT_TRUST+5){
    const k=1-2**(-ms/DRIFT_HALF_LIFE_MS);if(k<=0)return 0;let changed=0;
    db.tx(()=>{for(const r of matrix()){
      const b=baselineOf(r.source_agent,r.target_agent),t=clamp(r.trust_score+(b-r.trust_score)*k),rel=clamp(r.reliability_score+(55-r.reliability_score)*k);
      if(Math.abs(t-r.trust_score)>=0.05||Math.abs(rel-r.reliability_score)>=0.05){set(r.source_agent,r.target_agent,t,rel);changed++;}
    }});
    return changed;
  }
  /**
   * Rebuilds the matrix from the event log (oldest first, from DEFAULT scores), skipping events for which
   * skip(event) is true, with the drift applied between events. For repairs after a bug polluted the log.
   */
  function rebuild(skip=()=>false,baselineOf=()=>DEFAULT_TRUST+5){
    const state=new Map();
    const stmt=db.raw.prepare('SELECT source_agent,target_agent,kind,trust_delta,reliability_delta,time FROM social_events ORDER BY id');
    for(const e of (typeof stmt.iterate==='function'?stmt.iterate():stmt.all())){
      if(skip(e)||!e.source_agent||!e.target_agent||e.source_agent===e.target_agent)continue;
      const k=`${e.source_agent}|${e.target_agent}`,s=state.get(k)??{t:DEFAULT_TRUST,r:DEFAULT_RELIABILITY,at:e.time};
      const f=1-2**(-Math.max(0,e.time-s.at)/DRIFT_HALF_LIFE_MS),b=baselineOf(e.source_agent,e.target_agent);
      s.t=clamp(s.t+(b-s.t)*f+(e.trust_delta??0));s.r=clamp(s.r+(55-s.r)*f+(e.reliability_delta??0));s.at=e.time;state.set(k,s);
    }
    db.tx(()=>{for(const [k,s] of state){const [a,b]=k.split('|');const f=1-2**(-Math.max(0,now()-s.at)/DRIFT_HALF_LIFE_MS),base=baselineOf(a,b);
      set(a,b,clamp(s.t+(base-s.t)*f),clamp(s.r+(55-s.r)*f));}});
    return state.size;
  }
  /** One-time import of the old symmetric scores (-10..10). */
  function migrate(affinity){
    if(db.meta('social_migrated'))return 0;
    let n=0;
    db.tx(()=>{for(const [key,score] of Object.entries(affinity??{})){const [a,b]=key.split('|');if(!a||!b)continue;
      const t=clamp(DEFAULT_TRUST+Number(score)*4);set(a,b,t,DEFAULT_RELIABILITY);set(b,a,t,DEFAULT_RELIABILITY);n++;}});
    db.meta('social_migrated',new Date(now()).toISOString());
    return n;
  }
  /** The old -10..10 scale for a pair (mean of both directions), for code that still thinks in friends and rivals. */
  const pairScore=(a,b)=>Math.max(-10,Math.min(10,Math.round(((view(a,b).trust_score+view(b,a).trust_score)/2-50)/4*10)/10));
  /** Friends (FRIENDLY) and rivals (SUSPICIOUS/HOSTILE) as seen by `id`, strongest first. */
  function relationsOf(id){
    const rows=db.all('SELECT * FROM social_matrix WHERE source_agent=?',id);
    const score=r=>Math.round((r.trust_score-50)/4*10)/10;
    return {
      friends:rows.filter(r=>r.affinity_label==='FRIENDLY').sort((a,b)=>b.trust_score-a.trust_score).map(r=>({id:r.target_agent,score:score(r),trust:r.trust_score,reliability:r.reliability_score})),
      rivals:rows.filter(r=>['SUSPICIOUS','HOSTILE'].includes(r.affinity_label)).sort((a,b)=>a.trust_score-b.trust_score).map(r=>({id:r.target_agent,score:score(r),trust:r.trust_score,reliability:r.reliability_score,label:r.affinity_label})),
    };
  }
  /** Compact vector for prompts: how `source` sees each of `others`. */
  const vectors=(source,others)=>Object.fromEntries(others.filter(o=>o!==source).map(o=>{const v=view(source,o);return [o,{trust:Math.round(v.trust_score),reliability:Math.round(v.reliability_score),feeling:v.affinity_label.toLowerCase()}];}));
  const matrix=()=>db.all('SELECT * FROM social_matrix ORDER BY source_agent,target_agent');
  const events=(limit=30)=>db.all('SELECT * FROM social_events ORDER BY id DESC LIMIT ?',limit);
  const pairsAbove=(limit=12)=>{
    const seen=new Map();
    for(const r of matrix()){const k=[r.source_agent,r.target_agent].sort().join('|');seen.set(k,(seen.get(k)??0)+(r.trust_score-50)/4/2);}
    return [...seen].map(([k,v])=>({pair:k.replace('|',' & '),score:Math.round(v*10)/10})).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)).slice(0,limit);
  };
  return {view,adjust,apply,mark,remember,relationship,relationships,marksOf,adjustPair,drift,rebuild,migrate,pairScore,relationsOf,vectors,matrix,events,pairsAbove,terms:(contractor,issuer)=>contractTerms(view(contractor,issuer))};
}
