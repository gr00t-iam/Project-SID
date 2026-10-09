// Module 4: ReAct reflection and failure recovery. A failed action is classified, never blindly repeated,
// and reflected on by the utility model (offload server first), which picks a corrective action or another
// strategy. Up to 3 reflections per sub-task; then the sub-task is FAILED and its goal is re-planned.
// Without a model (servers down or slow) simple rules pick the recovery instead.

export const EXCEPTIONS={
  PathBlockedException:/obstruct|unreachable|too far|out of reach|stand within|destination|no path|stuck|walk there|within \d+ blocks/i,
  ContainerEmptyException:/has no|out of |empty|not enough|missing ingredients|you have no|treasury only|nothing placed|need the input|need \d+/i,
  TargetMissingException:/unknown or offline|not online|invalid or out-of-reach|no open|unknown item|cannot be mined|nothing to forage|not found|no longer|unknown block|must be within/i,
};
/** Exception type for an error message. */
export function classify(message){
  for(const [name,re] of Object.entries(EXCEPTIONS))if(re.test(String(message)))return name;
  return 'ActionFailedException';
}
/** Identity of an action for "do not repeat the same failed command" (type, target and rounded place). */
export const signature=a=>`${a?.type}:${String(a?.target??'').toUpperCase()}:${a?.to??''}:${Math.round(a?.x??0)},${Math.round(a?.z??0)}`;
export const STRATEGIES=['alternate_action','skip','request_help','replan','wait'];

/** Rule-based recovery when no model answers. */
export function ruleRecovery(type,{action,self}={}){
  switch(type){
    case 'PathBlockedException':{
      // Try a nearby spot in a different direction, or give the step up if we are already close.
      if(action&&['move','pathfind'].includes(action.type)&&self){
        const angle=Math.atan2(action.z-self.z,action.x-self.x)+Math.PI/2;
        return {strategy:'alternate_action',reflection:'The way is blocked; approach from the side instead.',
          action:{...action,type:'pathfind',x:Math.round(action.x+Math.cos(angle)*4)+0.5,z:Math.round(action.z+Math.sin(angle)*4)+0.5}};
      }
      return {strategy:'skip',reflection:'Cannot reach it; try another source or target.'};
    }
    case 'ContainerEmptyException':return {strategy:'request_help',reflection:'What I need is not there; ask the town for it on the work order board.'};
    case 'TargetMissingException':return {strategy:'skip',reflection:'The target is gone or out of reach; move on to the next option.'};
    default:return {strategy:'replan',reflection:'This approach is not working; rethink the plan.'};
  }
}
const PROMPT='You are the practical inner voice of a Minecraft villager whose action just failed. Reflect briefly on why it failed and choose a corrective action or an alternate strategy. Never repeat the exact failed action. '+
  'strategy is one of: "alternate_action" (give action: a different action with the same fields as a plan action), "skip" (drop this step/source and move on), "request_help" (ask others for the missing item on the work order board), "replan" (the goal needs a new plan), "wait" (conditions will change soon). '+
  'Return ONLY JSON {"reflection":"one or two sentences","strategy":"...","action":{"type":"...","x":0,"y":0,"z":0,"target":"","text":"","to":"","count":1}}; omit action unless strategy is alternate_action.';

export function createReflector(db,{lm,log=()=>{},now=()=>Date.now(),isOffline=e=>!!e?.offline,maxAttempts=3}={}){
  const failures=new Map();   // agent -> Map(signature -> {time,error})
  const attempts=new Map();   // subject -> {n,time}
  /** Remembers a failed action so the same command is refused for 3 minutes. */
  function noteFailure(agent,action,error){
    const m=failures.get(agent)??new Map();failures.set(agent,m);
    m.set(signature(action),{time:now(),error:String(error).slice(0,200)});
    for(const [k,v] of m)if(now()-v.time>180000)m.delete(k);
  }
  /** The error if this exact action failed for this agent in the last 3 minutes. */
  const repeatOf=(agent,action)=>{const f=failures.get(agent)?.get(signature(action));return f&&now()-f.time<180000?f.error:null;};
  const attemptsFor=subject=>{const a=attempts.get(subject);return a&&now()-a.time<20*60000?a.n:0;};
  const clear=subject=>attempts.delete(subject);
  /**
   * Reflects on a failure. subject identifies the sub-task (a goal milestone, or the agent's free action).
   * Returns {attempt, giveUp, type, strategy, reflection, action?, source}.
   */
  async function reflect({agent,persona,subject,action,error,location,goal,situation}){
    const type=classify(error);
    if(action)noteFailure(agent,action,error);
    const n=attemptsFor(subject)+1;attempts.set(subject,{n,time:now()});
    if(n>maxAttempts){
      db.run('INSERT INTO reflections(agent,subject,action_json,error_type,error,goal,attempt,reflection,outcome,source,time) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        agent,subject,JSON.stringify(action??null),type,String(error).slice(0,300),goal??null,n,'Out of attempts.','FAILED','rules',now());
      log('reflection_gave_up',{agent,subject,type});
      return {attempt:n,giveUp:true,type,strategy:'replan',reflection:'Out of attempts.'};
    }
    let result=null,source='llm';
    if(lm&&lm.online!==false){
      try{
        const where=location?`${Math.round(location.x)},${Math.round(location.y??0)},${Math.round(location.z)}`:'unknown';
        // First attempts: the fast utility model. The same sub-task failing again: the deeper model, when both are online.
        const deep=n>=2&&lm.mode==='teamwork';if(deep)source='llm-deep';
        const text=await (deep?lm.callPrimaryTask.bind(lm,'deep_reflection'):lm.callUtilityTask.bind(lm,'failure_reflection'))(PROMPT,{
          situation:`Your action '${action?.type??'task'}' at ${where} failed with error: '${String(error).slice(0,200)}'. Your current goal is '${goal??'none'}'. Reflect on why this failed and choose a corrective action or alternate strategy.`,
          failedAction:action,exception:type,attempt:n,of:maxAttempts,you:persona,...(situation?{context:situation}:{})});
        const body=String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g,'').replace(/```(?:json)?/g,'');
        const r=JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));
        if(STRATEGIES.includes(r.strategy))result={strategy:r.strategy,reflection:String(r.reflection??'').slice(0,300),
          action:r.strategy==='alternate_action'&&r.action&&typeof r.action==='object'?r.action:undefined};
      }catch(e){if(!isOffline(e))log('reflection_error',{agent,message:e.message});}
    }
    if(!result){result=ruleRecovery(type,{action,self:location});source='rules';}
    // The model sometimes proposes the very thing that failed: fall back to the rules then.
    if(result.action&&signature(result.action)===signature(action)){result=ruleRecovery(type,{action,self:location});source='rules';}
    db.run('INSERT INTO reflections(agent,subject,action_json,error_type,error,goal,attempt,reflection,corrective_json,outcome,source,time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      agent,subject,JSON.stringify(action??null),type,String(error).slice(0,300),goal??null,n,result.reflection,JSON.stringify(result.action??null),result.strategy,source,now());
    log('reflection',{agent,subject,type,attempt:n,strategy:result.strategy,source});
    return {attempt:n,giveUp:false,type,source,...result};
  }
  const recent=(limit=20)=>db.all('SELECT * FROM reflections ORDER BY id DESC LIMIT ?',limit);
  return {reflect,noteFailure,repeatOf,attemptsFor,clear,recent,classify};
}
