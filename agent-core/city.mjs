import {communityDate} from './community.mjs';
const catalog=[
 ['assembly','Community assembly hall','hall'],['archive','City archive','library'],['library','Neighbourhood library','library'],
 ['workshop','Craft workshop','house'],['nursery','Garden nursery building','house'],['housing','New residential building','house'],
 ['guild','Trade guild hall','hall'],['market','Covered market building','pavilion'],['smithy','Neighbourhood smithy','forge'],
 ['meeting','Neighbourhood meeting hall','hall'],['depot','Construction depot','house'],['lodge','Visitor lodge','house'],
 ['study','Learning centre','library'],['artisan','Artisan workshop','house'],['exchange','Trade exchange building','pavilion'],
 ['civic','Civic meeting building','hall']
].map(([template,name,shape])=>({template,name,shape}));
const shuffled=(list,random)=>list.map(value=>({value,key:random()})).sort((a,b)=>a.key-b.key).map(x=>x.value);
export function createCityBoard(d){
 const {state,sites,town,save,start,finish}=d,now=d.now??Date.now,random=d.random??Math.random;
 state.queue??=[];state.history??=[];
 for(const [id,definition] of Object.entries(state.recoveredSites??{}))sites[id]={...definition,...(town.sites?.[id]??{})};
 for(const m of state.queue)if(m.definition)sites[m.site]={...m.definition,...(town.sites?.[m.site]??{})};
 const projects=()=>[...(d.projects?.()??[]),...(town.parkedProjects??[]).map(p=>p.project)];
 const done=m=>m.kind==='finish'?!!town.finishedSites?.[m.site]:!!town.built[m.site];
 let rolling=null;
 async function tick(){
  const date=communityDate(now());if(state.date&&state.date>=date)return;if(rolling)return rolling;
  rolling=(async()=>{
   const previous=new Set(state.queue.filter(m=>m.date===state.date).map(m=>m.template));
   if(state.date)state.history.unshift({date:state.date,completed:state.queue.filter(m=>m.date===state.date&&done(m)).length});
   state.history=state.history.slice(0,14);
   const used=new Set(state.queue.filter(m=>!done(m)).map(m=>m.site));
   const shells=shuffled(Object.keys(sites).filter(id=>town.sites?.[id]&&(!state.eligibleSites||state.eligibleSites.includes(id))&&!town.finishedSites?.[id]&&!used.has(id)&&!projects().some(p=>p.publicWork===id)),random).slice(0,2);
   const items=shells.map(site=>({id:`${date}:finish:${site}`,date,site,kind:'finish',template:`finish:${site}`,name:`Inspect and finish ${site.replace(/_/g,' ')}`,note:'Inspect the existing building and complete missing walls, roof and fittings.'}));
   const choices=shuffled(catalog,random).sort((a,b)=>Number(previous.has(a.template))-Number(previous.has(b.template)));
   for(const t of choices.slice(0,6-items.length)){
    const site=`city_${date.replaceAll('-','')}_${t.template}`,index=state.queue.filter(m=>m.kind==='new').length+items.filter(m=>m.kind==='new').length;
    // The existing survey chooses safe, natural ground; these are search origins, not forced building coordinates.
    const definition={shape:t.shape,x:320+(index%6)*16,z:150+Math.floor(index/6)*16,door:'north',spec:t.shape==='house'?{width:7,depth:7,height:4,windows:true}:undefined};
    sites[site]=definition;items.push({id:`${date}:new:${t.template}`,date,site,kind:'new',template:t.template,name:t.name,definition,note:'Bram surveys a suitable site, builds it with supplied materials, then inspects every block.'});
   }
   state.date=date;state.queue.push(...items);await save();
  })().finally(()=>{rolling=null;});return rolling;
 }
 function describe(m){
  const p=projects().find(p=>p.publicWork===m.site),complete=done(m);
  return {...m,status:complete?'completed':p?.status==='PARKED'||p?.blocker?'blocked':p?'in_progress':m.retryAt>now()?'blocked':'pending',have:complete?100:p?.inspection?.pct??(p?.total?Math.min(99,Math.floor(100*(p.placed??0)/p.total)):0),goal:100,detail:p?.blocker?.text??m.error??m.note};
 }
 const view=()=>({date:state.date,timeZone:'America/Chicago',items:state.queue.filter(m=>m.date===state.date).map(describe),backlog:state.queue.filter(m=>m.date!==state.date&&!done(m)).length,history:state.history});
 async function work(c,s){
  if(rolling||s.project)return false;
  const active=new Set(projects().map(p=>p.publicWork));
  const shellsRemain=state.queue.some(m=>!done(m)&&(m.kind==='finish'||town.sites?.[m.site]));
  const pending=state.queue.filter(m=>!done(m)&&!active.has(m.site)&&!(m.retryAt>now())&&(!shellsRemain||m.kind==='finish'||town.sites?.[m.site])).sort((a,b)=>Number(b.kind==='finish')-Number(a.kind==='finish'));
  for(const m of pending){
   let ok=false;
   try{
    // A chosen site is an existing shell: resume in place rather than making a second building.
    ok=m.kind==='finish'||town.sites?.[m.site]?await finish(c,s,m.site):await start(c,s,sites[m.site],m.name,{publicWork:m.site,cityMilestone:m.id});
    if(s.project)s.project.cityMilestone=m.id;
    if(done(m)){await save();continue;}
    if(ok){delete m.error;await save();return true;}
    m.error='Waiting for a safe site or building inspection.';
   }catch(error){m.error=String(error.message).slice(0,160);}
   m.retryAt=now()+600000;await save();
  }
  return false;
 }
 return {tick,view,work};
}

