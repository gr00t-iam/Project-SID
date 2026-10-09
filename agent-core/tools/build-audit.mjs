// Audit of every building ever started: which plan it was, how much of it stands (blocks the citizens placed that are
// still there, from the plugin's agent-blocks.json), and whether it is the town's current building or an abandoned
// attempt (a start at a site that was later moved, or a home planned on a roof).
//   node tools/build-audit.mjs <starts.jsonl> <agent-blocks.json> <town.json> <village.json>
import {readFileSync} from 'node:fs';
import {blueprint} from '../blueprints.mjs';
import {SITES} from '../civic.mjs';

const [startsFile,blocksFile,townFile,villageFile]=process.argv.slice(2);
const placed=JSON.parse(readFileSync(blocksFile,'utf8'));
const town=JSON.parse(readFileSync(townFile,'utf8'));
const village=JSON.parse(readFileSync(villageFile,'utf8'));
const at=new Map();for(const [k,v] of Object.entries(placed)){const [,x,y,z]=k.split('|');at.set(`${x},${y},${z}`,v.split('<')[0]);}

const starts=new Map();
for(const line of readFileSync(startsFile,'utf8').split('\n')){
  let j;try{j=JSON.parse(line);}catch{continue;}
  const m=/^(\w+) at (-?\d+),(-?\d+),(-?\d+)$/.exec(j.name??'');if(!m)continue;
  const key=`${m[1]}@${m[2]},${m[3]},${m[4]}|${j.blocks}`;
  const s=starts.get(key)??{shape:m[1],x:+m[2],y:+m[3],z:+m[4],blocks:j.blocks,first:j.time,last:j.time,times:0};
  s.last=j.time;s.times++;starts.set(key,s);
}
const doors=['south','north','east','west'];
const specsFor=s=>{
  const out=[];
  const add=(spec)=>{for(const door of [spec.door,...doors].filter(Boolean))out.push({...spec,door});};
  if(s.shape==='house'){add({shape:'house',...SITES.mayor_house.spec,door:SITES.mayor_house.door});
    add({shape:'house',width:5,depth:5,height:3,bed:true,chest:true,windows:true});add({shape:'house',width:5,depth:5,height:3,bed:true,windows:true});}
  for(const [k,st] of Object.entries(SITES))if(st.shape===s.shape){add({shape:st.shape,...(st.spec??{}),door:st.door});const d=town.designs?.[k]?.spec;if(d)add({shape:st.shape,...(st.spec??{}),...d,door:st.door});}
  add({shape:s.shape});
  return out;
};
const rows=[];
for(const s of starts.values()){
  let plan=null;
  for(const spec of specsFor(s)){let b;try{b=blueprint(spec,s.x,s.y,s.z);}catch{continue;}if(b.length===s.blocks){plan={spec,b};break;}}
  if(!plan){rows.push({...s,plan:'?'});continue;}
  let present=0;for(const b of plan.b)if(at.get(`${b.x},${b.y},${b.z}`)===b.block)present++;
  const xs=plan.b.map(b=>b.x),zs=plan.b.map(b=>b.z);
  // Current: the site the town now has for this kind of building, or a home lot at ground level.
  const siteHit=Object.entries(town.sites??{}).find(([k,v])=>SITES[k]?.shape===s.shape&&v.x===s.x&&v.z===s.z);
  const lot=Object.entries(village.homes??{}).find(([,l])=>l.x===s.x&&l.z===s.z);
  rows.push({...s,present,box:`${Math.min(...xs)}..${Math.max(...xs)},${Math.min(...zs)}..${Math.max(...zs)}`,
    current:siteHit?`site:${siteHit[0]}${town.built?.[siteHit[0]]?' (built)':''}`:lot?`home lot:${lot[0]}`:s.shape==='house'&&s.x===253&&s.z===155?'mayor house':'',spec:plan.spec});
}
rows.sort((a,b)=>a.shape.localeCompare(b.shape)||a.x-b.x||a.z-b.z||a.y-b.y);
for(const r of rows)console.log([r.shape.padEnd(9),`${r.x},${r.y},${r.z}`.padEnd(13),String(r.blocks).padStart(4),'standing',String(r.present??'?').padStart(4),
  `(${r.present!=null?Math.round(100*r.present/r.blocks):'?'}%)`.padEnd(7),(r.box??'').padEnd(18),r.current||'-',r.times>1?`x${r.times}`:''].join(' '));

