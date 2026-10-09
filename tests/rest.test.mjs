import test from 'node:test';
import assert from 'node:assert/strict';
import {restInPlace,holyDayDue,createRestPolicy,HOLY_DAY_MS,REST_START,REST_UNTIL} from '../agent-core/skills/rest.mjs';
import {CRITICAL,RECOVERED,criticalNeeds,recovered} from '../agent-core/intel/motivation.mjs';

test('the rest mandate: rest at 20% energy, keep resting to 75%',()=>{
  assert.equal(CRITICAL.energy,REST_START);assert.equal(RECOVERED.energy,REST_UNTIL);
  const v=e=>({health:100,hunger:100,energy:e,threat:0});
  assert.ok(criticalNeeds(v(19)).includes('energy'),'19% is critical');
  assert.ok(!recovered(v(60)),'60% is not yet recovered (it used to be at 45%)');
  assert.ok(recovered(v(76)),'76% is recovered');
});
test('rest where you are when home is far or you are down the mine',()=>{
  assert.equal(restInPlace({x:216,y:23,z:112},{x:300,z:100}),true,'the miner 45 blocks down');
  assert.equal(restInPlace({x:290,y:70,z:100},{x:300,z:100}),false,'near home: walk home');
  assert.equal(restInPlace({x:150,y:70,z:100},{x:300,z:100}),true,'150 blocks away: rest here');
});
test('the Holy Day: weekly from Proposal #33, or called when the town is worn out',()=>{
  const policy={restDay:293};
  assert.ok(holyDayDue({day:300,phase:'dawn',policy}),'day 300 = 293 + 7');
  assert.equal(holyDayDue({day:301,phase:'dawn',policy}),null);
  assert.equal(holyDayDue({day:300,phase:'day',policy}),null,'only at dawn');
  assert.equal(holyDayDue({day:300,phase:'dawn',policy,last:{day:300}}),null,'once a day');
  assert.match(holyDayDue({day:302,phase:'day',policy,avgEnergy:30}).reason,/worn out/);
  assert.equal(holyDayDue({day:302,phase:'day',policy,avgEnergy:30,last:{day:301}}),null,'at most every other day');
});
test('the Holy Day pauses work, gathers the town at the shrine and sends everyone away rested',async()=>{
  let t=1e9;const now=()=>t;
  const configs=[{id:'priest',role:'priest'},{id:'builder',role:'builder'},{id:'miner',role:'miner'}];
  const memory={data:{town:{day:300,policy:{restDay:293}},agents:{priest:{needs:{energy:60}},builder:{needs:{energy:30}},miner:{needs:{energy:10}}}}};
  const snap={agents:[{id:'priest',x:268,y:70,z:90},{id:'builder',x:300,y:70,z:150},{id:'miner',x:216,y:23,z:112}]};
  const ledger=[],said=[];
  const rp=createRestPolicy({memory,configs,now,getSnapshot:()=>snap,ledger:(id,x)=>ledger.push(x),say:async(id,x)=>said.push(x),
    travel:async(id,self,p)=>Object.assign(snap.agents.find(a=>a.id===id),{x:p.x,z:p.z}),shrine:()=>({x:268.5,z:90.5})});
  rp.tick({day:300,phase:'dawn'});
  assert.ok(rp.active(),'the weekly holy day began at dawn');
  assert.match(said[0],/Holy Day/);
  for(const c of configs){const s=memory.data.agents[c.id],self=snap.agents.find(a=>a.id===c.id);await rp.holyJob(c,s,self)();await rp.holyJob(c,s,self)();}
  assert.ok(configs.every(c=>memory.data.agents[c.id].holyRest),'everyone is at the shrine, resting');
  assert.equal(rp.state.holyDay.kept.length,3);
  t+=HOLY_DAY_MS+1;rp.tick({day:300,phase:'day'});
  assert.ok(!rp.active());
  assert.ok(configs.every(c=>memory.data.agents[c.id].needs.energy===100&&!memory.data.agents[c.id].holyRest),'fully rested, back to work');
  assert.ok(ledger.some(x=>/ended; 3 citizens kept it/.test(x)));
});
