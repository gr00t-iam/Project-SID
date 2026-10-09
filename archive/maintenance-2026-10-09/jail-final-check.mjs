import {readFile,writeFile} from 'node:fs/promises';
import {Bridge} from '/opt/sid-local/node-bridge/bridge.mjs';
import {SITES} from '/opt/sid-local/agent-core/civic.mjs';
import {blueprint} from '/opt/sid-local/agent-core/blueprints.mjs';
import {inspect,inspectionBox} from '/opt/sid-local/agent-core/construction.mjs';
import {scanPages} from '/opt/sid-local/agent-core/sites.mjs';
const memory=JSON.parse(await readFile('/var/lib/sid-local/memory.json','utf8')),town=memory.town;
const village=JSON.parse(await readFile('/opt/sid-local/config/village.json','utf8'));
const bridge=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'builder'}]);
bridge.on('log',message=>{if(/error|closed/i.test(message))console.error(message);});
bridge.start();await new Promise((resolve,reject)=>{bridge.once('ready',resolve);setTimeout(()=>reject(Error('Audit bridge timeout')),15000).unref();});
async function scan(box){const cells=[];for(const page of scanPages(box)){let result;for(let n=0;n<3;n++){try{result=(await bridge.action('builder',{type:'scan',...page})).result;break;}catch(e){if(n===2)throw e;await new Promise(r=>setTimeout(r,600));}}if(!Array.isArray(result?.cells))throw Error('Invalid scan result');cells.push(...result.cells);}return cells;}
const boxes=[{name:'jail final check',x1:258,x2:270,z1:115,z2:122,y1:68,y2:74}];
const out=[];try{for(const box of boxes){out.push({box,cells:await scan(box)});}await writeFile('/tmp/jail-final-check.json',JSON.stringify(out));const plans=JSON.parse(await readFile('/opt/sid-local/config/complete-plans.json','utf8'));const p=plans[35],blocks=blueprint(p.spec,p.x,p.y,p.z);const {renovationPlan}=await import('/opt/sid-local/agent-core/city.mjs');const plan=renovationPlan(blocks,out[0].cells,{x1:258,x2:270,z1:115,z2:122,y1:69,y2:74});console.log(JSON.stringify({expected:plan.expected.length,remaining:plan.queue}));}finally{bridge.stop();}
