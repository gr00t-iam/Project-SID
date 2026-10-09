// Town justice: timestamped conflicts, complaints, the sheriff's investigation, trials before the magistrate (the
// governor), sentences and the jail.
//
//   incident ─► conflict {conflict_id, timestamp (ISO 8601), tick, party_a, party_b, location, reason, status OPEN}
//      │          witnesses nearby are recorded as timestamped sightings; who really started it is kept hidden
//      ▼
//   complaint (a party, or the treasury for a theft) ─► INVESTIGATE_DISPUTE quest for the sheriff
//      ▼
//   investigation: the sheriff walks to the scene, takes statements (with the times people claim) and checks the records
//      ▼
//   trial (scheduled at the town hall): the magistrate lays the evidence out by timestamp; a claim contradicted by a
//   sighting at the same minute is a lie; the earliest provocation marks who started it; a record of the treasury
//   being opened names the thief.  Verdict ─► dismissed | reconcile | fine + community service | jail   (status TRIED)
//      ▼
//   sentence served / fine paid / pardoned ─► status RESOLVED
//
// Contract cases (court v2): a work order the contractor let run past its deadline can be taken to court by its
// issuer. The order board is the evidence (claimed at, deadline, delivered count, advance paid); no investigation is
// needed. The judge (roles/judge.mjs) summons the parties to the courthouse, hears them - a defendant who claims
// a delivery the ledger does not show is caught out - and fines the party at fault, paid to the plaintiff through
// the bank. A fine nobody can pay yet stays on the court's ledger and is collected from the account later.
//
// Pure functions (schema, evidence, sentencing, the jail clock) are exported for tests; createJustice() runs it in town.

import {needsJury,selectJury,jurorVote,tally,keyFact} from './jury.mjs';
export const STATUS=['OPEN','TRIED','RESOLVED'];
export const TICKS_PER_SECOND=20;
export const DAY_TICKS=24000;
const SCENE=16;              // blocks: a witness this close saw it
const SAME_MOMENT=120000;    // ms: a sighting this close in time contradicts a claim to be elsewhere
const iso=t=>new Date(t).toISOString();
const clock=t=>iso(t).slice(11,19);
const near=(p,q,r)=>p&&q&&Number.isFinite(p.x)&&Number.isFinite(q.x)&&Math.hypot(p.x-q.x,p.z-q.z)<=r;
const round=p=>p?{x:Math.round(p.x),y:Math.round(p.y??64),z:Math.round(p.z)}:null;

/** A new conflict in the court's schema (with the old field names kept for the rest of the town code). */
export function newConflict({n,party_a,party_b,reason,location=null,tick=null,time=Date.now(),kind='dispute',day=null,truth={},extra={}}){
  return {conflict_id:`C-${String(n).padStart(3,'0')}`,timestamp:iso(time),tick,party_a,party_b,location:round(location),reason,status:'OPEN',kind,
    evidence:[{kind:'incident',by:'record',about:null,timestamp:iso(time),tick,location:round(location),text:`${reason}`}],
    complaint:null,investigation:null,trial:null,verdict:null,truth,...extra,
    // the names the rest of the town code uses
    id:String(n),a:party_a,b:party_b,topic:reason,day,resolved:false};
}
/** Brings an old {id,a,b,topic,day,resolved} conflict into the schema. Quarrels over a week old have cooled off. */
export function migrateConflict(old,{now=Date.now(),day=old.day??0,dayMs=1200000,square=null}={}){
  if(old.conflict_id)return old;
  const age=Math.max(0,(day??0)-(old.day??day)),time=now-age*dayMs;
  const c=newConflict({n:Number(old.id)||0,party_a:old.a,party_b:old.b,reason:old.topic,location:square,tick:(old.day??0)*DAY_TICKS,time,day:old.day});
  c.evidence[0].text+=' (recorded before the court kept timestamps; time estimated from the day)';
  if(old.resolved){c.status='RESOLVED';c.resolved=true;c.resolution=old.resolution??'settled';}
  else if(age>7){c.status='RESOLVED';c.resolved=true;c.resolution='cooled off over time';}
  return c;
}
/** Adds a piece of evidence (timestamps as ISO 8601). Returns it. */
export function addEvidence(conflict,{kind,by,about=null,time=Date.now(),tick=null,location=null,text,claim=null}){
  const e={kind,by,about,timestamp:iso(time),tick,location:round(location),text:String(text).slice(0,200),
    ...(claim?{claim:{...(claim.place?{place:round(claim.place)}:{}),at:iso(claim.at??time),...(claim.delivered!=null?{delivered:claim.delivered}:{})}}:{})};
  conflict.evidence.push(e);return e;
}
export function fileComplaint(conflict,{by,text,time=Date.now(),tick=null}){
  if(conflict.status!=='OPEN')throw Error(`${conflict.conflict_id} is already ${conflict.status.toLowerCase()}`);
  conflict.complaint={by,text:String(text).slice(0,200),timestamp:iso(time),tick};
  addEvidence(conflict,{kind:'complaint',by,about:by===conflict.party_a?conflict.party_b:conflict.party_a,time,tick,text});
  return conflict.complaint;
}
export function scheduleTrial(conflict,{time=Date.now(),delayMs=180000,place}){
  conflict.trial={scheduled_at:iso(time+delayMs),at:time+delayMs,place:round(place),held:false};
  return conflict.trial;
}

/**
 * What the magistrate concludes from the evidence, by timestamp. Returns {fault: party|'both'|null, confidence 0-1,
 * scores, findings:[text], timeline:[evidence sorted by time]}. priors: {id: earlier convictions}.
 */
export function weighEvidence(conflict,{priors={}}={}){
  if(conflict.kind==='contract'&&conflict.order)return weighContract(conflict,{priors});
  const T=Date.parse(conflict.timestamp),scene=conflict.location;
  const parties=[conflict.party_a,conflict.party_b],score=Object.fromEntries(parties.map(p=>[p,0])),findings=[];
  const ev=[...conflict.evidence].sort((x,y)=>Date.parse(x.timestamp)-Date.parse(y.timestamp));
  const at=e=>Date.parse(e.timestamp);
  // Sightings at the scene around the time of the incident.
  const seen=p=>ev.filter(e=>e.kind==='sighting'&&e.about===p&&Math.abs(at(e)-T)<=5*60000&&(!scene||!e.location||near(e.location,scene,SCENE)));
  // 1. Alibis contradicted by a sighting at the same moment: a lie.
  for(const p of parties){
    for(const s of ev.filter(e=>e.kind==='statement'&&e.by===p&&e.claim?.place)){
      const claimAt=Date.parse(s.claim.at);if(Math.abs(claimAt-T)>5*60000)continue;
      if(scene&&near(s.claim.place,scene,SCENE))continue;   // claims to have been there: no alibi
      const contra=seen(p).find(x=>Math.abs(at(x)-claimAt)<=SAME_MOMENT);
      if(contra){score[p]+=2.5;findings.push(`${p} said they were at ${s.claim.place.x},${s.claim.place.z} at ${clock(claimAt)}, but ${contra.by} saw them at the scene at ${clock(at(contra))}`);}
      else findings.push(`${p} says they were elsewhere at ${clock(claimAt)}; nothing contradicts it`);
    }
  }
  // 2. Who started it: the earliest provocation on record.
  const first=ev.find(e=>e.kind==='provocation'&&parties.includes(e.about));
  if(first){score[first.about]+=1.5;findings.push(first.by===first.about?`${first.about} admitted starting it at ${clock(at(first))}`:`${first.by} saw ${first.about} start it at ${clock(at(first))}`);
    const second=ev.find(e=>e.kind==='provocation'&&e.about&&e.about!==first.about&&parties.includes(e.about));
    if(second&&at(second)-at(first)<60000){score[second.about]+=1;findings.push(`${second.about} answered in kind at ${clock(at(second))}`);}}
  // 3. Records (the treasury ledger, the sheriff's findings).
  for(const r of ev.filter(e=>['record','finding'].includes(e.kind)&&parties.includes(e.about))){
    score[r.about]+=r.kind==='record'?3:1;findings.push(r.by==='record'?`the records show ${r.text} at ${clock(at(r))}`:`${r.by} reports ${r.text.replace(/^the sheriff's report /,'')}`);
  }
  // 4. A theft with the suspect seen near the scene.
  if(conflict.kind==='theft')for(const p of parties){const s=seen(p);if(s.length){score[p]+=1;findings.push(`${p} was seen near the ${conflict.scene??'scene'} at ${clock(at(s[0]))} by ${s[0].by}`);}}
  // 5. Earlier convictions weigh a little.
  for(const p of parties)if(priors[p]){score[p]+=0.5*Math.min(3,priors[p]);findings.push(`${p} has ${priors[p]} earlier conviction${priors[p]>1?'s':''}`);}
  const [x,y]=parties,lead=score[x]-score[y];
  let fault=null;
  if(Math.abs(lead)>=1.5)fault=lead>0?x:y;
  else if(score[x]>=1.5&&score[y]>=1.5)fault='both';
  const confidence=fault==='both'?0.5:Math.min(1,Math.abs(lead)/4);
  if(!fault)findings.push('the evidence does not show who was at fault');
  return {fault,confidence:Math.round(confidence*100)/100,scores:score,findings,timeline:ev};
}

