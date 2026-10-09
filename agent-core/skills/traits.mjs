// Stable personal traits (0..1) that change what a citizen does, not just how it talks:
//   sociability     how often it joins the evening gathering, how long it stays
//   patience        failed walks before trying another standing spot; how long it waits on a blocked site
//   risk_tolerance  scaffold positions tried per roof section before calling the section blocked
//   generosity      sharing food with a hungry neighbour at the gathering
//   craftsmanship   rework passes on a block the inspection keeps finding wrong before it is set aside
// Derived once from the citizen's values (cognition.mjs) and personality words, with a small stable jitter per
// citizen, and kept in its state (state.traits) - the same citizen behaves the same way across restarts.

export const TRAIT_KEYS=['sociability','patience','risk_tolerance','generosity','craftsmanship'];
const clamp=v=>Math.round(Math.max(0.05,Math.min(0.95,v))*100)/100;
function jitter(id,k){let h=2166136261;for(const ch of `${id}:${k}`){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return ((h>>>0)%1000)/1000*0.2-0.1;}
const cue=(text,re,w)=>re.test(text)?w:0;

export function traitsFor(id,values={},personality=''){
  const v=k=>values[k]??0.5,t=String(personality).toLowerCase();
  return {
    sociability:clamp(v('sociability')+cue(t,/sociable|chatty|warm|friendly|outgoing/,0.1)-cue(t,/quiet|reserved|solitary|gruff/,0.15)+jitter(id,'s')),
    patience:clamp(0.5+0.3*(v('tradition')-0.5)+0.3*(v('craftsmanship')-0.5)-0.2*(v('curiosity')-0.5)+cue(t,/patient|calm|steady|meticulous|methodical|serene/,0.15)-cue(t,/impatient|restless|quick-tempered|hasty/,0.2)+jitter(id,'p')),
    risk_tolerance:clamp(0.5-0.6*(v('selfPreservation')-0.5)+0.3*(v('curiosity')-0.5)+cue(t,/bold|brave|daring|adventurous/,0.15)-cue(t,/cautious|careful|risk-averse|timid/,0.15)+jitter(id,'r')),
    generosity:clamp(0.5+0.6*(v('community')-0.5)+cue(t,/generous|kind|warm|giving/,0.15)-cue(t,/stingy|greedy|miserly|hard-nosed/,0.2)+jitter(id,'g')),
    craftsmanship:clamp(v('craftsmanship')+cue(t,/meticulous|precise|careful|proud of (his|her|their) work|master/,0.1)+jitter(id,'c')),
  };
}
/** Joins tonight's gathering? Very sociable citizens always do; the least sociable about one evening in three. */
export function joinsGathering(traits,day,id){
  const s=traits?.sociability??0.5;if(s>=0.7)return true;
  let h=0;for(const ch of `${id}:${day}`)h=(h*31+ch.charCodeAt(0))>>>0;
  return (h%100)/100<0.3+s;
}
