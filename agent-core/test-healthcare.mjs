// Healthcare end to end with a scripted town: Rosa the medic, the infirmary and the records.
//   1. TRIAGE       a critically wounded miner, a starving courier and a scratched farmer: worst first
//   2. EMERGENCY    Rosa interrupts her day, walks to the miner and treats him with a healing remedy
//   3. HURT         the starving courier is the courier rounds' to feed, not hers; Rosa goes to the hurt farmer and treats him
//   4. INFIRMARY    with the infirmary built, a critically wounded smith is admitted to a free bed, walks to it, is
//                   treated there and discharged once back above the hurt line; every step is in the records
//   node agent-core/test-healthcare.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {triage,treatmentFor,createHealthcare,CRITICAL,HURT} from './skills/healthcare.mjs';
import {infirmaryLayout} from './blueprints.mjs';

const CONFIGS=[{id:'herbalist',role:'herbalist',name:'Rosa the Herbalist'},{id:'miner',role:'miner',name:'Dorn the Miner'},
  {id:'courier',role:'courier',name:'Barnaby the Runner'},{id:'farmer',role:'farmer',name:'Hazel the Farmer'},{id:'smith',role:'smith',name:'Vulcan the Smith'}];

export async function simulate(){
  const failures=[],check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=Date.parse('2026-10-03T09:00:00Z');const now=()=>t;
  const said=[],acts=[],ledger=[],logs=[];
  const snap={agents:[{id:'herbalist',x:252,y:68,z:94,health:20,potions:{HEALING:6},inventory:{POPPY:4}},{id:'miner',x:240,y:48,z:112,health:3},
    {id:'courier',x:280,y:69,z:107,health:18},{id:'farmer',x:276,y:69,z:96,health:11},{id:'smith',x:243,y:66,z:90,health:20}]};
  const pos=id=>snap.agents.find(a=>a.id===id);
  const memory={data:{town:{day:312,built:{}},agents:{miner:{needs:{hunger:15}},courier:{needs:{hunger:2}},farmer:{needs:{hunger:14}},smith:{needs:{hunger:16}},herbalist:{needs:{hunger:18}}}}};
  const travel=async(id,self,p)=>{Object.assign(pos(id),{x:p.x,z:p.z});};
  const act=async(id,a)=>{acts.push({id,...a});
    if(a.type==='dose'){pos(id).potions[a.target]--;pos(a.to).health=Math.min(20,pos(a.to).health+8);return {dosed:a.to,treated:1};}
    if(a.type==='wage'){memory.data.agents[a.to].needs.hunger+=5*a.count;return {ok:true};}
    return {ok:true};};
  let layout=null;
  const hc=createHealthcare({memory,configs:CONFIGS,act,say:async(id,x)=>said.push(`${id}: ${x}`),log:(type,d)=>logs.push({type,...d}),ledger:(id,x)=>ledger.push(x),
    getSnapshot:()=>snap,travel,now,feedsStarving:()=>true,infirmaryLayout:()=>layout,fetchFood:async(id)=>{pos(id).inventory.BREAD=4;return {item:'BREAD',count:4};}});
  const run=async id=>{const c=CONFIGS.find(x=>x.id===id),j=hc.job(c,memory.data.agents[id],pos(id));if(j)await j();return !!j;};

  // ---------- 1. TRIAGE ----------
  const k=triage(snap.agents,{needsOf:id=>memory.data.agents[id]?.needs,exclude:['herbalist']});
  check(k.map(x=>`${x.id}:${x.kind}`).join(',')==='miner:critical,courier:starving,farmer:hurt','triage: critical, then starving, then hurt');
  check(treatmentFor({kind:'critical'},{potions:{HEALING:1}}).potion==='HEALING'&&treatmentFor({kind:'starving'},{inventory:{}}).action==='none','treatment follows what she carries');

  // ---------- 2. EMERGENCY ----------
  check(await run('herbalist'),'a critical case interrupts the medic (a triage job)');
  check(Math.hypot(pos('herbalist').x-pos('miner').x,pos('herbalist').z-pos('miner').z)<=3,'Rosa went to the miner');
  await run('herbalist');
  check(pos('miner').health===11&&acts.some(a=>a.type==='dose'&&a.to==='miner'&&a.target==='HEALING'),'the miner is treated with a healing remedy');
  check(ledger.some(x=>/treated Dorn \(critical, health 3\/20\)/.test(x)),'the ledger has the treatment with the numbers');

  // ---------- 3. THE HURT (not the hungry) ----------
  await run('herbalist');await run('herbalist');await run('herbalist');   // Dorn (still hurt) first, then Hazel
  check(pos('miner').health===19&&pos('farmer').health===19&&acts.some(a=>a.type==='dose'&&a.to==='farmer'),'Rosa treats the hurt (Dorn again, then the farmer) with remedies');
  check(memory.data.agents.courier.needs.hunger<=STARVE_LINE()&&!acts.some(a=>a.type==='wage'),'the starving courier is not her call (the courier rounds feed the starving)');
  check(!(await run('herbalist')),'nobody wounded left: no call');

  // ---------- 4. INFIRMARY ----------
  layout=infirmaryLayout({x:231,y:67,z:97});memory.data.town.built.infirmary=true;
  pos('smith').health=2;
  check(await run('smith'),'a critically wounded citizen stops work for the infirmary');
  check(hc.state.admitted.smith?.bed===1&&Math.hypot(pos('smith').x-layout.beds[0].x,pos('smith').z-layout.beds[0].z)<1,'admitted to bed 1 and walked there');
  await run('herbalist');await run('herbalist');
  check(pos('smith').health===10&&hc.state.records.some(r=>r.kind==='treated'&&r.patient==='smith'&&r.at==='the infirmary'),'treated at the infirmary');
  check(await run('smith'),'still below the hurt line: stays in bed');
  await run('herbalist');   // health 10 is not critical: the herb loop would treat it; here a second dose by hand
  pos('smith').health=HURT+2;
  check(!(await run('smith'))&&!hc.state.admitted.smith&&hc.state.records.some(r=>r.kind==='discharged'&&r.patient==='smith'),'discharged once recovered');
  check(hc.state.stats.admitted===1&&hc.state.stats.discharged===1&&hc.state.stats.treated===5&&hc.state.stats.fed===0,`the clinic's numbers add up (${JSON.stringify(hc.state.stats)})`);
  check(CRITICAL===4,'critical means 20% health or less');
  return {failures,said};
}
const STARVE_LINE=()=>3;

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();for(const l of r.said)console.log('  '+l);
  if(r.failures.length){console.log(`\n${r.failures.length} failure(s):`);for(const f of r.failures)console.log('  FAIL '+f);process.exit(1);}
  console.log('\nall healthcare checks passed');
}
