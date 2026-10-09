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
const plans=[],report=[];
try{
 for(const [id,at] of Object.entries(town.sites??{})){
  const st=SITES[id];if(!st||!Number.isFinite(at.y))continue;
  const spec={shape:st.shape,door:st.door,...st.spec,...town.designs?.[id]?.spec},blocks=blueprint(spec,at.x,at.y,at.z);
  const box=inspectionBox(blocks),cells=await scan({...box,y1:box.y1-8,y2:box.y2+8});
  const options=[];for(let y=at.y-8;y<=at.y+8;y++)options.push({y,...inspect(blueprint(spec,at.x,y,at.z),cells)});options.sort((a,b)=>b.matched-a.matched);const result=options[0];at.y=result.y;
  if(result.pct<25){report.push({name:id,status:'needs_manual_inspection',pct:result.pct,bestFloor:at.y});console.log('AMBIGUOUS public',id,result.pct);continue;}
  plans.push({name:id,site:id,x:at.x,y:at.y,z:at.z,spec});report.push({index:plans.length-1,name:id,...result,missing:result.missing.length,wrong:result.wrong.length});console.log(id,result.pct,result.missing.length,result.wrong.length);
 }
 for(const [id,lot] of Object.entries({...village.homes,...memory.village.extraHomes})){
  const spec={shape:'house',width:5,depth:5,height:3,material:lot.material,trim:lot.trim,roof:lot.roof,floor:lot.floor,door:lot.door,bed:lot.bed??true,chest:true,windows:true};
  const cells=await scan({x1:lot.x-1,x2:lot.x+5,z1:lot.z-1,z2:lot.z+5,y1:50,y2:96});
  const options=[];for(let y=51;y<=89;y++){const blocks=blueprint(spec,lot.x,y,lot.z);options.push({y,...inspect(blocks,cells)});}
  options.sort((a,b)=>b.matched-a.matched);const result=options[0];
  if(result.pct<45){console.log('TYPES',id,JSON.stringify(Object.fromEntries([...new Set(cells.map(c=>c[3]))].map(t=>[t,cells.filter(c=>c[3]===t).length]))),JSON.stringify(cells.filter(c=>/_DOOR$/.test(c[3]))));report.push({name:'home '+id,status:'needs_manual_inspection',bestFloor:result.y,pct:result.pct});console.log('AMBIGUOUS home',id,result.pct);continue;}
  plans.push({name:'home for '+id,homeFor:id,x:lot.x,y:result.y,z:lot.z,spec});report.push({index:plans.length-1,name:'home '+id,pct:result.pct,total:result.total,matched:result.matched,missing:result.missing.length,wrong:result.wrong.length});console.log('home',id,result.y,result.pct,result.missing.length,result.wrong.length);
 }
 await writeFile('/tmp/city-building-audit.json',JSON.stringify({time:new Date().toISOString(),report,plans},null,2));
}finally{bridge.stop();}
