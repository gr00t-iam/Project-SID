import {readFile,writeFile} from 'node:fs/promises';
import {Bridge} from '/opt/sid-local/node-bridge/bridge.mjs';
import {lampPlan,lampSiteSafe} from '/opt/sid-local/agent-core/lighting.mjs';
const b=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'builder'},{id:'crafter'},{id:'scout'}]);let snap;const events=[];
b.on('message',m=>{if(m.type==='snapshot')snap=m;if(m.type==='event'&&m.event==='action')events.push(m);});b.start();
await new Promise((r,j)=>{b.once('ready',r);setTimeout(()=>j(Error('bridge timeout')),30000).unref();});
const report={cleanup:[],posts:[],crossings:[],events};
try{
 const prior=JSON.parse(await readFile('/tmp/door-light-audit.json','utf8'));
 const remove=[];
 for(const g of prior.stacks){const actual=g.known.filter(p=>g.cells.some(c=>c[0]===p[0]&&c[1]===p[1]&&c[2]===p[2]&&c[3]==='LANTERN'));if(actual.length>=2)remove.push(...actual.sort((a,b)=>b[1]-a[1]));}
 if(remove.length)report.cleanup.push({blocks:remove,result:(await b.action('builder',{type:'demolish',blocks:remove})).result});
 const memory=JSON.parse(await readFile('/var/lib/sid-local/memory.json','utf8'));memory.town.lampPosts??=[];
 for(const [x,z] of [[299,93],[299,85],[299,101],[263,95]]){
  const survey=(await b.action('builder',{type:'survey',x,y:0,z,width:1,depth:1})).result;const y=survey.heights?.[0]+1;if(!Number.isFinite(y))continue;
  const p={x,y,z};const scan=(await b.action('builder',{type:'scan',x:x-2,y:y-1,z:z-2,width:5,height:7,depth:5})).result;
  const safe=lampSiteSafe(p,scan.cells,memory.town.lampPosts);report.posts.push({p,safe,cells:scan.cells});
  if(safe){memory.town.lampPosts.push({...p,owner:'scout',status:'building',cursor:0,plan:lampPlan(p)});break;}
 }
 // Retire queued loose street lights from old road projects, retaining their road surface work.
 for(const s of Object.values(memory.agents))for(const p of [s.project,...(s.parkedProjects??[])])if(p&&(p.road||p.planStage?.startsWith('road:')))p.queue=p.queue.filter(v=>v.block!=='LANTERN');
 await writeFile('/var/lib/sid-local/memory.json',JSON.stringify(memory));
 async function observe(label,target,reached){
  const r={label,target,start:snap?.agents?.find(a=>a.id==='crafter'),samples:[]};report.crossings.push(r);
  await b.action('crafter',{type:'travel',...target});
  for(let i=0;i<60;i++){
   await new Promise(r=>setTimeout(r,1000));const a=snap?.agents?.find(a=>a.id==='crafter');if(a)r.samples.push({x:a.x,y:a.y,z:a.z,pathing:a.pathing,navigation:a.navigation});
   if(a&&reached(a)){r.reached=true;break;}
  }
 }
 await observe('enter Tink home',{x:306.5,y:69,z:90.5},a=>a.x>=305&&a.x<308&&a.z>=89&&a.z<92&&Math.abs(a.y-69)<1);
 await observe('leave Tink home',{x:301.5,y:68,z:90.5},a=>a.x<303&&Math.abs(a.z-90.5)<2);
 console.log('removed',report.cleanup[0]?.result,'posts',report.posts.filter(p=>p.safe).length,'crossings',report.crossings.map(r=>[r.label,!!r.reached]));
}finally{await writeFile('/tmp/door-light-verification.json',JSON.stringify(report));b.stop();}