export function constructionGate(id,shape,state,town){
 if(id!=='builder')return null;
 if(shape==='cancel'&&(state.project||(town.parkedProjects??[]).length))return 'Finish the current building before abandoning it; report its blocker and request supplies.';
 if(shape!=='cancel'&&(town.parkedProjects??[]).length)return 'A building is paused; finish that construction before starting another.';
 if(shape!=='cancel'&&(town.priorityBuilds??[]).some(k=>k.startsWith('complete:')))return 'Finish the existing building recovery queue before starting a new blueprint.';
 return null;
}

export function restorationPlan(blocks,cells){
 const at=new Map(cells.map(c=>[`${c[0]},${c[1]},${c[2]}`,c])),queue=[],expected=[];
 for(const b of blocks){
  const c=at.get(`${b.x},${b.y},${b.z}`),soft=!c||/^(AIR|CAVE_AIR|SHORT_GRASS|TALL_GRASS|FERN|LARGE_FERN|SNOW|DEAD_BUSH|VINE|WATER)$/.test(c[3]);
  if(soft||c?.[5]){if(c&&!soft)queue.push({x:b.x,y:b.y,z:b.z,block:'CLEAR',clear:true,expected:c[3]});queue.push(b);expected.push(b);}
  else if(/_DOOR$/.test(b.block)&&!/_DOOR$/.test(c[3])){queue.push({...b,replace:true});expected.push(b);}
  else expected.push({...b,block:c[3]});
 }
 return {queue,expected};
}

export function builderDuty(role,night,state,town){
 return role==='builder'&&!night&&!!(state.project||(town.parkedProjects??[]).length||(town.priorityBuilds??[]).length||(town.city?.queue??[]).some(m=>m.kind==='finish'?!town.finishedSites?.[m.site]:!town.built?.[m.site]));
}

// An explicitly approved renovation may replace old agent-built partitions. Vacant interior space is inspected too.
export function renovationPlan(blocks,cells,box){
 const at=new Map(cells.map(c=>[`${c[0]},${c[1]},${c[2]}`,c])),wanted=new Map(blocks.map(b=>[`${b.x},${b.y},${b.z}`,b])),queue=[],expected=[];
 for(const b of blocks)if(/_DOOR$/.test(b.block))wanted.set(`${b.x},${b.y+1},${b.z}`,{...b,y:b.y+1,virtual:true});
 for(let x=box.x1;x<=box.x2;x++)for(let y=box.y1;y<=box.y2;y++)for(let z=box.z1;z<=box.z2;z++){
  const k=`${x},${y},${z}`,b=wanted.get(k)??{x,y,z,block:'AIR'},c=at.get(k);
  expected.push({...b});
  if(b.virtual){if(c&&c[3]!==b.block)queue.push({x,y,z,block:'CLEAR',clear:true,demolish:!c[5],expected:c[3]});continue;}
  if(b.block==='AIR'){if(c&&!/^(AIR|CAVE_AIR)$/.test(c[3]))queue.push({x,y,z,block:'CLEAR',clear:true,demolish:!c[5],expected:c[3]});}
  else if(c?.[3]!==b.block){if(c)queue.push({x,y,z,block:'CLEAR',clear:true,demolish:!c[5],expected:c[3]});queue.push(b);}
 }
 for(const b of blocks.filter(b=>/_DOOR$/.test(b.block))){const lower=at.get(`${b.x},${b.y},${b.z}`),upper=at.get(`${b.x},${b.y+1},${b.z}`);
  if(lower?.[3]===b.block&&upper?.[3]!==b.block){queue.push({...b,block:'CLEAR',clear:true,demolish:!lower[5],expected:lower[3]});queue.push({...b});}
 }
 return {queue,expected};
}
