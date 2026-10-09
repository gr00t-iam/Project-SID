import test from 'node:test';
import assert from 'node:assert/strict';
import {communityDate,createCommunityBoard,gardenCandidates} from '../agent-core/community.mjs';

const configs=['herbalist','priest','scribe','governor','crafter','smith','farmer','fisher','scout','lumberjack'].map(id=>({id,role:id,name:id}));
function fixture(state={}){
  let time=Date.parse('2026-10-09T05:01:00Z'),saves=0;
  const stock={OAK_LOG:300,SPRUCE_LOG:300,OAK_PLANKS:300,SPRUCE_PLANKS:300,STICK:300,STONE:300,STONE_BRICKS:300,COBBLESTONE:300,GLASS:300,IRON_INGOT:300,IRON_NUGGET:300,TORCH:300,POPPY:60,DANDELION:60,CORNFLOWER:60,OXEYE_DAISY:60,ALLIUM:60,AZURE_BLUET:60,LANTERN:60,WHITE_TULIP:60,ORANGE_TULIP:60,RED_TULIP:60};
  const inventories=Object.fromEntries(configs.map(c=>[c.id,{}])),actions=[];
  let fail=false,depositLimit=Infinity,depositError=null;
  const world={zones:[{kind:'park',status:'adopted',x1:0,z1:0,x2:15,z2:15}],footprints:[],roads:[],farms:[],playerEdits:{}};
  const board=createCommunityBoard({state,configs,now:()=>time,random:()=>0.37,save:async()=>{saves++;},stock:()=>stock,land:()=>world,
    goToWarehouse:async()=>true,withdraw:async(id,item,n)=>{const got=Math.min(n,stock[item]??0);stock[item]-=got;inventories[id][item]=(inventories[id][item]??0)+got;return got;},
    deposit:async(id,item,n)=>{if(depositError)throw depositError;const got=Math.min(n,depositLimit,inventories[id][item]??0);inventories[id][item]-=got;stock[item]=(stock[item]??0)+got;return got;},travel:async()=>{},
    act:async(id,a)=>{actions.push(a);if(a.type==='survey')return {heights:[70],tops:['GRASS_BLOCK'],liquid:[false]};if(a.type==='scan')return {cells:[]};if(fail)throw Error('Space occupied');if(a.type==='place'){inventories[id][a.target]--;return 'placed';}if(a.type==='craft')return {crafted:a.target,times:a.count};},
  });
  return {state,board,stock,world,actions,inventories,self:id=>({id,x:5,y:71,z:5,inventory:inventories[id]}),setTime:t=>{time=Date.parse(t);},saves:()=>saves,fail:()=>{fail=true;},limit:n=>{depositLimit=n;},failDeposit:()=>{depositError=Error('Disconnected; action outcome unknown');}};
}
test('calendar rolls at Chicago midnight including daylight saving boundaries',()=>{
  assert.equal(communityDate(Date.parse('2026-10-09T04:59:59Z')),'2026-10-08');
  assert.equal(communityDate(Date.parse('2026-10-09T05:00:00Z')),'2026-10-09');
  assert.equal(communityDate(Date.parse('2026-12-09T05:59:59Z')),'2026-12-08');
  assert.equal(communityDate(Date.parse('2026-12-09T06:00:00Z')),'2026-12-09');
});
test('ten distinct daily projects retain progress on restart and rotate only on a real day',async()=>{
  const f=fixture();await f.board.tick();const a=f.board.view();
  assert.equal(a.items.length,10);assert.equal(new Set(a.items.map(m=>m.template)).size,10);
  assert.equal(a.items.filter(m=>m.kind==='garden').length,4);
  f.state.items[0].have=2;
  const restarted=fixture(JSON.parse(JSON.stringify(f.state)));await restarted.board.tick();
  assert.equal(restarted.board.view().items[0].have,2);
  assert.deepEqual(restarted.board.view().items.map(m=>m.id),a.items.map(m=>m.id));
  f.setTime('2026-10-10T04:59:00Z');await f.board.tick();assert.equal(f.board.view().date,'2026-10-09');
  f.setTime('2026-10-10T05:00:00Z');await f.board.tick();
  assert.equal(f.board.view().date,'2026-10-10');assert.equal(f.state.history[0].date,'2026-10-09');
  assert.ok(f.board.view().items.every(m=>!a.items.some(old=>old.template===m.template)));
});
test('clock moving backward does not discard the current board',async()=>{
  const f=fixture();await f.board.tick();f.setTime('2026-10-08T10:00:00Z');await f.board.tick();assert.equal(f.board.view().date,'2026-10-09');
});
test('garden candidates exclude roads, buildings, farms and recent player edits',()=>{
  const cells=gardenCandidates({zones:[{kind:'park',status:'adopted',x1:0,z1:0,x2:10,z2:10}],footprints:[{x1:1,z1:1,x2:3,z2:3}],roads:[{a:{x:5,z:0},b:{x:5,z:10},width:2}],farms:[{x1:8,z1:1,x2:9,z2:9}],playerEdits:{'1,7':Date.parse('2026-10-09T05:00:00Z')}},Date.parse('2026-10-09T05:01:00Z'));
  assert.ok(cells.length>0);
  assert.ok(cells.every(p=>!(p.x<=4&&p.z<=4)&&!(p.x>=4&&p.x<=8)&&p.x<7&&!(p.x===1&&p.z===7)));
});
test('failed placement leaves progress unchanged',async()=>{
  const f=fixture();await f.board.tick();const m=f.state.items.find(x=>x.kind==='garden');
  const c=configs.find(c=>c.id===m.agent);m.cursor=0;f.inventories[c.id][m.item]=8;f.fail();
  await f.board.job(c,{},f.self(c.id))();assert.equal(m.have,0);assert.equal(m.status,'blocked');
  assert.ok(f.saves()>1);
});
test('reserved farm zones stay clear even before their crop tiles are discovered',()=>{
  const cells=gardenCandidates({zones:[{kind:'public',status:'adopted',x1:0,z1:0,x2:10,z2:10},{kind:'farms',status:'adopted',x1:0,z1:0,x2:5,z2:10}]});
  assert.ok(cells.length>0);assert.ok(cells.every(p=>p.x>6));
});
test('an unacknowledged deposit is held for inspection and never retried',async()=>{
  const f=fixture();await f.board.tick();const m=f.state.items.find(x=>x.kind==='supply');const c=configs.find(c=>c.id===m.agent);
  m.pending=5;f.inventories[c.id][m.item]=5;f.failDeposit();await f.board.job(c,{},f.self(c.id))();
  assert.equal(m.have,0);assert.equal(m.status,'review');assert.equal(m.operation.type,'deposit');
  for(const other of f.state.items)if(other!==m)other.status='completed';
  assert.equal(f.board.job(c,{},f.self(c.id)),null);
});
test('successful garden placement credits exactly one new block and survives restart',async()=>{
  const f=fixture();await f.board.tick();const m=f.state.items.find(x=>x.kind==='garden');m.cursor=0;
  const c=configs.find(c=>c.id===m.agent);f.inventories[c.id][m.item]=8;
  await f.board.job(c,{},f.self(c.id))();assert.equal(m.have,1);
  assert.equal(f.actions.filter(a=>a.type==='place').length,1);
  assert.equal(fixture(JSON.parse(JSON.stringify(f.state))).board.view().items.find(x=>x.id===m.id).have,1);
});
test('restart of an interrupted world action requires review rather than duplicate credit',async()=>{
  const f=fixture();await f.board.tick();const m=f.state.items[0];m.operation={type:'place',at:1};
  const reboot=fixture(JSON.parse(JSON.stringify(f.state)));
  assert.equal(reboot.board.view().items[0].status,'review');
  for(const other of reboot.state.items)if(other.id!==m.id)other.status='completed';
  const c=configs.find(c=>c.id===m.agent);
  assert.equal(reboot.board.job(c,{},reboot.self(c.id)),null);
});
test('unsafe or occupied garden ground never receives a placement',async()=>{
  const f=fixture();await f.board.tick();const m=f.state.items.find(x=>x.kind==='garden');
  const c=configs.find(c=>c.id===m.agent);f.inventories[c.id][m.item]=8;f.world.zones=[];
  await f.board.job(c,{},f.self(c.id))();assert.equal(m.have,0);assert.ok(!f.actions.some(a=>a.type==='place'));
});
test('existing stock never completes production and partial delivery earns only delivered units',async()=>{
  const f=fixture();await f.board.tick();const m=f.state.items.find(x=>x.kind==='supply');const c=configs.find(c=>c.id===m.agent);
  assert.equal(m.have,0);m.pending=5;f.inventories[c.id][m.item]=5;f.limit(2);
  await f.board.job(c,{},f.self(c.id))();assert.equal(m.have,2);assert.equal(m.pending,3);assert.notEqual(m.status,'completed');
});
test('projects never interrupt active builds, digs, rest or navigation',async()=>{
  const f=fixture();await f.board.tick();const c=configs.find(c=>c.id===f.state.items[0].agent);
  assert.ok(f.board.job(c,{},f.self(c.id)));
  for(const s of [{project:{}},{dig:{}},{farm:{}},{producing:true},{supply:{}},{resting:true},{contract:{}},{order:{}}])assert.equal(f.board.job(c,s,f.self(c.id)),null);
  assert.equal(f.board.job(c,{}, {...f.self(c.id),pathing:true}),null);
});
