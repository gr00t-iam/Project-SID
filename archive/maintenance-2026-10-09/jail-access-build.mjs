import {readFile,writeFile} from 'node:fs/promises';
import {Bridge} from '/opt/sid-local/node-bridge/bridge.mjs';
import {SITES} from '/opt/sid-local/agent-core/civic.mjs';
import {blueprint} from '/opt/sid-local/agent-core/blueprints.mjs';
import {inspect,inspectionBox} from '/opt/sid-local/agent-core/construction.mjs';
import {scanPages} from '/opt/sid-local/agent-core/sites.mjs';
const memory=JSON.parse(await readFile('/var/lib/sid-local/memory.json','utf8')),town=memory.town;
const village=JSON.parse(await readFile('/opt/sid-local/config/village.json','utf8'));
const bridge=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'builder'},{id:'sheriff'}]);
bridge.on('log',message=>{if(/error|closed/i.test(message))console.error(message);});
bridge.start();await new Promise((resolve,reject)=>{bridge.once('ready',resolve);setTimeout(()=>reject(Error('Audit bridge timeout')),15000).unref();});
async function scan(box){const cells=[];for(const page of scanPages(box)){let result;for(let n=0;n<3;n++){try{result=(await bridge.action('builder',{type:'scan',...page})).result;break;}catch(e){if(n===2)throw e;await new Promise(r=>setTimeout(r,600));}}if(!Array.isArray(result?.cells))throw Error('Invalid scan result');cells.push(...result.cells);}return cells;}
try{const access=[{x:257,y:68,z:120,target:'COBBLESTONE'},{x:256,y:68,z:120,target:'SPRUCE_SLAB'},{x:257,y:69,z:120,target:'SPRUCE_SLAB'}];for(const point of access)console.log('approach',(await bridge.action('builder',{type:'place',...point})).result);await writeFile('/tmp/jail-access-plan.json',JSON.stringify(access));}finally{bridge.stop();}
