// Gossip: rumors about real events spread between citizens who are close enough to talk (the evening gathering,
// chance conversations), and change as they go.
//
//   Rumor {id, origin_citizen_id, subject_id, event_type, veracity 0..1, details, timestamp, hops, heard_from, level}
//
// A rumor starts true (veracity 1) from someone who saw or took part in the event. Each time it is retold, the teller
// may distort it - more likely when the teller is unreliable or dislikes the subject (bias) - and a distorted rumor
// climbs its event's ladder ("a fee was booked wrong" -> "the Banker is skimming fees" -> "the Banker is stealing
// from the vault!") while its veracity drops. Hearing a rumor changes how the listener sees the subject, scaled by
// how much the listener trusts the teller. All copies of one story share an id: nobody hears the same story twice.

export const LADDERS={
  bank_error:['{s} booked a fee wrong at the bank','{s} is skimming fees at the bank','{s} is stealing from the vault!'],
  theft:['{s} took {n} emeralds from the treasury','{s} has been stealing from the treasury for weeks','{s} emptied the treasury and hid a sack of emeralds!'],
  quarrel:['{s} and {o} argued about {r}','{s} shouted {o} down over {r}','{s} came to blows with {o}!'],
  arrest:['{s} was locked up for {r}','{s} is a hardened criminal','{s} is dangerous - lock your doors!'],
  verdict:['the court ruled against {s} over {r}','{s} only got off lightly because of friends at the town hall','{s} bribed the magistrate!'],
  vote:['{s} voted against the {r}','{s} is working against the town','{s} wants the town to fail!'],
  conversion:['{s} joined the {r}','{s} was talked into the {r}','{s} has been bewitched by the priest!'],
  kindness:['{s} helped {o} with {r}','{s} is the kindest soul in town','{s} would give you the shirt off their back'],
  romance:['{s} and {o} walked home together','{s} and {o} are courting','{s} and {o} are secretly engaged!'],
};
// How hard each kind of story hits the subject's standing when believed (negative = harmful).
export const SEVERITY={bank_error:-0.15,theft:-0.5,quarrel:-0.15,arrest:-0.4,verdict:-0.2,vote:-0.1,conversion:0,kindness:0.25,romance:0.05};
const fill=(t,v)=>t.replace(/\{(\w)\}/g,(_,k)=>v[k]??'');

/** A true rumor about a real event. */
export function seedRumor({id,origin,subject,event_type,vars={},time=Date.now()}){
  const ladder=LADDERS[event_type]??['{s} did something worth talking about'];
  return {id,origin_citizen_id:origin,subject_id:subject,event_type,veracity:1,details:fill(ladder[0],vars),timestamp:new Date(time).toISOString(),hops:0,heard_from:origin,level:0,vars};
}
/** Chance the teller twists the story: unreliable tellers and those biased against the subject embellish. */
export function distortionChance({tellerReliability=0.5,bias=0}={}){
  return Math.max(0,Math.min(0.9,0.12+0.45*Math.max(0,bias)+0.35*(1-tellerReliability)));
}
/**
 * The listener's copy after one retelling. bias: how much the teller dislikes the subject (0..1), tellerReliability 0..1.
 * Positive stories distort upward too (they grow rosier); the ladder tops out.
 */
export function retell(rumor,{teller,bias=0,tellerReliability=0.5,random=Math.random,time=Date.now()}={}){
  const copy={...rumor,hops:rumor.hops+1,heard_from:teller,timestamp:new Date(time).toISOString()};
  const ladder=LADDERS[rumor.event_type];
  if(ladder&&random()<distortionChance({tellerReliability,bias})&&rumor.level<ladder.length-1){
    copy.level=rumor.level+1;copy.details=fill(ladder[copy.level],rumor.vars??{});copy.veracity=Math.round(rumor.veracity*0.55*100)/100;copy.distorted_by=[...(rumor.distorted_by??[]),teller];
  }else copy.veracity=Math.round(rumor.veracity*0.95*100)/100;
  return copy;
}
/** How much hearing it moves the listener's trust in the subject (-1..1 scale before the caller's units). */
export function impactOf(rumor,{trustInTeller=0.5}={}){
  const sev=SEVERITY[rumor.event_type]??0;
  return Math.round(sev*(0.4+0.6*trustInTeller)*(1+0.5*rumor.level)*100)/100;
}
/** The juiciest story a teller knows that the listener has not heard. */
export function pickToTell(known=[],listenerKnows=[],{except=[]}={}){
  const seen=new Set(listenerKnows.map(r=>r.id));
  return known.filter(r=>!seen.has(r.id)&&!except.includes(r.subject_id)).sort((a,b)=>Math.abs(SEVERITY[b.event_type]??0)*(1+b.level)-Math.abs(SEVERITY[a.event_type]??0)*(1+a.level)||Date.parse(b.timestamp)-Date.parse(a.timestamp))[0]??null;
}
/** Keeps a citizen's rumor list short: the newest dozen, one copy per story. */
export function learn(list=[],rumor,max=12){
  if(list.some(r=>r.id===rumor.id))return list;
  return [rumor,...list].slice(0,max);
}