/** The sentence for a verdict. Jail terms in game ticks (20 a second; a game day is 24000). */
export const CONTRACT_FINE=5;
/**
 * A contract case is decided on the order board's record: delivered in full -> dismissed; short at the deadline ->
 * the contractor is at fault. A sworn statement claiming more than the record shows is false testimony.
 */
export function weighContract(conflict,{priors={}}={}){
  const o=conflict.order,plaintiff=conflict.party_a,def=conflict.party_b,score={[plaintiff]:0,[def]:0},findings=[];
  const timeline=[...conflict.evidence].sort((x,y)=>Date.parse(x.timestamp)-Date.parse(y.timestamp));
  const short=o.delivered<o.quantity,lateBy=o.deadline&&o.checked_at?Math.max(0,o.checked_at-o.deadline):0;
  if(!short){findings.push(`the order board shows order #${o.number} delivered in full (${o.delivered}/${o.quantity} ${label(o.item)})`);
    return {fault:null,confidence:0.9,scores:score,findings,timeline,falseTestimony:false};}
  score[def]+=3;
  findings.push(`the order board shows ${def} claimed order #${o.number} at ${clock(o.claimed_at)} with a deadline of ${clock(o.deadline)}; ${o.delivered}/${o.quantity} ${label(o.item)} were delivered${lateBy?` (checked ${Math.round(lateBy/60000)} min after the deadline)`:''}`);
  if(o.upfront>0)findings.push(`${plaintiff} had paid an advance of ${o.upfront} emeralds`);
  let falseTestimony=false;
  for(const s of timeline.filter(e=>e.kind==='statement'&&e.by===def&&e.claim?.delivered!=null))
    if(s.claim.delivered>o.delivered){falseTestimony=true;score[def]+=1.5;findings.push(`${def} testified to delivering ${s.claim.delivered}, but the ledger records ${o.delivered}: false testimony`);}
  if((priors[def]??0)>0)findings.push(`${def} has ${priors[def]} earlier conviction${priors[def]>1?'s':''}`);
  return {fault:def,confidence:o.delivered>0?0.85:0.95,scores:score,findings,timeline,falseTestimony};
}
const label=k=>String(k??'goods').toLowerCase().replace(/_/g,' ');
export function sentenceFor(conflict,verdict,{priors={}}={}){
  if(conflict.kind==='contract'){
    const f=verdict.fault;if(!f)return {outcome:'dismissed'};
    // The fine goes to the wronged party (and any advance is repaid); a liar or a repeat offender also serves the town.
    const prior=priors[f]??0,service=verdict.falseTestimony||prior>=1?{[f]:10}:{};
    if(prior>=2)return {outcome:'jail',guilty:f,wronged:conflict.party_a,ticks:2400,fine:CONTRACT_FINE,payee:conflict.party_a,restitution:conflict.order?.upfront??0,service};
    return {outcome:'fine',guilty:f,wronged:conflict.party_a,fine:CONTRACT_FINE,payee:conflict.party_a,restitution:conflict.order?.upfront??0,service};
  }
  const f=verdict.fault;
  if(!f)return {outcome:'dismissed'};
  if(f==='both')return {outcome:'reconcile',service:{[conflict.party_a]:5,[conflict.party_b]:5}};
  const prior=priors[f]??0,other=f===conflict.party_a?conflict.party_b:conflict.party_a;
  if(conflict.kind==='public_disturbance')return {outcome:'jail',guilty:f,wronged:other,ticks:Math.min(3600,1200+600*prior),fine:1};
  if(conflict.kind==='theft'){
    const ticks=Math.min(DAY_TICKS,12000+4000*prior);
    return {outcome:'jail',guilty:f,wronged:other,ticks,restitution:conflict.amount??0,fine:1};
  }
  if(prior>=1||(conflict.kind==='assault'&&verdict.confidence>=0.6))return {outcome:'jail',guilty:f,wronged:other,ticks:Math.min(DAY_TICKS,6000+3000*prior),fine:1};
  return {outcome:'fine',guilty:f,wronged:other,fine:2,service:{[f]:10}};
}

// ---------- the jail ----------
export function jailRecord({jailed_citizen_id,sentence_duration_ticks,reason,cell=null,conflict_id=null,time=Date.now()}){
  return {jailed_citizen_id,sentence_duration_ticks,remaining_ticks:sentence_duration_ticks,reason,cell,conflict_id,since:iso(time)};
}
/** Runs the jail clock; returns the records whose sentence is over (and removes them). */
export function tickJail(jail,elapsedTicks){
  const released=[];
  for(const r of [...jail]){r.remaining_ticks=Math.max(0,Math.round(r.remaining_ticks-elapsedTicks));if(r.remaining_ticks<=0){released.push(r);jail.splice(jail.indexOf(r),1);}}
  return released;
}
export function pardon(jail,id){const i=jail.findIndex(r=>r.jailed_citizen_id===id);return i<0?null:jail.splice(i,1)[0];}

/**
 * Cell stand points in the jail blueprint (shape 'jail', 9 x 7, cells along the north wall) whose north-west
 * corner is (x,z) and floor y: three cells, 2 + 2 + 1 blocks wide.
 */
export function jailCells({x,y,z,layoutVersion}){return (layoutVersion===2?[1,4,7,10]:[1,4,7]).map((i,k)=>({cell:k+1,x:x+i+0.5,y:y+1,z:z+1.5,...(layoutVersion===2?{lever:{x:x+i,y:y+1,z:z+4},outside:{x:x+i+0.5,y:y+1,z:z+5.5}}:{})}));}

/**
 * What a citizen tells the sheriff. Parties at fault may lie about where they were (a claim the sightings can
 * test); everyone else tells what they saw. random() decides the lies. Returns {text, claim?, provocation?}.
 */
export function statementOf(conflict,who,{nameOf=x=>x,random=Math.random,honesty=0.5}={}){
  if(conflict.kind==='contract'&&conflict.order){
    const o=conflict.order;
    if(who===conflict.party_a)return {text:`I posted order #${o.number} for ${o.quantity} ${label(o.item)}. By the deadline I had ${o.delivered}.`};
    if(who===conflict.party_b){
      if(o.delivered<o.quantity&&random()>honesty)return {text:`I delivered all ${o.quantity} ${label(o.item)} before the deadline. Check again.`,claim:{delivered:o.quantity,at:o.deadline},lie:true};
      return {text:o.delivered?`I got ${o.delivered} of the ${o.quantity} in before the deadline - I ran short of time.`:`I took order #${o.number} and did not deliver. I have no excuse that the ledger would accept.`,claim:{delivered:o.delivered,at:o.deadline}};
    }
    return {text:'I know nothing about that order.'};
  }
  const T=Date.parse(conflict.timestamp),truth=conflict.truth??{},scene=conflict.location;
  const party=[conflict.party_a,conflict.party_b].includes(who),culprit=truth.culprit??truth.instigator;
  if(party&&who===culprit&&random()>honesty){
    const away=truth.alibi??{x:(scene?.x??272)+40,z:(scene?.z??96)-30};
    return {text:`I was nowhere near there - I was over at ${away.x},${away.z} at ${clock(T)}.`,claim:{place:away,at:T},lie:true};
  }
  if(party&&conflict.kind==='theft'&&who!==culprit)return {text:`The count was right the evening before; by ${clock(T)} ${conflict.amount??'some'} emeralds were gone from the treasury.`};
  if(party&&conflict.kind==='theft')return {text:`I was at the ${conflict.scene??'warehouse'} around ${clock(T)}, yes. I... needed the money.`,claim:{place:scene??{x:272,z:96},at:T}};
  if(party){
    const other=who===conflict.party_a?conflict.party_b:conflict.party_a;
    return {text:who===culprit?`Yes, I was there at ${clock(T)}. Things got heated; I may have spoken first.`:`I was there at ${clock(T)}. ${nameOf(other)} started it.`,
      claim:{place:scene??{x:272,z:96},at:T},...(who===culprit?{provocation:who}:{})};
  }
  const saw=(conflict.evidence??[]).filter(e=>e.kind==='sighting'&&e.by===who);
  if(!saw.length)return {text:'I did not see anything, sorry.'};
  return {text:`I saw ${saw.map(e=>nameOf(e.about)).join(' and ')} there around ${clock(T)}${culprit&&saw.some(e=>e.about===culprit)&&conflict.kind!=='theft'?`; ${nameOf(culprit)} raised their voice first`:''}.`,
    ...(culprit&&saw.some(e=>e.about===culprit)&&conflict.kind!=='theft'?{provocation:culprit}:{})};
}

