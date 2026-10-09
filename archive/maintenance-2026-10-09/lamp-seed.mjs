import {readFile,writeFile} from 'node:fs/promises';
import {Bridge} from '/opt/sid-local/node-bridge/bridge.mjs';
import {lampPlan,lampSiteSafe} from '/opt/sid-local/agent-core/lighting.mjs';
const b=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'builder'},{id:'crafter'},{id:'scout'}]);let snap;const events=[];
b.on('message',m=>{if(m.type==='snapshot')snap=m;if(m.type==='event'&&m.event==='action')events.push(m);});b.start();
await new Promise((r,j)=>{b.once('ready',r);setTimeout(()=>j(Error('bridge timeout')),30000).unref();});
const report={cleanup:[],posts:[],crossings:[],events};
try{
 const memory=JSON.parse(await readFile('/var/lib/sid-local/memory.json','utf8'));memory.town.lampPosts??=[];
 for(const [x,z] of [[300,85],[300,93],[300,101]]){
  const survey=(await b.action('builder',{type:'survey',x,y:0,z,width:1,depth:1})).result;const y=survey.heights?.[0]+1;if(!Number.isFinite(y))continue;
  const p={x,y,z,axis:'z'};const scan=(await b.action('builder',{type:'scan',x:x-2,y:y-1,z:z-2,width:5,height:7,depth:5})).result;
  const safe=lampSiteSafe(p,scan.cells,memory.town.lampPosts);report.posts.push({p,safe,cells:scan.cells});
  if(safe){memory.town.lampPosts.push({...p,owner:'scout',status:'building',cursor:0,plan:lampPlan(p)});break;}
 }
 // Retire queued loose street lights from old road projects, retaining their road surface work.
 for(const s of Object.values(memory.agents))for(const p of [s.project,...(s.parkedProjects??[])])if(p&&(p.road||p.planStage?.startsWith('road:')))p.queue=p.queue.filter(v=>v.block!=='LANTERN');
 await writeFile('/var/lib/sid-local/memory.json',JSON.stringify(memory));
 console.log('removed',report.cleanup[0]?.result,'posts',report.posts.filter(p=>p.safe).length,'crossings',report.crossings.map(r=>[r.label,!!r.reached]));
}finally{await writeFile('/tmp/lamp-seed-verification.json',JSON.stringify(report));b.stop();}
