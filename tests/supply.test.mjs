import test from 'node:test';
import assert from 'node:assert/strict';
import {roomFor,surplusOf,loadOf,standingOrders,HAUL_LIMIT,capOf} from '../agent-core/skills/supply.mjs';

test('storage caps keep bulk junk from filling the warehouse',()=>{
  assert.equal(roomFor('WHEAT_SEEDS',64,6144),0,'no more seeds');
  assert.equal(roomFor('OAK_LOG',64,0),64,'logs always have room');
  assert.equal(roomFor('SWEET_BERRIES',100,200),56,'only up to the cap');
  const sur=surplusOf({WHEAT_SEEDS:6144,SWEET_BERRIES:4534,OAK_LOG:10});
  assert.deepEqual(sur.map(s=>s.item),['WHEAT_SEEDS','SWEET_BERRIES']);assert.equal(sur[0].over,6144-capOf('WHEAT_SEEDS'));
});
test('a heavy surplus is moved in loads of at most HAUL_LIMIT items',()=>{
  const load=loadOf(surplusOf({WHEAT_SEEDS:6144,SWEET_BERRIES:4534}));
  assert.equal(load.reduce((a,b)=>a+b.count,0),HAUL_LIMIT);assert.equal(load[0].item,'WHEAT_SEEDS');
});
test('standing orders: the forge below 3 iron or 5 coal, the warehouse below 16 logs',()=>{
  const o=standingOrders({smith:{COAL:4,IRON_INGOT:1},stock:{IRON_INGOT:1}});
  assert.ok(o.some(x=>x.key==='forge:iron'&&x.role==='miner'));assert.ok(o.some(x=>x.key==='forge:coal'));assert.ok(o.some(x=>x.role==='lumberjack'));
  assert.equal(standingOrders({smith:{COAL:14},stock:{IRON_INGOT:89,OAK_LOG:40}}).length,0,'the live town today: nothing short but... coal in the smith\'s pack is enough');
});
