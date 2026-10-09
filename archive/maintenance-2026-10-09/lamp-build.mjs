import {readFile,writeFile} from 'node:fs/promises';
import {Bridge} from '/opt/sid-local/node-bridge/bridge.mjs';
const m=JSON.parse(await readFile('/var/lib/sid-local/memory.json','utf8')),p=m.town.lampPosts?.find(p=>p.status==='building');if(!p)throw Error('No queued post');
const b=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'crafter'}]);let snap;const report={p,travel:[],placements:[],withdrawals:[]};b.on('message',v=>{if(v.type==='snapshot')snap=v;});b.start();await new Promise((r,j)=>{b.once('ready',r);setTimeout(()=>j(Error('bridge timeout')),15000).unref();});
const me=()=>snap?.agents?.find(a=>a.id==='crafter');
async function walk(target){const r={target,samples:[]};report.travel.push(r);await b.action('crafter',{type:'travel',...target});for(let i=0;i<45;i++){await new Promise(r=>setTimeout(r,1000));const a=me();if(!a)continue;r.samples.push([a.x,a.y,a.z]);if(Math.hypot(a.x-target.x,a.z-target.z)<2.5&&Math.abs(a.y-target.y)<2){r.reached=true;return;}}throw Error('Could not reach '+JSON.stringify(target));}
try{
 const needs={};for(const block of p.plan.slice(p.cursor??0))needs[block.block]=(needs[block.block]??0)+1;
 for(const [item,n] of Object.entries(needs)){
  const current=me()?.inventory?.[item]??0;if(current>=n)continue;
  if(item==='SPRUCE_FENCE'){
   for(const [input,count] of [['SPRUCE_PLANKS',4],['STICK',2]]){
    const chest=m.town.stock.chests.find(c=>(c.items?.[input]??0)>=count);if(!chest)throw Error('Missing '+input);
    await walk({x:Math.max(283.5,Math.min(291.5,chest.x+0.5)),y:70,z:Math.max(103.5,Math.min(110.5,chest.z+0.5))});report.withdrawals.push((await b.action('crafter',{type:'withdraw',x:chest.x,y:chest.y,z:chest.z,target:input,count})).result);
   }
   report.craft=(await b.action('crafter',{type:'craft',target:'SPRUCE_FENCE',count:1,x:0,y:0,z:0})).result;
  }else{const chest=m.town.stock.chests.find(c=>(c.items?.[item]??0)>=n-current);if(!chest)throw Error('Missing '+item);await walk({x:Math.max(283.5,Math.min(291.5,chest.x+0.5)),y:70,z:Math.max(103.5,Math.min(110.5,chest.z+0.5))});report.withdrawals.push((await b.action('crafter',{type:'withdraw',x:chest.x,y:chest.y,z:chest.z,target:item,count:n-current})).result);}
 }
 await walk({x:p.x+2.5,y:p.y,z:p.z+0.5});
 for(const block of p.plan.slice(p.cursor??0)){
  const scanned=(await b.action('crafter',{type:'scan',x:block.x,y:block.y,z:block.z,width:1,height:1,depth:1})).result;
  if(scanned.cells?.[0]?.[3]!==block.block)report.placements.push({block,result:(await b.action('crafter',{type:'place',x:block.x,y:block.y,z:block.z,target:block.block,hanging:!!block.hanging})).result});
  p.cursor=(p.cursor??0)+1;await writeFile('/var/lib/sid-local/memory.json',JSON.stringify(m));
 }
 p.status='completed';p.completedBy='crafter';p.supervisedVerification=true;m.town.lightsPlaced=(m.town.lightsPlaced??0)+2;await writeFile('/var/lib/sid-local/memory.json',JSON.stringify(m));console.log('Completed post',p.x,p.y,p.z,'placements',report.placements.length);
}finally{await writeFile('/tmp/lamp-build-verification.json',JSON.stringify(report));b.stop();}
