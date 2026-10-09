// Rest policy: when citizens must stop and rest, and the Hearthlight Holy Day.
//
//   REST MANDATE   at 20% energy a citizen stops whatever they are doing - building and digging included - and
//                  rests (at home, or where they are when home is far or they are down the mine) until 75%. The old
//                  rule rested from 15% to 45%, which a minute's rest covers: citizens were back to "I need a rest
//                  before I drop" a few minutes later, and builders and miners never got to rest at all (their job
//                  kept control until 10%). The thresholds live in intel/motivation.mjs (CRITICAL / RECOVERED).
//   HOLY DAY       Proposal #33 consecrated a holy day. It now recurs every seven days from the day it was adopted,
//                  and the priest (or the governor) may also call one when the town is worn out. For 4000 ticks
//                  (200 s) every non-emergency task pauses; citizens gather at the shrine, rest and pray, and come
//                  away fully rested. Emergencies still come first: the medic's triage, the guard on an alert, the
//                  jail, critical needs.

export const REST_START=20,REST_UNTIL=75;
export const HOLY_DAY_TICKS=4000,HOLY_DAY_MS=HOLY_DAY_TICKS/20*1000,HOLY_EVERY_DAYS=7;
export const WORN_OUT=35;   // average town energy at which the priest calls a holy day (at most every other day)

/** Whether a citizen should rest where they stand instead of walking home (far away or underground). */
export function restInPlace(self,home,{far=48,surface=55}={}){
  if(!self)return false;
  if(Number.isFinite(self.y)&&self.y<surface)return true;
  return !home||Math.hypot(self.x-home.x,self.z-home.z)>far;
}
/**
 * Whether a holy day begins now: the weekly day consecrated by the adopted proposal (from policy.restDay), or the
 * town worn out (average energy) and none in the last two days. Returns {reason} or null.
 */
export function holyDayDue({day,phase,policy={},last=null,avgEnergy=100}){
  if(last&&last.day===day)return null;
  const from=policy.holyFrom??policy.restDay;
  if(phase==='dawn'&&Number.isFinite(from)&&day>=from&&(day-from)%HOLY_EVERY_DAYS===0)return {reason:'the weekly Hearthlight Holy Day (Proposal #33)'};
  if(avgEnergy<WORN_OUT&&(!last||day-last.day>=2)&&['day','dawn'].includes(phase))return {reason:`the town is worn out (average energy ${Math.round(avgEnergy)}%)`};
  return null;
}

export function createRestPolicy(d){
  const {memory,configs,say=async()=>{},log=()=>{},ledger=()=>{},getSnapshot=()=>null,travel,now=()=>Date.now()}=d;
  const town=memory.data.town??={};
  const R=town.rest??={holyDay:null,lastHoly:null,holyDays:0};
  const posOf=id=>getSnapshot()?.agents?.find(a=>a.id===id)??null;
  const roleOf=id=>configs.find(c=>c.id===id)?.role??id;
  const leader=()=>configs.find(c=>c.role==='priest')??configs.find(c=>c.role==='governor');
  const place=()=>d.shrine?.()??d.square??{x:283.5,z:93.5};
  const active=()=>!!R.holyDay&&now()<R.holyDay.until;

  /** Once a tick: start a holy day when one is due, end it when its 4000 ticks are up. */
  function tick({day,phase}){
    if(R.holyDay&&now()>=R.holyDay.until){
      const h=R.holyDay;R.holyDay=null;
      // Everyone who kept the day comes away fully rested.
      for(const id of h.kept??[]){const s=memory.data.agents[id];if(s?.needs)s.needs.energy=100;if(s)s.holyRest=false;}
      log('holy_day_ended',{kept:(h.kept??[]).length});
      ledger(leader()?.id??'town',`the Hearthlight Holy Day ended; ${(h.kept??[]).length} citizens kept it and went back to work rested`);
      return;
    }
    if(R.holyDay)return;
    const energies=configs.filter(c=>c.role!=='visitor').map(c=>memory.data.agents[c.id]?.needs?.energy).filter(Number.isFinite);
    const avgEnergy=energies.length?energies.reduce((a,b)=>a+b,0)/energies.length:100;
    const due=holyDayDue({day,phase,policy:town.policy??{},last:R.lastHoly,avgEnergy});
    if(due)begin(due.reason,leader()?.id??null,day);
  }
  function begin(reason,by,day=town.day){
    const p=place();
    R.holyDay={start:now(),until:now()+HOLY_DAY_MS,place:p,reason,by,kept:[]};R.lastHoly={day,reason};R.holyDays++;
    log('holy_day_started',{reason,by,place:p,ticks:HOLY_DAY_TICKS});
    ledger(by??'town',`called the Hearthlight Holy Day (${reason}): all work pauses for prayer and rest at the shrine`);
    if(by)say(by,`Hear me, friends: today is the Hearthlight Holy Day. Lay down your tools and come to the shrine to rest.`).catch(()=>{});
    return R.holyDay;
  }
  /**
   * A citizen's holy-day job (null when there is none or they are excused): walk to the shrine and rest there.
   * Emergencies are excused by the caller (triage, guard on alert, jail, critical needs come first).
   */
  function holyJob(c,s,self){
    if(!active()||c.role==='visitor')return null;
    const h=R.holyDay,p=h.place;
    return async()=>{
      if(Math.hypot(self.x-p.x,self.z-p.z)>6){s.holyRest=false;if(!(self.pathing||['moving','loading'].includes(self.navigation?.status)))await travel(c.id,self,{x:p.x+(Math.random()-0.5)*6,y:Math.round(self.y),z:p.z+(Math.random()-0.5)*6}).catch(()=>{});return;}
      if(!s.holyRest){s.holyRest=true;if(!h.kept.includes(c.id)){h.kept.push(c.id);log('holy_day_kept',{agent:c.id});}}
    };
  }
  return {tick,begin,holyJob,active,
    view:()=>({holyDay:R.holyDay&&{...R.holyDay,secondsLeft:Math.max(0,Math.round((R.holyDay.until-now())/1000)),kept:R.holyDay.kept.length},lastHoly:R.lastHoly,holyDays:R.holyDays,restStart:REST_START,restUntil:REST_UNTIL}),
    context(c){return active()?{holyDay:`Today is the Hearthlight Holy Day (${R.holyDay.reason}): no work - rest and pray at the shrine.`}:{};},
    state:R};
}
