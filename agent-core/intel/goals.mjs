// Module 2: hierarchical goals. A goal ("Build the town hall", "Prepare the winter food reserve") is split by
// the macro planner (primary model, Muse Glimmer) into milestones drawn from a fixed vocabulary that the
// deterministic micro executor (executor.mjs) knows how to carry out. Goal trees live in agent_goals:
//   goal (kind 'goal') -> milestones (kind 'milestone', ordered by seq)
//   states: PENDING, IN_PROGRESS, PAUSED, COMPLETED, FAILED
import {randomUUID} from 'node:crypto';
import {json} from './db.mjs';

export const STATES=['PENDING','IN_PROGRESS','PAUSED','COMPLETED','FAILED'];
// Milestone vocabulary: type -> required fields.
export const MILESTONES={
  GATHER:['item','quantity'],     // have `quantity` of `item` in hand: inventory, warehouse, remembered sources, or a work order
  CRAFT:['item','quantity'],      // make `quantity` of `item` (ingredients gathered first when the recipe is known)
  SMELT:['item','quantity'],      // smelt `quantity` of `item` (the raw input, e.g. RAW_IRON)
  DELIVER:['item','quantity'],    // bring it to `to` ("warehouse" or a citizen id)
  REQUEST:['item','quantity'],    // post a work order and wait for delivery
  GOTO:['x','z'],                 // walk there
  FARM:['crop'],                  // start tending a farm plot (farmers)
  BUILD:['site'],                 // build a planned town site or council-funded stage (builders)
  SAY:['text'],                   // announce something
  WAIT:['minutes'],               // give something time (crops, smelting, a delivery)
};
const ITEM=/^[A-Z][A-Z0-9_]{1,40}$/;
/** Cleans up a model-proposed milestone list: known types, required fields, sane values, at most 8. */
export function validateMilestones(list){
  const out=[];
  for(const m of Array.isArray(list)?list:[]){
    const type=String(m?.type??'').toUpperCase();if(!MILESTONES[type])continue;
    const spec={type,title:String(m.title??'').slice(0,80)};
    for(const k of ['item','to','crop','site','text'])if(m[k]!=null)spec[k]=String(m[k]).slice(0,k==='text'?160:40);
    if(spec.item)spec.item=spec.item.toUpperCase().replace(/\s+/g,'_');
    if(spec.crop)spec.crop=spec.crop.toUpperCase().replace(/\s+/g,'_');
    for(const k of ['quantity','x','z','minutes'])if(m[k]!=null&&Number.isFinite(Number(m[k])))spec[k]=Math.round(Number(m[k]));
    if(spec.quantity!=null)spec.quantity=Math.max(1,Math.min(256,spec.quantity));
    if(spec.minutes!=null)spec.minutes=Math.max(1,Math.min(30,spec.minutes));
    if(MILESTONES[type].some(k=>spec[k]==null))continue;
    if(spec.item&&!ITEM.test(spec.item))continue;
    // 0,0 is the model's placeholder for "somewhere", not a destination (with no travel limit it would walk to spawn).
    if(type==='GOTO'&&spec.x===0&&spec.z===0)continue;
    if(!spec.title)spec.title=`${type.toLowerCase()} ${spec.quantity??''} ${String(spec.item??spec.crop??spec.site??spec.text??'').toLowerCase().replace(/_/g,' ')}`.replace(/\s+/g,' ').trim();
    out.push(spec);
    if(out.length>=8)break;
  }
  return out;
}
/** Deterministic plans for common objectives, used when no model answers (or its plan is unusable). */
export function templatePlan(objective,{role}={}){
  const o=String(objective).toLowerCase();
  if(/winter|food reserve|pantry|feed the town|food supply/.test(o)){
    if(role==='fisher')return [{type:'GATHER',item:'COOKED_COD',quantity:16,title:'Catch and cook 16 fish'},{type:'DELIVER',item:'COOKED_COD',quantity:16,to:'warehouse',title:'Store the fish in the pantry'}];
    return [{type:'GATHER',item:'WHEAT',quantity:48,title:'Gather 48 wheat'},{type:'CRAFT',item:'BREAD',quantity:16,title:'Bake 16 bread'},
      {type:'DELIVER',item:'BREAD',quantity:16,to:'warehouse',title:'Store the bread in the pantry'}];
  }
  if(/wood|plank|log|timber|lumber/.test(o))return [{type:'GATHER',item:'OAK_LOG',quantity:16,title:'Gather 16 oak logs'},{type:'CRAFT',item:'OAK_PLANKS',quantity:64,title:'Saw 64 oak planks'},
    {type:'DELIVER',item:'OAK_PLANKS',quantity:64,to:'warehouse',title:'Stock the warehouse with planks'}];
  if(/pickaxe|tools?/.test(o))return [{type:'GATHER',item:'IRON_INGOT',quantity:3,title:'Get 3 iron ingots'},{type:'GATHER',item:'STICK',quantity:2,title:'Get 2 sticks'},
    {type:'CRAFT',item:'IRON_PICKAXE',quantity:1,title:'Forge an iron pickaxe'}];
  if(/torch|light/.test(o))return [{type:'GATHER',item:'COAL',quantity:8,title:'Get 8 coal'},{type:'CRAFT',item:'TORCH',quantity:32,title:'Make 32 torches'},{type:'DELIVER',item:'TORCH',quantity:32,to:'warehouse',title:'Store the torches'}];
  const site=o.match(/\b(town hall|market hall|watchtower|forge|library|well)\b/)?.[1];
  if(site&&/build|construct|raise/.test(o))return [{type:'BUILD',site:site.replace(/ /g,'_'),title:`Build the ${site}`}];
  return [{type:'SAY',text:`I'm going to work on this: ${objective}`.slice(0,150),title:'Announce the plan'},{type:'WAIT',minutes:5,title:'Think it over'}];
}
const PLAN_PROMPT='You are the long-range planner for a Minecraft villager. Break the objective into 2-6 concrete milestones the villager can carry out in order. '+
  'Each milestone uses ONLY one of these types (fields in brackets): GATHER [item, quantity], CRAFT [item, quantity], SMELT [item, quantity], DELIVER [item, quantity, to: "warehouse" or a citizen id], '+
  'REQUEST [item, quantity] (ask others via the work order board), GOTO [x, z], FARM [crop], BUILD [site], SAY [text], WAIT [minutes]. Items are Minecraft ids (OAK_PLANKS, BREAD, IRON_INGOT). '+
  'Use the warehouse stock, known resource locations and the villager\'s role and skills; prefer REQUEST for things the villager cannot make. '+
  'Return ONLY JSON {"milestones":[{"type":"GATHER","item":"OAK_LOG","quantity":16,"title":"Gather 16 oak logs"}]}.';

