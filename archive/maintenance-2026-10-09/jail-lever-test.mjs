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
try{await bridge.action('builder',{type:'climb',x:262.5,y:70,z:121.5});for(const x of [259,262,265])await bridge.action('builder',{type:'interact',x,y:70,z:120});await bridge.action('builder',{type:'climb',x:265.5,y:70,z:121.5});await bridge.action('builder',{type:'interact',x:268,y:70,z:120});console.log('All four levers operated by Bram.');}finally{bridge.stop();}
