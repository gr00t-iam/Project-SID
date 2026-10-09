// The jury: when a case is serious or unclear, the court seats an impartial panel of citizens who hear the evidence,
// deliberate in their own manner and vote. Pure functions only; skills/justice.mjs runs them in the courtroom and
// roles/judge.mjs presides.
//
//   needsJury        bench trial (judge alone) for minor matters; a jury for repeat offenders, theft and assault,
//                    high-value contracts and cases where the evidence is unclear
//   selectJury       3 jurors (5 for the gravest cases) from the town, never the parties, the judge, the sheriff or
//                    a witness, and never anyone who trusts or likes either party too much or too little (|x| > 0.8)
//   jurorVote        GUILTY / NOT_GUILTY / ABSTAIN from the evidence score, the juror's traits (generous, patient and
//                    bold citizens are more lenient; meticulous, traditional ones stricter) and how they feel about the
//                    defendant - with a reason that only uses facts from the record
//   tally            a two-thirds supermajority of the votes cast decides; otherwise the jury is hung

export const JURY_SMALL=3,JURY_LARGE=5,CONFLICT=0.8;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const label=k=>String(k??'goods').toLowerCase().replace(/_/g,' ');

/**
 * Bench or jury. preview = weighEvidence() on what is known before the trial. Returns {jury, size, reasons:[text]}.
 */
export function needsJury(c,{priors={},preview=null}={}){
  const def=c.party_b,reasons=[];
  if((priors[def]??0)>=1)reasons.push(`repeat offence (${priors[def]} earlier conviction${priors[def]>1?'s':''})`);
  if(['theft','assault'].includes(c.kind))reasons.push(`a serious charge (${c.kind})`);
  const o=c.order;
  if(c.kind==='contract'&&o&&(o.quantity>=64||(o.upfront??0)>=5||(o.reward??0)>=10))reasons.push(`a high-value contract (${o.quantity} ${label(o.item)}${o.upfront?`, ${o.upfront} emeralds advanced`:''})`);
  if(preview&&c.kind!=='contract'&&(preview.fault==='both'||preview.confidence<0.7))reasons.push('the evidence is unclear');
  if(preview?.findings?.some(f=>/false testimony|but .* saw them/.test(f)))reasons.push('testimony contradicts the record');
  const jury=reasons.length>0;
  return {jury,size:jury&&(reasons.length>=2||(priors[def]??0)>=2)?JURY_LARGE:JURY_SMALL,reasons};
}

/**
 * The panel. candidates: citizen ids who could serve; relation(a,b) -> {trust, affinity} in -1..1.
 * Returns {jurors, alternates, disqualified:[{id, why}]}.
 */
export function selectJury(c,{candidates,relation=()=>null,random=Math.random,size=JURY_SMALL,exclude=[]}){
  const parties=[c.party_a,c.party_b],witnesses=new Set(c.evidence.filter(e=>['sighting','statement'].includes(e.kind)).map(e=>e.by));
  const disqualified=[],ok=[];
  for(const id of candidates){
    if(parties.includes(id)||exclude.includes(id)){continue;}
    if(witnesses.has(id)){disqualified.push({id,why:'a witness in this case'});continue;}
    const tie=parties.map(p=>({p,r:relation(id,p)})).find(({r})=>r&&(Math.abs(r.affinity??0)>CONFLICT||Math.abs(r.trust??0)>CONFLICT));
    if(tie){disqualified.push({id,why:`too close to call it fairly (${tie.r.affinity>0||tie.r.trust>0?'devoted to':'at odds with'} ${tie.p})`});continue;}
    ok.push(id);
  }
  // A fair draw: shuffle (seeded by the court's random) and take the first `size`; the rest are alternates.
  const pool=ok.map(id=>({id,k:random()})).sort((a,b)=>a.k-b.k).map(x=>x.id);
  return {jurors:pool.slice(0,size),alternates:pool.slice(size),disqualified};
}

/** The one fact a juror leans on, from the record only (names already applied by the caller). */
export function keyFact(c,findings=[]){
  const o=c.order;
  if(c.kind==='contract'&&o)return `The ledger shows ${o.delivered} of ${o.quantity} ${label(o.item)} delivered by the deadline`;
  return findings[0]?findings[0].replace(/\s+/g,' ').replace(/^./,ch=>ch.toUpperCase()).slice(0,140):'The record says little';
}

/**
 * One juror's ballot. evidence: {fault, defendant, confidence, falseTestimony, partial}; traits 0-1 (patience,
 * generosity, risk_tolerance, craftsmanship); values 0-1 (tradition); affinity to the defendant -1..1.
 * Returns {vote, score, reason} - the reason quotes the key fact and the juror's own leaning, nothing invented.
 */
export function jurorVote({evidence,traits={},values={},affinity=0,fact,round=1,pull=0,random=Math.random}){
  const t=k=>traits[k]??0.5;
  const base=evidence.fault===evidence.defendant?evidence.confidence:evidence.fault==='both'?0.45:0.1;
  const lenient=0.3*(t('generosity')-0.5)+0.2*(t('risk_tolerance')-0.5)+0.2*(t('patience')-0.5)+(evidence.partial?0.1:0);
  const strict=0.3*(t('craftsmanship')-0.5)+0.2*((values.tradition??0.5)-0.5)+(evidence.falseTestimony?0.2:0);
  const score=clamp(base-lenient+strict-0.3*clamp(affinity,-CONFLICT,CONFLICT)+pull+(random()-0.5)*0.12,0,1);
  // A second round narrows the undecided band: a juror who abstained must lean one way or the other.
  const [hi,lo]=round>1?[0.5,0.5]:[0.6,0.35];
  const vote=score>=hi?'GUILTY':score<lo?'NOT_GUILTY':'ABSTAIN';
  // Each juror's own leaning, in their own terms (strict or lenient), plus what the record says of the testimony.
  const why=vote==='GUILTY'
    ?[strict>lenient+0.1?'a promise made is a promise kept':lenient>strict?'I would rather show mercy, but the record is plain':'that is enough for me',
      evidence.falseTestimony?'and the defendant\'s story does not match the ledger':null].filter(Boolean).join(', ')
    :vote==='NOT_GUILTY'
      ?(evidence.fault!==evidence.defendant?'the record does not show it was their doing':evidence.partial?'some of it arrived, and that counts for something':'I can find room for mercy here')
      :'I cannot be sure either way';
  return {vote,score:Math.round(score*100)/100,reason:`${fact}; ${why}.`};
}

/** Two thirds of the votes cast (at least two) decide; anything else is a hung jury. */
export function tally(votes){
  const g=votes.filter(v=>v.vote==='GUILTY').length,n=votes.filter(v=>v.vote==='NOT_GUILTY').length,cast=g+n,need=Math.ceil(cast*2/3);
  const result=cast>=2&&g>=need&&g>n?'GUILTY':cast>=2&&n>=need&&n>g?'NOT_GUILTY':'HUNG';
  return {result,guilty:g,notGuilty:n,abstain:votes.length-cast,cast};
}
