import {readFile,writeFile} from 'node:fs/promises';
import {Bridge} from '/opt/sid-local/node-bridge/bridge.mjs';
import {ROADS,SITES} from '/opt/sid-local/agent-core/civic.mjs';
import {blueprint} from '/opt/sid-local/agent-core/blueprints.mjs';
import {roadColumns} from '/opt/sid-local/agent-core/town.mjs';
const roadCols=new Set(ROADS.flatMap(r=>roadColumns(r.a,r.b,r.width).map(p=>p.x+','+p.z)));
const siteFootprint=(st,x,z)=>{const b=blueprint({shape:st.shape,door:st.door,...st.spec},x,64,z);return {x1:Math.min(...b.map(p=>p.x)),x2:Math.max(...b.map(p=>p.x)),z1:Math.min(...b.map(p=>p.z)),z2:Math.max(...b.map(p=>p.z))};};
import {lampPlan,lampSiteSafe} from '/opt/sid-local/agent-core/lighting.mjs';
const b=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'builder'},{id:'crafter'},{id:'scout'}]);let snap;const events=[];
b.on('message',m=>{if(m.type==='snapshot')snap=m;if(m.type==='event'&&m.event==='action')events.push(m);});b.start();
await new Promise((r,j)=>{b.once('ready',r);setTimeout(()=>j(Error('bridge timeout')),30000).unref();});
const report={cleanup:[],posts:[],crossings:[],events};
try{
 const memory=JSON.parse(await readFile('/var/lib/sid-local/memory.json','utf8'));memory.town.lampPosts??=[];
 const dark=[];for(const r of ROADS){const dx=r.b.x-r.a.x,dz=r.b.z-r.a.z,len=Math.hypot(dx,dz);for(let d=0;d<=len;d+=8)for(const side of [-1,1]){const x=Math.round(r.a.x+dx*d/len-dz/len*3*side),z=Math.round(r.a.z+dz*d/len+dx/len*3*side);dark.push({x,z});}}
 for(const candidate of dark){
  const {x,z}=candidate;
  const sv=(await b.action('builder',{type:'survey',x,y:0,z,width:1,depth:1})).result;const y=sv.heights?.[0]+1;if(!Number.isFinite(y)||sv.liquid?.[0]||!['GRASS_BLOCK','DIRT','ROOTED_DIRT'].includes(sv.tops?.[0]))continue;
  if(!ROADS.some(r=>{const dx=r.b.x-r.a.x,dz=r.b.z-r.a.z,t=Math.max(0,Math.min(1,((x-r.a.x)*dx+(z-r.a.z)*dz)/(dx*dx+dz*dz||1)));return Math.hypot(x-r.a.x-t*dx,z-r.a.z-t*dz)<=4;}))continue;
  if(Object.entries(memory.town.sites??{}).some(([k,a])=>{if(!SITES[k])return false;const f=siteFootprint(SITES[k],a.x,a.z);return x>=f.x1-1&&x<=f.x2+1&&z>=f.z1-1&&z<=f.z2+1;}))continue;
  const scan=(await b.action('builder',{type:'scan',x:x-2,y:y-1,z:z-2,width:5,height:7,depth:5})).result;
  let p={x,y,z};let safe=lampSiteSafe(p,scan.cells,memory.town.lampPosts,roadCols);
  if(!safe){p={...p,axis:'z'};safe=lampSiteSafe(p,scan.cells,memory.town.lampPosts,roadCols);}
  report.posts.push({p,safe,cells:scan.cells});
  if(safe){memory.town.lampPosts.push({...p,owner:'scout',status:'building',cursor:0,plan:lampPlan(p)});break;}
 }
 // Retire queued loose street lights from old road projects, retaining their road surface work.
 for(const s of Object.values(memory.agents))for(const p of [s.project,...(s.parkedProjects??[])])if(p&&(p.road||p.planStage?.startsWith('road:')))p.queue=p.queue.filter(v=>v.block!=='LANTERN');
 await writeFile('/var/lib/sid-local/memory.json',JSON.stringify(memory));
 console.log('removed',report.cleanup[0]?.result,'posts',report.posts.filter(p=>p.safe).length,'crossings',report.crossings.map(r=>[r.label,!!r.reached]));
}finally{await writeFile('/tmp/lamp-seed-verification.json',JSON.stringify(report));b.stop();}