// ---------- in town ----------
export function createJustice(d){
  const {memory,configs,act=async()=>{},say=async()=>{},log=()=>{},ledger=()=>{},getSnapshot=()=>null,now=()=>Date.now(),random=Math.random}=d;
  const town=memory.data.town??={};
  const J=town.justice??={next:1,jail:[],history:[],detained:{},warrants:[],priors:{},migratedV1:false,lastTick:null};
  town.conflicts??=[];
  // One-time (2026-10-05): the staged treasury thefts were pinned on the judge again and again (the crime simulation
  // picked the least-liked citizen); the open theft cases against him are dismissed with the reason on the record.
  if(!J.judgeClearV1){J.judgeClearV1=true;
    for(const c of town.conflicts)if(c.kind==='theft'&&c.party_b==='judge'&&c.status!=='RESOLVED'){c.status='RESOLVED';c.resolved=true;c.resolution='dismissed: a staged theft wrongly pinned on the judge (the crime simulation chose the least-liked citizen; corrected)';}
    for(const k of town.cases??[])if(k.thief==='judge'&&k.status!=='convicted')k.status='dismissed';
    setTimeout(()=>{try{log('judge_cleared',{dismissed:town.conflicts.filter(c=>c.party_b==='judge'&&/staged theft/.test(c.resolution??'')).length});}catch{}},1000);}
  const conf=id=>configs.find(c=>c.id===id);
  const nameOf=id=>d.nameOf?.(id)??conf(id)?.name?.split(' the ')[0]??id;
  const roleOf=id=>{const c=conf(id);return c?c.role??c.id:null;};
  const byRole=r=>configs.find(c=>(c.role??c.id)===r);
  // The judge presides when the town has one; until then the governor sits as magistrate.
  const judge=()=>byRole('judge')??null;
  const magistrate=()=>judge()??conf(town.governor)??byRole('governor');
  /** Who presides over this case: never a party to it (the judge dismissed cases he was in); then the governor. */
  const magistrateFor=c=>{const parties=new Set([c.party_a,c.party_b]);const j=judge();if(j&&!parties.has(j.id))return j;
    const g=conf(town.governor)??byRole('governor');return g&&!parties.has(g.id)?g:magistrate();};   // nobody free of it: as before
  J.fines??=[];J.contractOrders??=[];J.summons??=null;J.session??=null;
  const sheriff=()=>byRole('sheriff');
  const tickNow=()=>{const w=getSnapshot()?.worldTime;return Number.isFinite(w)?(town.day??0)*DAY_TICKS+(w%DAY_TICKS):null;};
  const posOf=id=>getSnapshot()?.agents?.find(a=>a.id===id)??null;
  const SQUARE=d.square??{x:283.5,z:93.5};
  const find=ref=>town.conflicts.find(c=>c.conflict_id===String(ref).toUpperCase()||c.id===String(ref));

  // One-time: every old quarrel gets the court's schema.
  if(!J.migratedV1){
    town.conflicts=town.conflicts.map(c=>migrateConflict(c,{now:now(),day:town.day??0,square:SQUARE}));
    J.next=Math.max(J.next,...town.conflicts.map(c=>Number(c.id)+1||1));J.migratedV1=true;
    log('conflicts_migrated',{total:town.conflicts.length,open:town.conflicts.filter(c=>c.status==='OPEN').length});
  }
  const sync=c=>{if(c.resolved&&c.status!=='RESOLVED'){c.status='RESOLVED';c.resolution??='settled';}if(c.status==='RESOLVED')c.resolved=true;};

  /** Records a conflict where it happens, with the citizens who saw it. */
  function openConflict({a,b,reason,kind='dispute',location=null,truth={},extra={}}){
    const pa=posOf(a),pb=posOf(b),t=now(),tick=tickNow();
    const loc=location??(pa&&pb?{x:(pa.x+pb.x)/2,y:pa.y,z:(pa.z+pb.z)/2}:pa??pb??SQUARE);
    if(!truth.culprit&&!truth.instigator&&kind!=='theft'){
      // Who really started it: the one who trusts the other less (a coin toss between equals). Kept from the court.
      const ta=d.trust?.(a,b)??50,tb=d.trust?.(b,a)??50;truth={...truth,instigator:ta<tb?a:tb<ta?b:random()<0.5?a:b};
    }
    const c=newConflict({n:J.next++,party_a:a,party_b:b,reason,location:loc,tick,time:t,kind,day:town.day??null,truth,extra});
    // Witnesses: citizens close enough to see both of them.
    for(const w of kind==='contract'?[]:(getSnapshot()?.agents??[]).filter(x=>![a,b].includes(x.id)&&conf(x.id)&&roleOf(x.id)!=='visitor'&&near(x,loc,SCENE))){
      for(const p of [a,b]){const pp=posOf(p);if(kind==='theft'&&p!==truth.culprit)continue;addEvidence(c,{kind:'sighting',by:w.id,about:p,time:t,tick,location:pp??loc,text:`${nameOf(w.id)} saw ${nameOf(p)} at ${Math.round((pp??loc).x)},${Math.round((pp??loc).z)}`});}
    }
    town.conflicts.push(c);
    log('conflict',{conflict_id:c.conflict_id,timestamp:c.timestamp,tick:c.tick,party_a:a,party_b:b,location:c.location,reason,status:c.status,kind,witnesses:new Set(c.evidence.filter(e=>e.kind==='sighting').map(e=>e.by)).size});
    return c;
  }
  /** A complaint: against an open conflict between the two, or a new one. */
  function complain(by,against,text,{kind='dispute'}={}){
    if(!conf(against)&&against!=='treasury')throw Error(`Unknown citizen ${against}`);
    if(by===against)throw Error('You cannot complain about yourself');
    let c=town.conflicts.find(x=>x.status==='OPEN'&&!x.complaint&&[x.party_a,x.party_b].includes(by)&&[x.party_a,x.party_b].includes(against));
    if(!c)c=openConflict({a:by,b:against,reason:String(text).slice(0,120),kind});
    fileComplaint(c,{by,text,time:now(),tick:tickNow()});
    ledger(by,`filed a complaint against ${nameOf(against)} (${c.conflict_id}): ${String(text).slice(0,100)}`);
    log('complaint_filed',{conflict_id:c.conflict_id,by,against,timestamp:c.complaint.timestamp});
    return c;
  }
  /** Whether a party files a complaint over a fresh quarrel (by its values: a respect for order vs. letting things go). */
  function maybeComplain(c){
    if(c.complaint||c.status!=='OPEN')return null;
    const wronged=c.truth?.instigator===c.party_a?c.party_b:c.party_a;
    const v=d.valuesOf?.(wronged)??{};
    const p=0.3+0.35*(v.tradition??0.5)+0.2*(v.selfPreservation??0.5)-0.3*(v.community??0.5);
    if(random()>p)return null;
    return complain(wronged,wronged===c.party_a?c.party_b:c.party_a,`${nameOf(wronged===c.party_a?c.party_b:c.party_a)} and I argued about ${c.reason}`);
  }

  // ---------- contract cases (FILE_CASE from the order board) ----------
  /**
   * A claimed work order ran past its deadline short of goods (intel sweep). The issuer decides whether to sue - by
   * their values, more readily when an advance was paid - unless `force`. Returns the new case or null.
   */
  function considerContract(o,{force=false}={}){
    const plaintiff=o.issuer_name,def=o.contractor_name;
    if(!o.target_item||!conf(plaintiff)||!conf(def)||plaintiff===def||[plaintiff,def].some(id=>roleOf(id)==='visitor'))return null;
    if((o.delivered??0)>=o.quantity||J.contractOrders.includes(o.number))return null;
    const open=town.conflicts.filter(c=>c.status==='OPEN');
    if(!force&&open.length>=6)return null;   // a full docket: minor breaches are let go
    if(!force&&open.some(c=>c.kind==='contract'&&[c.party_a,c.party_b].includes(plaintiff)&&[c.party_a,c.party_b].includes(def)))return null;
    const v=d.valuesOf?.(plaintiff)??{},upfront=o.upfront_paid??0;
    const p=0.15+0.35*(v.tradition??0.5)+0.15*(v.selfPreservation??0.5)-0.2*(v.community??0.5)+(upfront>0?0.3:0)+(o.quantity>=32?0.1:0);
    if(!force&&random()>p)return null;
    J.contractOrders=[...J.contractOrders,o.number].slice(-200);
    const order={number:o.number,item:o.target_item,quantity:o.quantity,delivered:o.delivered??0,claimed_at:o.claimed_at,deadline:o.deadline,checked_at:now(),upfront,reward:o.reward_emeralds??0};
    const c=openConflict({a:plaintiff,b:def,reason:`breach of contract: order #${o.number}, ${order.quantity-order.delivered} of ${order.quantity} ${label(order.item)} not delivered`,
      kind:'contract',location:d.courtPlace?.()??SQUARE,truth:{culprit:def},extra:{order}});
    // The evidence pointers: the order board's own record of the claim and the deadline.
    addEvidence(c,{kind:'record',by:'order board',about:def,time:o.claimed_at??now(),text:`order #${o.number} claimed by ${nameOf(def)}: ${order.quantity} ${label(order.item)}, due ${o.deadline?clock(o.deadline):'?'} UTC`});
    addEvidence(c,{kind:'record',by:'order board',about:def,time:o.deadline??now(),text:`deadline passed with ${order.delivered}/${order.quantity} delivered${upfront?`; advance of ${upfront} paid`:''}`});
    fileComplaint(c,{by:plaintiff,text:`${nameOf(def)} took my order #${o.number} and did not deliver`,time:now(),tick:tickNow()});
    c.investigation={status:'done',by:'record',started:iso(now()),finished:iso(now()),heard:[],summary:['the order board is the evidence']};
    scheduleTrial(c,{time:now(),delayMs:d.trialDelayMs??180000,place:d.courtPlace?.()??SQUARE});
    ledger(plaintiff,`filed a contract case (${c.conflict_id}) against ${nameOf(def)} over order #${o.number}`);
    log('case_filed',{conflict_id:c.conflict_id,plaintiff,defendant:def,charge_type:'contract',evidence_pointers:[`order #${o.number}`],status:c.status,trial_at:c.trial.scheduled_at});
    return c;
  }

  // ---------- summons (CALL_COURT): who must be in the courtroom, and where they stand ----------
  /** The next trial on the docket (earliest), or null. */
  const nextTrial=()=>town.conflicts.filter(x=>x.status==='OPEN'&&x.trial&&!x.trial.held).sort((a,b)=>a.trial.at-b.trial.at)[0]??null;
  /** Calls the court for case c: the parties and the sheriff are summoned to their stands. */
  function summon(c){
    if(J.summons?.conflict_id===c.conflict_id)return J.summons;
    const people={plaintiff:c.party_a,defendant:c.party_b,...(sheriff()&&![c.party_a,c.party_b].includes(sheriff().id)?{sheriff:sheriff().id}:{})};
    for(const k of Object.keys(people))if(!conf(people[k]))delete people[k];   // the treasury is not summoned
    // SELECT_JURY: a bench trial for minor matters; a jury when the case is serious or unclear (skills/jury.mjs).
    const need=needsJury(c,{priors:J.priors,preview:weighEvidence(c,{priors:J.priors})});
    if(need.jury&&!c.jury){
      const busy=new Set([...Object.values(people),magistrate()?.id,sheriff()?.id,judge()?.id].filter(Boolean));
      const candidates=configs.map(x=>x.id).filter(id=>!busy.has(id)&&roleOf(id)!=='visitor'&&!restricted(id)&&posOf(id));
      const pick=selectJury(c,{candidates,relation:(a,b)=>d.relation?.(a,b)??null,random,size:need.size});
      c.jury={reasons:need.reasons,size:need.size,jurors:pick.jurors,alternates:pick.alternates,disqualified:pick.disqualified,selected_at:iso(now())};
      log('jury_selected',{conflict_id:c.conflict_id,reasons:need.reasons,jurors:pick.jurors,alternates:pick.alternates.length,disqualified:pick.disqualified});
    }
    if(c.jury)c.jury.jurors.forEach((id,i)=>{people[`juror${i+1}`]=id;});
    J.summons={conflict_id:c.conflict_id,at:c.trial.at,since:iso(now()),people};
    log('court_summoned',{conflict_id:c.conflict_id,...people,at:c.trial.scheduled_at});
    return J.summons;
  }
  /** Where a citizen has to be for the court right now ({conflict_id, role, stand}), or null. */
  function summonsFor(id){
    const s=J.summons;if(!s)return null;
    const role=Object.entries(s.people).find(([,who])=>who===id)?.[0];if(!role)return null;
    if(jailed(id))return null;
    // The courthouse; or, until it is built, the town hall's table (civic hallCourt: places behind the chairs).
    const room=d.courtLayout?.()??d.courtSpots?.(),base=d.courtPlace?.()??SQUARE;
    const seat=/^juror(\d)$/.exec(role)?.[1]-1;   // jurors sit in the jury box, seat by seat
    const stand=Number.isInteger(seat)?(room?room.jury[seat]:{x:base.x-3+seat*1.5,z:base.z+4})
      :room?room.stands[role]:{plaintiff:{x:base.x-2,z:base.z+2},defendant:{x:base.x+2,z:base.z+2},sheriff:{x:base.x+3,z:base.z},witness:{x:base.x-3,z:base.z}}[role];
    return {conflict_id:s.conflict_id,role,stand};
  }
  /** Who of the summoned is in the courtroom (within 3 blocks of their stand). */
  function attendance(){
    const s=J.summons;if(!s)return {};
    return Object.fromEntries(Object.entries(s.people).map(([role,id])=>{const p=posOf(id),st=summonsFor(id)?.stand;return [role,{id,present:!!(p&&st&&near(p,st,3))}];}));
  }
  function adjourn(){if(J.summons)log('court_adjourned',{conflict_id:J.summons.conflict_id});J.summons=null;J.session=null;}

  // ---------- investigation (the sheriff's loop calls these) ----------
  const investigations=()=>town.conflicts.filter(c=>c.status==='OPEN'&&c.complaint&&c.investigation?.status!=='done');
  /** The people the sheriff should hear: the parties, then the witnesses. */
  function interviewees(c){return [...new Set([c.party_a,c.party_b,...c.evidence.filter(e=>e.kind==='sighting').map(e=>e.by)])].filter(id=>conf(id)&&roleOf(id)!=='sheriff').slice(0,5);}
  /** One statement, taken by the sheriff (timestamped now; the claim inside carries the time it is about). */
  function takeStatement(c,who,by){
    const v=d.valuesOf?.(who)??{};
    // A grudge against the other side makes a party readier to lie (intel/social.mjs relationships).
    const other=who===c.party_a?c.party_b:who===c.party_b?c.party_a:null,feud=other?d.relation?.(who,other)?.affinity??0:0;
    const s=statementOf(c,who,{nameOf,random,honesty:Math.max(0.05,0.35+0.4*(v.community??0.5)-(feud<-0.3?0.25:0))});
    addEvidence(c,{kind:'statement',by:who,about:who,time:now(),tick:tickNow(),location:posOf(who),text:s.text,claim:s.claim});
    if(s.provocation)addEvidence(c,{kind:'provocation',by:who,about:s.provocation,time:Date.parse(c.timestamp)+1000,tick:c.tick,location:c.location,text:`${nameOf(who)}: ${nameOf(s.provocation)} started it`});
    (c.investigation??={status:'open',by,started:iso(now()),heard:[]}).heard.push(who);
    log('statement_taken',{conflict_id:c.conflict_id,by,from:who,text:s.text});
    return s;
  }
  /** The sheriff files the findings: the case goes to trial. */
  function fileFindings(c,by){
    if(c.kind==='theft'&&c.truth?.culprit)addEvidence(c,{kind:'record',by:'record',about:c.truth.culprit,time:Date.parse(c.timestamp),tick:c.tick,location:c.location,
      text:`the treasury chest was opened by ${nameOf(c.truth.culprit)} and ${c.amount??'some'} emeralds taken`});
    const w=weighEvidence(c,{priors:J.priors});
    const lead=w.fault&&w.fault!=='both'?w.fault:null;
    if(lead)addEvidence(c,{kind:'finding',by,about:lead,time:now(),tick:tickNow(),text:`the sheriff's report points to ${nameOf(lead)}`});
    c.investigation={...(c.investigation??{}),status:'done',by,finished:iso(now()),summary:w.findings.slice(0,4)};
    const place=d.courtPlace?.()??SQUARE;
    scheduleTrial(c,{time:now(),delayMs:d.trialDelayMs??180000,place});
    ledger(by,`filed findings on ${c.conflict_id}; trial set for ${c.trial.scheduled_at.slice(11,16)} UTC`);
    log('trial_scheduled',{conflict_id:c.conflict_id,at:c.trial.scheduled_at,place:c.trial.place});
    return c.trial;
  }

  // ---------- the trial ----------
  let inSession=null;
  async function holdTrial(c,{present=null}={}){
    if(inSession)return null;inSession=c.conflict_id;
    try{
      const judge=magistrateFor(c);if(!judge)throw Error('no magistrate free of the case (both the judge and the governor are parties)');
      if(magistrate()&&judge.id!==magistrate().id)log('magistrate_recused',{conflict_id:c.conflict_id,recused:magistrate().id,presiding:judge.id});
      J.session={conflict_id:c.conflict_id,phase:'CONDUCT_TRIAL',since:iso(now())};
      // Attendance is on the record; whoever is in the courtroom is heard (a contract case has had no investigation).
      if(present)for(const [role,a] of Object.entries(present)){
        addEvidence(c,{kind:'attendance',by:'court',about:a.id,time:now(),tick:tickNow(),text:`${nameOf(a.id)} (${role}) ${a.present?'present':'absent - tried in absentia'}`});
        if(a.present&&['plaintiff','defendant'].includes(role)&&!c.evidence.some(e=>e.kind==='statement'&&e.by===a.id))takeStatement(c,a.id,judge.id);
      }
      let verdict=weighEvidence(c,{priors:J.priors});
      await say(judge.id,`Court is in session: ${c.conflict_id}, ${nameOf(c.party_a)} and ${nameOf(c.party_b)}, over ${c.reason}. The record begins at ${c.timestamp.slice(11,19)} UTC.`).catch(()=>{});
      act(judge.id,{type:'effect',x:0,y:0,z:0,target:'gavel'}).catch(()=>{});
      // A jury trial when the case called for one (skills/jury.mjs): the jury's verdict decides; a hung jury is
      // sent back once, then the court rules on the record. Too few jurors in the box: an emergency bench trial.
      let juryVerdict=null;
      if(c.jury){
        const seated=Object.entries(present??{}).filter(([r,a])=>r.startsWith('juror')&&a.present).map(([,a])=>a.id);
        if(seated.length>=2)juryVerdict=await deliberate(c,verdict,seated,judge.id);
        else{c.jury.bench='too few jurors answered the summons';log('jury_dismissed',{conflict_id:c.conflict_id,seated:seated.length});
          await say(judge.id,'Too few jurors answered the summons. The court will decide from the bench.').catch(()=>{});}
      }
      if(juryVerdict==='GUILTY'&&verdict.fault!==c.party_b)verdict={...verdict,fault:c.party_b,confidence:Math.max(verdict.confidence,0.6)};
      const sentence=juryVerdict==='NOT_GUILTY'?{outcome:'dismissed'}:sentenceFor(c,verdict,{priors:J.priors});
      J.session.phase='DELIVER_SENTENCE';
      c.trial={...c.trial,held:true,held_at:iso(now()),magistrate:judge.id,...(c.jury?{jury:!c.jury.bench}:{})};
      // GUILTY / NOT_GUILTY (the record or the jury clears them) / DISMISSED (the evidence cannot tell).
      const word=juryVerdict??(sentence.guilty||sentence.outcome==='reconcile'?'GUILTY':c.kind==='contract'?'NOT_GUILTY':'DISMISSED');
      c.verdict={...sentence,verdict:word,falseTestimony:!!verdict.falseTestimony,fault:verdict.fault,confidence:verdict.confidence,findings:verdict.findings,scores:verdict.scores,decided_at:iso(now()),
        ...(c.jury?{jury:{result:c.jury.result??null,tally:c.jury.tally??null,tieBreak:!!c.jury.tieBreak,bench:c.jury.bench??null}}:{})};
      c.status=sentence.outcome==='dismissed'||sentence.outcome==='reconcile'?'RESOLVED':'TRIED';
      if(c.status==='RESOLVED'){c.resolved=true;c.resolution=sentence.outcome==='dismissed'?(juryVerdict==='NOT_GUILTY'?'acquitted by the jury':'dismissed for lack of evidence'):'both at fault; reconciled by the court';}
      // The ruling, in the magistrate's own words (the plain version when the model is away).
      let words=plainRuling(c,verdict,sentence);
      try{
        const t=await d.lm?.callUtilityTask?.('town_speech',`You are ${nameOf(judge.id)}, the town ${roleOf(judge.id)==='judge'?'judge: formal, stoic, bound to the ledger':'magistrate'}, in a Minecraft village. Announce the verdict in two short sentences (under 230 characters): cite one piece of recorded evidence exactly as given (invent nothing), then the sentence. Plain text.`,
          {case:c.conflict_id,reason:c.reason,parties:[nameOf(c.party_a),nameOf(c.party_b)],findings:verdict.findings.slice(0,4),sentence:{...sentence,guilty:sentence.guilty&&nameOf(sentence.guilty)}});
        if(t&&String(t).trim().length>20)words=String(t).replace(/[\r\n]+/g,' ').replace(/^["“]|["”]$/g,'').trim().slice(0,230);
      }catch{}
      await say(judge.id,words).catch(()=>{});
      await carryOut(c,sentence,judge.id);
      ledger(judge.id,`ruled on ${c.conflict_id}: ${sentence.outcome}${sentence.guilty?` (${nameOf(sentence.guilty)})`:''}`);
      log('trial_held',{conflict_id:c.conflict_id,magistrate:judge.id,outcome:sentence.outcome,fault:verdict.fault,confidence:verdict.confidence,findings:verdict.findings.length});
      J.history=[{conflict_id:c.conflict_id,day:town.day,kind:c.kind,charge:c.reason,outcome:sentence.outcome,verdict:word,guilty:sentence.guilty??null,time:iso(now())},...J.history].slice(0,30);
      d.chronicle?.(`${c.conflict_id} (${c.reason}): ${word}. ${words}`);
      return c.verdict;
    }finally{inSession=null;}
  }
  /**
   * PRESENT_EVIDENCE and JURY_DELIBERATION: the judge charges the jury with the record, each juror says where they
   * stand (from the record and their own leanings only) and votes; a hung jury deliberates once more, then the court
   * rules on the record. Jurors remember the case and it colours how they see the defendant and each other.
   */
  async function deliberate(c,verdict,seated,judgeId){
    const def=c.party_b,named=t=>[c.party_a,c.party_b].reduce((x,id)=>x.replace(new RegExp(String.raw`\b${id}\b`,'g'),nameOf(id)),t);
    J.session.phase='PRESENT_EVIDENCE';
    const facts=verdict.findings.slice(0,2).map(named);
    await say(judgeId,`Members of the jury: ${facts.length?facts.join('; '):'the record holds little beyond the complaint'}. Weigh only what the record shows.`.slice(0,240)).catch(()=>{});
    J.session.phase='JURY_DELIBERATION';
    const fact=keyFact(c,verdict.findings.map(named));
    const evidence={fault:verdict.fault,defendant:def,confidence:verdict.confidence,falseTestimony:!!verdict.falseTestimony,partial:!!(c.order&&c.order.delivered>0)};
    let votes=[],result=null,round=1;
    for(;round<=2;round++){
      // The second round leans toward the bench's reading of the record and the first round's majority.
      const pull=round===1?0:(verdict.fault===def?0.08:-0.08)+(result.guilty>result.notGuilty?0.05:result.notGuilty>result.guilty?-0.05:0);
      const before=new Map(votes.map(v=>[v.id,v.vote]));
      votes=seated.map(id=>({id,...jurorVote({evidence,traits:d.traitsOf?.(id)??{},values:d.valuesOf?.(id)??{},affinity:d.relation?.(id,def)?.affinity??0,fact,round,pull,random})}));
      for(const v of votes)if(round===1||before.get(v.id)!==v.vote)await say(v.id,v.reason.slice(0,230)).catch(()=>{});
      result=tally(votes);
      log('jury_vote',{conflict_id:c.conflict_id,round,...result,votes:votes.map(v=>({juror:v.id,vote:v.vote,score:v.score}))});
      if(result.result!=='HUNG')break;
      if(round===1)await say(judgeId,'The jury is divided. Deliberate once more.').catch(()=>{});
    }
    let final=result.result,tieBreak=false;
    if(final==='HUNG'){
      tieBreak=true;final=verdict.fault===def?'GUILTY':'NOT_GUILTY';
      await say(judgeId,`The jury cannot agree. The court rules on the record: ${nameOf(def)} is ${final==='GUILTY'?'guilty':'not guilty'}.`).catch(()=>{});
    }else await say(judgeId,`The jury finds ${nameOf(def)} ${final==='GUILTY'?'guilty':'not guilty'}, ${result.guilty} to ${result.notGuilty}${result.abstain?` with ${result.abstain} abstaining`:''}.`).catch(()=>{});
    c.jury={...c.jury,seated,rounds:Math.min(round,2),result:final,tieBreak,tally:{guilty:result.guilty,notGuilty:result.notGuilty,abstain:result.abstain},
      votes:votes.map(v=>({juror:v.id,vote:v.vote,reason:v.reason}))};
    // Consequential memory: the case stays with each juror, and serving together builds a little trust.
    for(const v of votes){
      d.remember?.(v.id,{text:`Served on the jury in ${c.conflict_id} (${nameOf(c.party_a)} v ${nameOf(def)}); voted ${v.vote.replace('_',' ').toLowerCase()} - ${fact}`.slice(0,160),who:[def,...seated.filter(x=>x!==v.id)],tags:['jury'],emotion:0.4,social:0.7});
      if(v.vote!=='ABSTAIN')d.adjustTrust?.(v.id,def,v.vote==='GUILTY'?-3:1,`jury in ${c.conflict_id}`);
      for(const o of seated)if(o!==v.id)d.adjustTrust?.(v.id,o,1,'served on a jury together');
    }
    log('jury_verdict',{conflict_id:c.conflict_id,result:final,tieBreak,...c.jury.tally});
    return final;
  }
  /** Absent jurors replaced from the alternates (once per seat); returns how many were replaced. */
  function replaceAbsentJurors(){
    const s=J.summons,c=s&&find(s.conflict_id);if(!c?.jury)return 0;
    let n=0;
    for(const [role,a] of Object.entries(attendance()).filter(([r,a])=>r.startsWith('juror')&&!a.present)){
      if((c.jury.replaced??[]).includes(role))continue;
      const alt=(c.jury.alternates??[]).find(id=>!Object.values(s.people).includes(id)&&!restricted(id));if(!alt)continue;
      c.jury.alternates=c.jury.alternates.filter(x=>x!==alt);c.jury.jurors=c.jury.jurors.map(x=>x===a.id?alt:x);
      s.people[role]=alt;(c.jury.replaced??=[]).push(role);n++;
      log('juror_replaced',{conflict_id:c.conflict_id,seat:role,absent:a.id,alternate:alt});
    }
    return n;
  }
  function plainRuling(c,v,s){
    // Spoken with names, not the town's ids ("courier" -> "Barnaby").
    const named=t=>[c.party_a,c.party_b].reduce((x,id)=>x.replace(new RegExp(String.raw`\b${id}\b`,'g'),nameOf(id)),t);
    const ev=v.findings[0]?` Evidence: ${named(v.findings[0])}.`:'';
    switch(s.outcome){
      case 'dismissed':return `The evidence does not show who was at fault; ${c.conflict_id} is dismissed.`;
      case 'reconcile':return `Both share the blame.${ev} Five minutes of community service each, and shake hands.`;
      case 'fine':return `${nameOf(s.guilty)} is at fault.${ev} A fine of ${s.fine} emeralds${s.payee?` to ${nameOf(s.payee)}`:''}${s.service?.[s.guilty]?` and ${s.service[s.guilty]} minutes of community service`:''}.`;
      case 'jail':return `${nameOf(s.guilty)} is guilty.${ev} ${Math.round(s.ticks/1200)} minutes in jail${s.restitution?`, and ${s.restitution} emeralds repaid`:''}.`;
    }
    return 'The court has ruled.';
  }
  async function carryOut(c,s,judge){
    const pay=(id,n)=>n>0?act(id,{type:'pay',x:0,y:0,z:0,target:'EMERALD',count:n}).then(()=>n).catch(()=>0):Promise.resolve(0);
    if(s.guilty){
      J.priors[s.guilty]=(J.priors[s.guilty]??0)+1;
      for(const o of configs.filter(x=>x.id!==s.guilty&&(x.role??x.id)!=='visitor'))d.adjustTrust?.(o.id,s.guilty,s.outcome==='jail'?-6:-2,`convicted in ${c.conflict_id}`);
      d.adjustTrust?.(s.wronged,judge,2,`justice in ${c.conflict_id}`);
    }
    // Fines through the bank (to the wronged party in a contract case, to the town otherwise); what cannot be paid
    // now stays on the court's ledger (J.fines) and is collected later. Without a bank: from the pocket.
    const collect=async(amount,memo)=>{
      if(!(amount>0))return 0;
      if(d.collectFine){const r=await d.collectFine(s.guilty,s.payee??null,amount,memo).catch(e=>({paid:0,error:e.message}));
        const paid=r?.paid??0;if(paid<amount)J.fines.push({conflict_id:c.conflict_id,debtor:s.guilty,creditor:s.payee??null,amount:amount-paid,memo,since:iso(now())});return paid;}
      return pay(s.guilty,amount);
    };
    if(s.restitution)c.verdict.restitution_paid=await collect(s.restitution,`${c.conflict_id}: advance repaid`);
    if(s.fine)c.verdict.fine_paid=await collect(s.fine,`${c.conflict_id}: court fine`);
    for(const [id,minutes] of Object.entries(s.service??{})){
      const o=d.quests?.()?.post({category:'COMMUNITY_SERVICE',issuer:judge,quantity:minutes,note:`sentence for ${c.conflict_id}`,priority:'HIGH',reward:0,
        targetLocation:{x:SQUARE.x,z:SQUARE.z,assigned:id,sentence:c.conflict_id}});
      if(o)(c.verdict.service_quests??={})[id]=o.number;
    }
    if(s.outcome==='jail'){J.warrants.push({conflict_id:c.conflict_id,suspect:s.guilty,ticks:s.ticks,reason:c.reason,issued:iso(now())});log('warrant_issued',{conflict_id:c.conflict_id,suspect:s.guilty,ticks:s.ticks});}
    if(s.outcome==='fine'&&!Object.keys(s.service??{}).length&&!J.fines.some(f=>f.conflict_id===c.conflict_id))resolve(c,'fine paid');
    d.onVerdict?.(c,s);
  }
  function resolve(c,how){c.status='RESOLVED';c.resolved=true;c.resolution=how;log('conflict_resolved',{conflict_id:c.conflict_id,how});}
  /** A community-service quest finished: the sentence (and the case, once everyone is done) is served. */
  function onServiceDone(id,order){
    const ref=(()=>{try{return JSON.parse(order.target_location)?.sentence;}catch{return null;}})();const c=ref&&find(ref);if(!c||c.status==='RESOLVED')return;
    (c.verdict.service_done??={})[id]=true;
    if(Object.keys(c.verdict.service_quests??{}).every(k=>c.verdict.service_done[k]))resolve(c,'sentence served');
  }

  // ---------- warrants, arrests and the jail ----------
  const jailSite=()=>d.jailSite?.()??null;   // {x,y,z} of the built jail's north-west floor corner, or null
  /**
   * Where a sentence is served: a courthouse holding cell (iron door, lever) when one is free, else a jail cell, else
   * the stocks on the square. Cells carry their facility and the spot outside to release to.
   */
  function cellFor(id){
    const taken=new Set(J.jail.filter(r=>r.jailed_citizen_id!==id).map(r=>`${r.cell?.facility??'jail'}:${r.cell?.cell}`));
    const readyJail=jailSite();
    if(id==='percy'&&readyJail?.layoutVersion===2){const free=jailCells(readyJail).map(c=>({...c,facility:'jail'})).find(c=>!taken.has(`jail:${c.cell}`));if(free)return free;}
    const court=d.courtLayout?.();
    if(court){const free=court.cells.map(c=>({...c,facility:'courthouse',entrance:court.entrance})).find(c=>!taken.has(`courthouse:${c.cell}`));if(free)return free;}
    const site=jailSite();
    if(site){const cells=jailCells(site).map(c=>({...c,facility:'jail'}));return cells.find(x=>!taken.has(`jail:${x.cell}`))??cells[0];}
    // No jail yet: the stocks on the square.
    return {cell:0,x:SQUARE.x-3,y:null,z:SQUARE.z+3,stocks:true};
  }
  /** The door the sheriff marches a suspect to (the courthouse entrance for a holding cell), or the jail's. */
  const jailDoor=(suspect=null)=>{
    const planned=suspect?cellFor(suspect):null;
    if(planned?.facility==='courthouse')return planned.entrance;
    const s=jailSite();return s?(s.layoutVersion===2?{x:s.x-0.5,y:s.y+1,z:s.z+4.5}:{x:s.x+4.5,y:s.y+1,z:s.z+7.5}):{x:SQUARE.x-3,z:SQUARE.z+5};
  };
  /** Works a holding cell's lever (whoever is closest of the sheriff and the judge, if within reach): the iron door swings. */
  async function lever(cell){
    if(!cell?.lever)return;
    const by=[sheriff()?.id,judge()?.id].filter(Boolean).map(id=>({id,p:posOf(id)})).filter(x=>x.p&&Math.hypot(x.p.x-cell.lever.x-0.5,x.p.y-cell.lever.y,x.p.z-cell.lever.z-0.5)<=4)[0];
    if(by)await act(by.id,{type:'interact',x:cell.lever.x,y:cell.lever.y,z:cell.lever.z}).catch(()=>{});
  }
  const warrants=()=>J.warrants;
  /** The sheriff has the suspect in hand: they follow until locked up. */
  function detain(suspect,by){J.detained[suspect]={by,since:iso(now())};log('suspect_detained',{suspect,by});act(suspect,{type:'effect',x:0,y:0,z:0,target:'arrest'}).catch(()=>{});}
  async function imprison(suspect,{by=null,how='escorted'}={}){
    const w=J.warrants.find(x=>x.suspect===suspect);if(!w)return null;
    J.warrants=J.warrants.filter(x=>x!==w);delete J.detained[suspect];
    const cell=cellFor(suspect),rec=jailRecord({jailed_citizen_id:suspect,sentence_duration_ticks:w.ticks,reason:w.reason,cell,conflict_id:w.conflict_id,time:now()});
    J.jail=J.jail.filter(r=>r.jailed_citizen_id!==suspect);J.jail.push(rec);
    await lever(cell);await confine(suspect,cell);await lever(cell);   // the door opens, they step in, it shuts
    act(suspect,{type:'effect',x:0,y:0,z:0,target:'jail'}).catch(()=>{});
    ledger(by??magistrate()?.id??suspect,`${nameOf(suspect)} was locked up${cell.stocks?' in the stocks on the square':cell.facility==='courthouse'?` in holding cell ${cell.cell} at the courthouse`:` in cell ${cell.cell}`} for ${Math.round(w.ticks/1200)} minutes (${w.conflict_id})`);
    log('jailed',{...rec,how,by});
    return rec;
  }
  async function confine(id,cell){
    let y=cell.y;
    if(y==null){const g=await act(id,{type:'survey',x:Math.floor(cell.x),y:0,z:Math.floor(cell.z),width:1,depth:1}).catch(()=>null);y=Number.isFinite(g?.heights?.[0])?g.heights[0]+1:Math.round(posOf(id)?.y??64);}
    return act(id,{type:'confine',x:cell.x,y,z:cell.z}).then(()=>true).catch(e=>{log('confine_failed',{agent:id,message:e.message});return false;});
  }
  async function release(r,why){
    const c=find(r.conflict_id);
    if(c&&c.status==='TRIED'&&!Object.keys(c.verdict?.service_quests??{}).length)resolve(c,why==='pardon'?'pardoned':'sentence served');
    if(r.cell?.outside){await lever(r.cell);await confine(r.jailed_citizen_id,r.cell.outside);await lever(r.cell);}
    else if(jailSite()){const door=jailDoor();await confine(r.jailed_citizen_id,{x:door.x,y:door.y,z:door.z+1});}
    act(r.jailed_citizen_id,{type:'effect',x:0,y:0,z:0,target:'release'}).catch(()=>{});
    await say(r.jailed_citizen_id,why==='pardon'?'Thank you for the pardon. I will do better.':'Free at last. I have learned my lesson.').catch(()=>{});
    ledger(r.jailed_citizen_id,why==='pardon'?'was pardoned and released from jail':'served the sentence and walked out of jail');
    log('released',{jailed_citizen_id:r.jailed_citizen_id,why,conflict_id:r.conflict_id});
  }
  /** The mayor (or the magistrate) pardons a citizen: out of jail, warrant torn up. */
  async function pardonCitizen(id,by){
    const r=pardon(J.jail,id),w=J.warrants.find(x=>x.suspect===id);
    if(w)J.warrants=J.warrants.filter(x=>x!==w);delete J.detained[id];
    if(!r&&!w)throw Error(`${nameOf(id)} is not in jail and has no warrant`);
    if(r)await release(r,'pardon');
    else{const c=find(w.conflict_id);if(c)resolve(c,'pardoned');}
    ledger(by,`pardoned ${nameOf(id)}`);log('pardoned',{id,by});
    return true;
  }
  const jailed=id=>J.jail.find(r=>r.jailed_citizen_id===id)??null;
  /** In jail or being marched there: no work, no wandering. */
  const restricted=id=>!!jailed(id)||!!J.detained[id];
  const lastFix=new Map(),lastRation=new Map();
  /** The jailed citizen's whole day: stay in the cell, eat, wait. Returns a job (so nothing else runs) or null. */
  function jailJob(c,s,self){
    const r=jailed(c.id);if(!r)return null;
    return async()=>{
      if(r.cell&&Math.hypot(self.x-r.cell.x,self.z-r.cell.z)>2.2&&now()-(lastFix.get(c.id)??0)>15000){lastFix.set(c.id,now());await confine(c.id,r.cell);return;}
      const hungry=(s.needs?.hunger??20)<12,food=Object.keys(self.inventory??{}).find(k=>/^(BREAD|COOKED_[A-Z_]+|BAKED_POTATO|APPLE|CARROT)$/.test(k)&&self.inventory[k]>0);
      if(hungry&&food){await act(c.id,{type:'eat',x:0,y:0,z:0,target:food}).catch(()=>{});if(s.needs)s.needs.hunger=Math.min(20,s.needs.hunger+5);return;}
      if(hungry&&now()-(lastRation.get(c.id)??0)>600000){lastRation.set(c.id,now());const keeper=sheriff()?.id??magistrate()?.id;if(keeper)await act(keeper,{type:'wage',x:0,y:0,z:0,to:c.id,target:'BREAD',count:2}).catch(()=>{});}
    };
  }
  /** Once a second or so: the jail clock, complaints into investigations, trials that are due. */
  async function tick(){
    for(const c of town.conflicts)sync(c);
    // Jail clock: real time at 20 ticks a second.
    const t=now(),elapsed=J.lastTick?Math.min(60000,t-J.lastTick):0;J.lastTick=t;
    for(const r of tickJail(J.jail,elapsed/1000*TICKS_PER_SECOND))await release(r,'served');
    // Complaints become investigation quests for the sheriff.
    for(const c of town.conflicts.filter(x=>x.status==='OPEN'&&x.complaint&&!x.investigation)){
      const o=d.quests?.()?.post({category:'INVESTIGATE_DISPUTE',issuer:c.complaint.by==='treasury'?magistrate()?.id:c.complaint.by,quantity:1,note:`look into ${c.reason} (${c.conflict_id})`.slice(0,150),
        priority:'HIGH',preferred:sheriff()?.id,targetLocation:{conflict_id:c.conflict_id,x:c.location?.x,z:c.location?.z},reward:3});
      c.investigation={status:'open',quest:o?.number??null,started:iso(t),heard:[]};
      log('investigation_opened',{conflict_id:c.conflict_id,quest:o?.number});
    }
    // Without a sheriff, an investigation waits 10 minutes and then goes to trial on what is known.
    if(!sheriff())for(const c of town.conflicts.filter(x=>x.status==='OPEN'&&x.investigation?.status==='open'&&t-Date.parse(x.investigation.started)>600000))fileFindings(c,magistrate()?.id??'record');
    // Trials: the judge calls the court and holds them (roles/judge.mjs). Without a judge - or one who has not sat
    // 8 minutes past the hour (stuck on the way) - the court sits on its own, as before.
    // A court left sitting (a restart in the middle of a trial: C-045 kept five jurors in the courthouse for two days,
    // Marlo and Finneas among them): a summons or session older than an hour with no trial running is adjourned.
    if(J.summons&&!inSession){
      J.summons.at??=t;
      const since=J.session?.since?Math.min(Date.parse(J.session.since),J.summons.at):J.summons.at;
      if(t-since>3600000){log('court_session_expired',{conflict_id:J.summons.conflict_id,phase:J.session?.phase??null,since:new Date(since).toISOString()});
        const k=town.conflicts.find(x=>x.conflict_id===J.summons.conflict_id);if(k&&k.trial&&!k.trial.held)k.trial.at=t+600000;   // back on the docket
        adjourn();}
    }
    const grace=judge()?480000:0;
    const due=town.conflicts.find(x=>x.status==='OPEN'&&x.trial&&!x.trial.held&&x.trial.at+grace<=t);
    if(due&&!inSession){const present=J.summons?.conflict_id===due.conflict_id?attendance():null;
      holdTrial(due,{present}).then(()=>{if(J.summons?.conflict_id===due.conflict_id)adjourn();}).catch(e=>{inSession=null;log('trial_error',{conflict_id:due.conflict_id,message:e.message});});}
    // The court's ledger: fines not yet paid are collected from the debtor's account every 5 minutes.
    if(d.collectFine&&J.fines.length&&t-(J.lastCollect??0)>300000){
      J.lastCollect=t;
      for(const f of [...J.fines]){
        const r=await d.collectFine(f.debtor,f.creditor,f.amount,f.memo).catch(()=>({paid:0}));
        if(r?.paid>0){f.amount-=r.paid;log('fine_collected',{conflict_id:f.conflict_id,debtor:f.debtor,paid:r.paid,left:f.amount});}
        if(f.amount<=0){J.fines=J.fines.filter(x=>x!==f);const c=find(f.conflict_id);
          if(c&&c.status==='TRIED'&&!J.fines.some(x=>x.conflict_id===c.conflict_id)&&!Object.keys(c.verdict?.service_quests??{}).length&&!J.jail.some(r=>r.conflict_id===c.conflict_id)&&!J.warrants.some(w=>w.conflict_id===c.conflict_id))resolve(c,'fine paid');}
      }
    }
    // A warrant nobody serves for 15 minutes: the court's bailiff locks the suspect up.
    for(const w of [...J.warrants])if(t-Date.parse(w.issued)>900000&&!J.detained[w.suspect])await imprison(w.suspect,{how:'bailiff'});
  }
  const view=()=>({
    conflicts:town.conflicts.slice(-25).reverse().map(c=>({conflict_id:c.conflict_id,timestamp:c.timestamp,tick:c.tick,party_a:nameOf(c.party_a),party_b:nameOf(c.party_b),location:c.location,reason:c.reason,
      status:c.status,kind:c.kind,complaint:c.complaint&&{by:nameOf(c.complaint.by),timestamp:c.complaint.timestamp},investigation:c.investigation&&{status:c.investigation.status,heard:(c.investigation.heard??[]).map(nameOf)},
      trial:c.trial,verdict:c.verdict&&{outcome:c.verdict.outcome,verdict:c.verdict.verdict??null,guilty:c.verdict.guilty?nameOf(c.verdict.guilty):null,confidence:c.verdict.confidence,findings:c.verdict.findings},
      jury:c.jury&&{reasons:c.jury.reasons,jurors:(c.jury.seated??c.jury.jurors).map(nameOf),tally:c.jury.tally??null,tieBreak:!!c.jury.tieBreak,bench:c.jury.bench??null,votes:(c.jury.votes??[]).map(v=>({juror:nameOf(v.juror),vote:v.vote}))},
      evidence:c.evidence.length,resolution:c.resolution})),
    jail:J.jail.map(r=>({...r,name:nameOf(r.jailed_citizen_id),minutesLeft:Math.ceil(r.remaining_ticks/1200)})),warrants:J.warrants.map(w=>({...w,name:nameOf(w.suspect)})),
    detained:Object.keys(J.detained).map(nameOf),history:J.history.slice(0,10),jailBuilt:!!jailSite(),
    counts:Object.fromEntries(STATUS.map(s=>[s,town.conflicts.filter(c=>c.status===s).length])),
    // The judicial ledger: who presides, the docket, the court in session, unpaid fines, precedents by charge.
    judge:magistrate()?{id:magistrate().id,name:nameOf(magistrate().id),title:roleOf(magistrate().id)==='judge'?'Judge':'Magistrate'}:null,
    courthouseBuilt:!!d.courtLayout?.(),
    docket:town.conflicts.filter(x=>x.status==='OPEN'&&x.trial&&!x.trial.held).sort((a,b)=>a.trial.at-b.trial.at)
      .map(x=>({case_id:x.conflict_id,plaintiff:nameOf(x.party_a),defendant:nameOf(x.party_b),charge_type:x.kind,charge:x.reason,trial_at:x.trial.scheduled_at,evidence:x.evidence.length})),
    session:J.session&&{...J.session,attendance:Object.fromEntries(Object.entries(attendance()).map(([role,a])=>[role,{name:nameOf(a.id),present:a.present}]))},
    summons:J.summons&&{conflict_id:J.summons.conflict_id,people:Object.fromEntries(Object.entries(J.summons.people).map(([r,id])=>[r,nameOf(id)]))},
    fines:J.fines.map(f=>({...f,debtor:nameOf(f.debtor),creditor:f.creditor?nameOf(f.creditor):'the town'})),
    precedents:Object.entries(J.history.reduce((m,h)=>{const k=h.kind??'dispute';(m[k]??={})[h.outcome]=(m[k][h.outcome]??0)+1;return m;},{})).map(([kind,outcomes])=>({kind,outcomes})),
  });
  function context(c){
    const r=jailed(c.id);
    if(r)return {jail:`You are in jail (${r.reason}; ${Math.ceil(r.remaining_ticks/1200)} minutes left). You cannot work or leave the cell; you may talk, eat and wait. A pardon can come from the mayor.`};
    const role=roleOf(c.id),gov=magistrate()?.id===c.id;
    if(role==='sheriff')return {justice:{investigations:investigations().map(x=>`${x.conflict_id}: ${nameOf(x.party_a)} v ${nameOf(x.party_b)}, ${x.reason}`),warrants:J.warrants.map(w=>`${nameOf(w.suspect)} (${w.conflict_id})`),inJail:J.jail.map(x=>nameOf(x.jailed_citizen_id))}};
    if(gov)return {court:{docket:town.conflicts.filter(x=>x.status==='OPEN'&&x.trial&&!x.trial.held).map(x=>`${x.conflict_id} at ${x.trial.scheduled_at.slice(11,16)} UTC: ${nameOf(x.party_a)} v ${nameOf(x.party_b)}, ${x.reason}`),inJail:J.jail.map(x=>nameOf(x.jailed_citizen_id)),
      unpaidFines:J.fines.map(f=>`${nameOf(f.debtor)} owes ${f.amount} (${f.conflict_id})`),recent:J.history.slice(0,3).map(h=>`${h.conflict_id}: ${h.verdict??h.outcome}`),
      howTo:role==='judge'?'You call the court and hold the trials yourself (it runs on its own); in your own turns, speak with gravity and only of what the ledger shows. "pardon" (to = citizen) frees someone from jail.'
        :'Trials are held on their own at the scheduled time; "pardon" (to = citizen) frees someone from jail; "mediate" settles a quarrel before it reaches court.'}};
    const sm=summonsFor(c.id);
    if(sm)return {court:`You are summoned to court as the ${sm.role} in ${sm.conflict_id}: go to the courthouse and stand at your place until the judge adjourns.`};
    return {};
  }
  return {openConflict,complain,maybeComplain,investigations,interviewees,takeStatement,fileFindings,holdTrial,warrants,detain,imprison,pardonCitizen,jailed,restricted,jailJob,
    jailDoor,cellFor,onServiceDone,tick,view,context,find,state:J,
    considerContract,nextTrial,summon,summonsFor,attendance,adjourn,replaceAbsentJurors,inSession:()=>inSession,magistrate:()=>magistrate()?.id??null};
}
