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
const out=[];try{
 for(const point of [{x:265,y:71,z:119},{x:268,y:71,z:119}]){console.log('clear',point,(await bridge.action('builder',{type:'break',...point})).result);}
 for(const point of [{x:260,y:70,z:119,target:'IRON_BARS'},{x:265,y:70,z:119,target:'IRON_DOOR',facing:'SOUTH'},{x:268,y:70,z:119,target:'IRON_DOOR',facing:'SOUTH'}]){console.log('place',point,(await bridge.action('builder',{type:'place',...point})).result);}
 for(const box of boxes)out.push({box,cells:await scan(box)});
 const plans=JSON.parse(await readFile('/opt/sid-local/config/complete-plans.json','utf8'));const p=plans[35],blocks=blueprint(p.spec,p.x,p.y,p.z);const {renovationPlan}=await import('/opt/sid-local/agent-core/city.mjs');
 const plan=renovationPlan(blocks,out[0].cells,{x1:258,x2:270,z1:115,z2:122,y1:69,y2:74});const result=inspect(plan.expected,out[0].cells);
 console.log(JSON.stringify({inspection:result,remaining:plan.queue}));if(plan.queue.length||result.missing.length||result.wrong.length)throw Error('Jail inspection did not pass');
 await bridge.action('builder',{type:'sign',x:257,y:72,z:120,facing:'WEST',target:'SPRUCE_WALL_SIGN',text:'JAIL|Four cells|Sheriff Wade'});
 const path='/var/lib/sid-local/memory.json',data=JSON.parse(await readFile(path,'utf8')),t=data.town;t.completionInspections??={};t.completionInspections[35]={at:Date.now(),missing:0,verified:true,supervised:true,expected:plan.expected.length};
 t.sites.jail={...p.definition};t.city.recoveredSites??={};t.city.recoveredSites.jail={...p.definition};t.built.jail=true;(t.finishedSites??={}).jail=Date.now();t.jailBarsV1=true;delete(t.signsPosted??{}).jail;delete(t.entrances??{}).jail;t.priorityBuilds=t.priorityBuilds.filter(x=>x!=='complete:35');
 data.ledger.push({time:Date.now(),by:'builder',text:'Completed and inspected the four-cell jail, including iron doors, bars, levers and west entrance; JAIL label installed.'});
 await writeFile(path,JSON.stringify(data));await writeFile('/tmp/jail-supervised-verification.json',JSON.stringify({at:Date.now(),expected:plan.expected.length,inspection:result,remaining:plan.queue,cells:out[0].cells}));
 console.log('Jail structure verified; four cells, four iron doors, four levers.');
}finally{bridge.stop();}