const REVIEW_PROMPT='You check a Minecraft villager\'s plan before it starts. Given the task (objective, role, inventory, warehouse stock, known resources, open orders) and the proposed milestones, '+
  'judge whether they are feasible and in a sensible order, using ONLY these milestone types: GATHER, CRAFT, SMELT, DELIVER, REQUEST, GOTO, FARM, BUILD, SAY, WAIT (same fields as in the proposal). '+
  'Return ONLY JSON: {"approve":true} when it is fine, or {"approve":false,"problems":["short reason"],"milestones":[the corrected list]}.';
const parseJson=text=>{const body=String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g,'').replace(/```(?:json)?/g,'');return JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));};
export function createGoals(db,{lm,log=()=>{},now=()=>Date.now(),isOffline=e=>!!e?.offline}={}){
  const get=id=>db.get('SELECT * FROM agent_goals WHERE goal_id=?',id);
  const milestonesOf=id=>db.all("SELECT * FROM agent_goals WHERE parent_id=? AND kind='milestone' ORDER BY seq",id);
  const setStatus=(id,status,failure=null)=>db.run('UPDATE agent_goals SET status=?,failure=coalesce(?,failure),updated=? WHERE goal_id=?',status,failure,now(),id);
  const setSpec=(id,spec)=>db.run('UPDATE agent_goals SET spec_json=?,updated=? WHERE goal_id=?',JSON.stringify(spec),now(),id);
  function addMilestones(goalId,agent,list,startSeq=0){
    db.tx(()=>list.forEach((m,i)=>db.run("INSERT INTO agent_goals(goal_id,agent,parent_id,kind,title,status,seq,spec_json,created,updated) VALUES(?,?,?,'milestone',?,'PENDING',?,?,?,?)",
      randomUUID(),agent,goalId,m.title,startSeq+i,JSON.stringify(m),now(),now())));
  }
  /** Creates a goal; its milestones come from the macro planner (plan()). */
  function create(agent,objective,{source='self',milestones=null}={}){
    const active=db.get("SELECT * FROM agent_goals WHERE agent=? AND kind='goal' AND status IN ('PENDING','IN_PROGRESS','PAUSED') AND lower(title)=lower(?)",agent,objective);
    if(active)return active;
    const id=randomUUID(),t=now();
    db.run("INSERT INTO agent_goals(goal_id,agent,kind,title,status,source,created,updated) VALUES(?,?,'goal',?,'PENDING',?,?,?)",id,agent,String(objective).slice(0,120),source,t,t);
    if(milestones?.length){addMilestones(id,agent,validateMilestones(milestones));setStatus(id,'IN_PROGRESS');}
    log('goal_created',{agent,goal:objective,source});
    return get(id);
  }
  /** Macro planning with the primary model (the router falls back to the offload server); templates if no model helps. */
  async function plan(goalId,context={}){
    const g=get(goalId);if(!g)return null;
    let list=[],how='model';
    try{
      // With both models online the primary proposes and the other reviews; otherwise one model plans alone.
      const task={objective:g.title,...context};
      const r=lm.proposeAndReview?await lm.proposeAndReview('macro_planning',PLAN_PROMPT,task,REVIEW_PROMPT):{text:await lm.callPrimaryTask('macro_planning',PLAN_PROMPT,task),review:null};
      try{list=validateMilestones(parseJson(r.text).milestones);}
      catch{if(lm.repairJson){list=validateMilestones(parseJson(await lm.repairJson('macro_planning',r.text,{})).milestones);how='repaired';}}
      if(r.review){
        let v=null;try{v=parseJson(r.review);}catch{}
        const revised=v&&v.approve===false?validateMilestones(v.milestones):[];
        if(revised.length){list=revised;how='reviewed';}
        log('plan_reviewed',{goal:g.title,by:r.reviewer,approved:v?.approve!==false,changed:revised.length>0,problems:(v?.problems??[]).slice(0,3)});
      }
    }catch(error){if(!isOffline(error))log('plan_error',{goal:g.title,message:error.message});}
    if(!list.length){list=validateMilestones(templatePlan(g.title,context));how='template';}
    // Replanning keeps finished milestones and replaces the rest.
    db.run("DELETE FROM agent_goals WHERE parent_id=? AND kind='milestone' AND status!='COMPLETED'",goalId);
    const done=db.get("SELECT count(*) n FROM agent_goals WHERE parent_id=? AND kind='milestone'",goalId).n;
    addMilestones(goalId,g.agent,list,done);setStatus(goalId,'IN_PROGRESS');
    log('goal_planned',{agent:g.agent,goal:g.title,milestones:list.map(m=>m.title),how});
    return milestonesOf(goalId);
  }
  /** The agent's active goal and its current milestone (first one not COMPLETED). */
  function current(agent){
    const g=db.get("SELECT * FROM agent_goals WHERE agent=? AND kind='goal' AND status IN ('PENDING','IN_PROGRESS','PAUSED') ORDER BY created LIMIT 1",agent);
    if(!g)return null;
    const ms=milestonesOf(g.goal_id),m=ms.find(x=>x.status!=='COMPLETED');
    return {goal:g,milestone:m?{...m,spec:json(m.spec_json,{})}:null,milestones:ms};
  }
  function completeMilestone(id){setStatus(id,'COMPLETED');}
  /** A milestone failed for good: re-plan the goal (twice at most), then the goal fails. */
  async function failMilestone(id,reason,context){
    const m=get(id);if(!m)return;
    setStatus(id,'FAILED',reason);
    const g=get(m.parent_id);if(!g)return;
    if(g.replans>=2){setStatus(g.goal_id,'FAILED',`${m.title}: ${reason}`);log('goal_failed',{agent:g.agent,goal:g.title,reason});return 'failed';}
    db.run('UPDATE agent_goals SET replans=replans+1 WHERE goal_id=?',g.goal_id);
    log('goal_replan',{agent:g.agent,goal:g.title,failed:m.title,reason});
    await plan(g.goal_id,{...context,failedMilestone:m.title,failure:reason});
    return 'replanned';
  }
  function finishIfDone(goalId){
    const ms=milestonesOf(goalId);
    if(ms.length&&ms.every(m=>m.status==='COMPLETED')){setStatus(goalId,'COMPLETED');const g=get(goalId);log('goal_completed',{agent:g.agent,goal:g.title});return true;}
    return false;
  }
  const cancel=goalId=>{setStatus(goalId,'FAILED','cancelled');db.run("UPDATE agent_goals SET status='FAILED' WHERE parent_id=? AND status!='COMPLETED'",goalId);};
  const tree=(agent)=>db.all(`SELECT * FROM agent_goals WHERE kind='goal' ${agent?'AND agent=?':''} ORDER BY created DESC LIMIT 40`,...(agent?[agent]:[]))
    .map(g=>({...g,milestones:milestonesOf(g.goal_id).map(m=>({...m,spec:json(m.spec_json,{})}))}));
  const activeCount=agent=>db.get("SELECT count(*) n FROM agent_goals WHERE agent=? AND kind='goal' AND status IN ('PENDING','IN_PROGRESS','PAUSED')",agent).n;
  return {create,plan,current,completeMilestone,failMilestone,finishIfDone,setStatus,setSpec,cancel,tree,get,activeCount};
}
