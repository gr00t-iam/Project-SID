// Internal needs and the daily rhythm (circadian schedule).
//
// needs (all 0..1, 0 = fine, 1 = desperate):
//   hunger         from the existing food bar (state.needs.hunger 0-20, 20 = full): 1 - hunger/20
//   fatigue        from the existing energy (state.needs.energy 0-100): 1 - energy/100
//   socialization  loneliness: grows while alone, eases in company and at the evening gathering (state.needs.social)
//   comfort        misery: rain without shelter, injury, no bed of one's own; eases at home and in good company (state.needs.comfort)
// Hunger and fatigue keep their old scales (every eating/sleeping rule uses them); heavy labour wears faster (town.mjs updateNeeds).
//
// schedule_phase from the world clock:  DAWN_PREP (wake, eat)  WORK_SHIFT (the job)  DUSK_SOCIAL (the gathering)  NIGHT_REST (own bed)

export const PHASES=['DAWN_PREP','WORK_SHIFT','DUSK_SOCIAL','NIGHT_REST'];
const PHASE_OF={dawn:'DAWN_PREP',day:'WORK_SHIFT',evening:'DUSK_SOCIAL',night:'NIGHT_REST'};
/**
 * The schedule phase from the world clock (ticks, 24000 a day) - or a town day phase name (dawn/day/evening/night).
 * The gathering starts before sunset (tick 9000): with the plugin's 30-minute day it lasts about 8 real minutes.
 *   DAWN_PREP 23000-1500 · WORK_SHIFT 1500-9000 · DUSK_SOCIAL 9000-13000 · NIGHT_REST 13000-23000
 */
export function schedulePhase(t){
  if(typeof t==='string')return PHASE_OF[t]??'WORK_SHIFT';
  if(!Number.isFinite(t))return 'WORK_SHIFT';
  const w=((t%24000)+24000)%24000;
  return w<1500||w>=23000?'DAWN_PREP':w<9000?'WORK_SHIFT':w<13000?'DUSK_SOCIAL':'NIGHT_REST';
}
const clamp01=v=>Math.max(0,Math.min(1,Math.round(v*1000)/1000));

/** The four needs as 0..1 from a citizen's state. */
export function needsOf(n={}){
  return {hunger:clamp01(1-(n.hunger??20)/20),fatigue:clamp01(1-(n.energy??100)/100),socialization:clamp01(n.social??0.2),comfort:clamp01(n.comfort??0.2)};
}
/**
 * Advances loneliness and discomfort by dt seconds. ctx: {company: citizens within talking range, socializing (at a
 * gathering or in a conversation), raining, sheltered, hurt (0..1 health lost), atHome, ownBed, resting}.
 * Returns {social, comfort}. Roughly: alone for a whole town day (35 min) -> lonely; an evening gathering -> fulfilled.
 */
export function decaySocialComfort(n,dt,{company=0,socializing=false,raining=false,sheltered=false,hurt=0,atHome=false,ownBed=true,resting=false}={}){
  let social=n.social??0.2,comfort=n.comfort??0.2;
  if(socializing)social-=dt/240;else if(company>0)social-=dt/1200*Math.min(3,company);else social+=dt/2100;
  const misery=(raining&&!sheltered?1:0)+hurt*1.5+(resting&&!ownBed?0.6:0);
  if(misery>0)comfort+=dt/900*misery;else comfort-=dt/(atHome||socializing?600:1800);
  return {social:clamp01(social),comfort:clamp01(comfort)};
}
/** What the needs push a citizen to do, most urgent first (the runtime's eat, nap, gather and home jobs carry it out). */
export function drives(needs){
  const out=[];
  if(needs.hunger>=0.6)out.push('eat');
  if(needs.fatigue>=0.8)out.push('rest');
  if(needs.socialization>=0.7)out.push('company');
  if(needs.comfort>=0.7)out.push('shelter');
  return out;
}
/**
 * The mood line injected into the planning prompt, and how the needs colour judgement: an irritable citizen is less
 * likely to accept proposals or be moved by sermons (voteBias is added to a vote score; persuadability scales
 * conversion chances).
 */
export function moodOf(needs,{morale=null,stress=null}={}){
  const pct=v=>Math.round(v*100);
  const parts=[];
  if(needs.fatigue>=0.8)parts.push(`exhausted (Fatigue: ${pct(needs.fatigue)}%)`);else if(needs.fatigue>=0.55)parts.push(`tired (Fatigue: ${pct(needs.fatigue)}%)`);
  if(needs.hunger>=0.8)parts.push(`starving (Hunger: ${pct(needs.hunger)}%)`);else if(needs.hunger>=0.5)parts.push(`hungry (Hunger: ${pct(needs.hunger)}%)`);
  if(needs.socialization>=0.7)parts.push(`lonely (Socialization: ${pct(needs.socialization)}%)`);
  if(needs.comfort>=0.7)parts.push(`miserable (Comfort: ${pct(needs.comfort)}%)`);
  const strain=Math.max(needs.hunger,needs.fatigue)*0.6+needs.comfort*0.25+needs.socialization*0.15+(stress!=null&&stress>60?0.15:0)-(morale!=null&&morale>70?0.1:0);
  const irritable=strain>=0.55;
  const effects=irritable?' You are quick-tempered, irritable, and less likely to accept proposals or sermons.'
    :needs.socialization>=0.7?' You long for company and are eager to talk.'
    :parts.length?'':'';
  const text=parts.length?`CURRENT STATE: You are ${parts.length>1?parts.slice(0,-1).join(', ')+' and '+parts.at(-1):parts[0]}.${effects}`
    :'CURRENT STATE: You are well fed, rested and comfortable.';
  return {text,irritable,strain:Math.round(strain*100)/100,voteBias:irritable?-0.25:0,persuadability:irritable?0.6:needs.socialization>=0.7?1.15:1};
}
/**
 * When to eat, as a gradual priority instead of a switch (hunger 0..1):
 *   under 0.4     no meal yet
 *   0.4 - 0.75    a citizen in the middle of a job (owner) waits for a natural break - a finished layer, a scaffold
 *                 taken down, a blocker - or until the meal is `deadlineMs` overdue; anyone else eats now
 *   0.75 and up   critical: the job is paused safely (its state stays in memory) and the citizen eats at once
 * Returns {eat, wait, reason, hungrySince} (hungrySince carries the moment hunger first crossed 0.4).
 */
export function mealDecision(n,{owner=false,breakpoint=false,hungrySince=null,now=Date.now(),deadlineMs=240000}={}){
  const h=n?.hunger??0;
  if(h<0.4)return {eat:false,wait:false,hungrySince:null};
  const since=hungrySince??now;
  if(h>=0.75)return {eat:true,reason:'critical hunger',hungrySince:since};
  if(!owner)return {eat:true,reason:'hungry',hungrySince:since};
  if(breakpoint)return {eat:true,reason:'meal at a natural break',hungrySince:since};
  if(now-since>=deadlineMs)return {eat:true,reason:'meal overdue',hungrySince:since};
  return {eat:false,wait:true,reason:'finishing this part first',hungrySince:since};
}
