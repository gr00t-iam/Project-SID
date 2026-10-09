// Navigation leases: one job steers a citizen at a time.
//
// The worker picks a new job for a citizen every tick, and a model turn can run beside it. A job that sends the
// citizen walking returns at once while the plugin keeps walking, so the next tick's job (a different kind) used to
// send it somewhere else - and back - each invalidating the other's walk (the "overlapping jobs" in the stall logs).
//
// A lease: the job that last sent the citizen walking holds it until the walk ends (not pathing any more), 60 s pass,
// or the watchdog clears it after a stall. While it holds:
//   - the same kind of job may change the destination;
//   - a job of equal or higher priority (urgent work, survival, player orders, night, shelter) takes over;
//   - a lower-priority job or a model turn is refused with a clear "busy" error (callers already handle errors);
//   - the watchdog and court actions (override) always pass.
// Destinations that stalled twice in 10 minutes are refused outright for that citizen (main.mjs watchdog fills
// `blocked`), so jobs pick another way instead of walking into the same wall.

export const MOVES=new Set(['move','pathfind','travel','wait','climb']);
const LEASE_MS=60000;
/** Priority of a worker job kind (main.mjs jobInfo kinds). Higher may take the lease from lower. */
export function navPriority(kind=''){
  if(/^(step aside|leave warehouse|eat \(crowded\)|shelter|jail|watchdog)/.test(kind))return 4;
  if(/^(urgent|survival|order:|court|triage)/.test(kind))return 3;
  if(/^(home \(night\)|rhythm|build|dig|work order|role|farm|guard)/.test(kind))return 2;
  if(/^(life|farm plot)/.test(kind))return 2;
  return 1;   // routine / idle, hobbies, model turns
}
/** A destination rounded to a 2-block cell, for remembering dead ends. */
export const destKey=p=>`${Math.round(p.x/2)},${Math.round(p.z/2)}`;
/**
 * Throws when this movement must not happen now; records the lease when it may. ctx is the AsyncLocalStorage store:
 * {agent, job, worker, model, override, priority}.
 */
export function navGuard(id,action,{ctx,leases,blocked,self,now=Date.now()}){
  if(!MOVES.has(action.type))return;
  if(ctx?.override)return;
  const dest=Number.isFinite(action.x)&&action.type!=='wait'?{x:action.x,z:action.z}:null;
  if(dest&&ctx?.agent===id){
    const b=blocked.get(id)?.get(destKey(dest));
    if(b&&b.until>now)throw Error(`No way to ${Math.round(dest.x)},${Math.round(dest.z)} right now (it stalled twice); try another place or wait`);
  }
  const lease=leases.get(id);
  const walking=!!self&&(self.pathing||['moving','loading'].includes(self.navigation?.status));
  const held=lease&&walking&&now-lease.at<LEASE_MS;
  if(ctx?.worker&&ctx.agent===id){
    if(held&&lease.job!==ctx.job&&(ctx.priority??1)<lease.priority)throw Error(`Busy: still on the way for "${lease.job}"`);
    leases.set(id,{job:ctx.job,priority:ctx.priority??1,at:now,dest});
    return;
  }
  // Model turns, other citizens' jobs and background tasks may move a citizen only when no job is steering it.
  if(held)throw Error(`Busy: ${ctx?.model?'your current job':`"${lease.job}"`} is walking you somewhere right now; chat, or wait until you arrive`);
}
