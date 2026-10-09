import {readFile,writeFile} from 'node:fs/promises';
import {Bridge} from '/opt/sid-local/node-bridge/bridge.mjs';
const b=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'builder'},{id:'chef'},{id:'crafter'}]);
let snap;b.on('message',m=>{if(m.type==='snapshot')snap=m;});b.start();
await new Promise((r,j)=>{b.once('ready',r);setTimeout(()=>j(Error('bridge timeout')),15000).unref();});
const known=JSON.parse(await readFile('/tmp/lighting-agent-blocks.json','utf8')),groups=new Map();
for(const [k,v] of Object.entries(known))if(v.startsWith('LANTERN')){const [w,x,y,z]=k.split('|');const key=x+','+z;const g=groups.get(key)??[];g.push([+x,+y,+z]);groups.set(key,g);}
const columns=[...groups.values()].filter(g=>g.length>1),report={stacks:[],homes:[],snapshots:[]};
try{
 for(const g of columns){const [x,,z]=g[0],ys=g.map(p=>p[1]),y=Math.min(...ys);
 const scanned=(await b.action('builder',{type:'scan',x:x-1,y:y-2,z:z-1,width:3,height:Math.max(...ys)-y+5,depth:3})).result;
 report.stacks.push({known:g,cells:scanned.cells});}
 const village=JSON.parse(await readFile('/opt/sid-local/config/village.json','utf8'));
 report.village=village;
 for(const id of ['chef','crafter']){const lot=village.homes?.[id]??village.lots?.find(p=>p.id===id);if(!lot)continue;
 report.homes.push({id,lot,cells:(await b.action('builder',{type:'scan',x:lot.x-1,y:66,z:lot.z-1,width:7,height:10,depth:7})).result.cells});}
 for(let i=0;i<12;i++){if(snap)report.snapshots.push({at:Date.now(),agents:snap.agents?.filter(a=>['chef','crafter'].includes(a.id))});await new Promise(r=>setTimeout(r,1000));}
 await writeFile('/tmp/door-light-audit.json',JSON.stringify(report));console.log('audit stacks',report.stacks.length,'homes',report.homes.length);
}finally{b.stop();}