// ---- outputs (with OUT=dir): demolish.json (abandoned attempts' citizen-placed blocks, minus anything that belongs to
// a current building) and check-<name>.txt (each current building's plan, for checking against the world) ----
if(process.env.OUT){
  const {writeFileSync}=await import('node:fs');
  const lotKey=r=>`${r.x},${r.z}`,lowest=new Map();
  for(const r of rows)if(r.shape==='house'&&r.blocks<200)lowest.set(lotKey(r),Math.min(lowest.get(lotKey(r))??999,r.y));
  const isCurrent=r=>{
    if(r.shape==='house'&&r.blocks<200)return r.y<=lowest.get(lotKey(r))+2&&!(r.x===294&&r.z===68);   // a home on its lot (not one on a roof); 294,68 is no lot
    if(r.shape==='house')return r.x===253&&r.z===155;                         // the mayor's house
    if(r.shape==='warehouse'||r.shape==='well')return true;
    return !!r.current;
  };
  const keep=new Set(),cur=[],gone=[];
  for(const r of rows){if(!r.spec)continue;(isCurrent(r)?cur:gone).push(r);}
  // A home lot can have several low starts (restarts): keep only the plan matching most of what stands.
  for(const r of cur)for(const b of blueprint(r.spec,r.x,r.y,r.z))keep.add(`${b.x},${b.y},${b.z}`);
  const demolish=[];const per=[];
  for(const r of gone){let n=0;for(const b of blueprint(r.spec,r.x,r.y,r.z)){const k=`${b.x},${b.y},${b.z}`;if(keep.has(k)||at.get(k)!==b.block)continue;keep.add(k);demolish.push([b.x,b.y,b.z]);n++;}if(n)per.push(`${r.shape} at ${r.x},${r.y},${r.z}: ${n}`);}
  writeFileSync(`${process.env.OUT}/demolish.json`,JSON.stringify(demolish));
  for(const r of cur)writeFileSync(`${process.env.OUT}/check-${r.shape}-${r.x}-${r.y}-${r.z}.txt`,blueprint(r.spec,r.x,r.y,r.z).map(b=>[b.x,b.y,b.z,b.block].join(' ')).join('\n'));
  console.log(`\nDEMOLISH ${demolish.length} blocks from ${per.length} abandoned attempts:\n  `+per.join('\n  '));
  console.log(`CURRENT ${cur.length}: `+cur.map(r=>`${r.shape}@${r.x},${r.y},${r.z}`).join(' '));
}
// complete-plans.json (with OUT and COMPLETE="shape@x,y,z|blocks;..."): the exact plans of current buildings to fill in.
if(process.env.OUT&&process.env.COMPLETE){
  const {writeFileSync}=await import('node:fs');
  const want=process.env.COMPLETE.split(';').map(s=>s.trim()).filter(Boolean);
  const plans=want.map(w=>{const m=/^(\w+)@(-?\d+),(-?\d+),(-?\d+)\|(\d+)=(.+)$/.exec(w);const r=rows.find(r=>r.shape===m[1]&&r.x===+m[2]&&r.y===+m[3]&&r.z===+m[4]&&r.blocks===+m[5]);
    if(!r?.spec)throw Error('no plan for '+w);return {name:m[6],shape:r.shape,x:r.x,y:r.y,z:r.z,spec:r.spec};});
  writeFileSync(`${process.env.OUT}/complete-plans.json`,JSON.stringify(plans,null,1));
  console.log('COMPLETE plans:',plans.map(p=>p.name).join(', '));
}
