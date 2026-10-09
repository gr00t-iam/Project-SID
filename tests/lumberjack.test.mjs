import test from 'node:test';
import assert from 'node:assert/strict';
import {STATES,axePlan,nextState,pickSapling,saplingFor,bestAxe,netGreen,line} from '../agent-core/lumber.mjs';
import {simulate} from '../scripts/simulate-lumberjack.mjs';

test('axes: the best one the town can make - iron, then stone, then wood - and what to fetch for it',()=>{
  assert.deepEqual(axePlan({},{STICK:128,OAK_PLANKS:33}),{axe:'WOODEN_AXE',withdraw:{OAK_PLANKS:3,STICK:2},crafts:[{item:'WOODEN_AXE',times:1}]});
  assert.equal(axePlan({},{IRON_INGOT:5,STICK:4}).axe,'IRON_AXE');
  assert.equal(axePlan({},{COBBLESTONE:3,BIRCH_PLANKS:2}).axe,'STONE_AXE','sticks from planks');
  assert.deepEqual(axePlan({OAK_LOG:2},{}).crafts.map(c=>c.item),['OAK_PLANKS','STICK','WOODEN_AXE'],'two logs by hand make an axe');
  assert.deepEqual(axePlan({},{}),{missing:{LOG:2}});
  assert.equal(bestAxe('NONE',{WOODEN_AXE:1,STONE_AXE:1}),'STONE_AXE');
});
test('the state machine: replanting first, then hauling, tools, felling',()=>{
  assert.equal(nextState({inventory:{},stock:{}}),STATES.GATHER_CRAFTING_MATS,'no axe and nothing to make one');
  assert.equal(nextState({inventory:{},stock:{STICK:2,OAK_PLANKS:3}}),STATES.CRAFT_AXE);
  assert.equal(nextState({held:'WOODEN_AXE',inventory:{}}),STATES.SCOUT_TREES);
  assert.equal(nextState({held:'WOODEN_AXE',inventory:{},tree:{x:1,z:1}}),STATES.HARVEST_TREE);
  assert.equal(nextState({inventory:{},tree:{x:1,z:1},manual:true}),STATES.HARVEST_TREE,'axe broke mid-tree: finish by hand');
  assert.equal(nextState({held:'WOODEN_AXE',inventory:{OAK_LOG:64}}),STATES.HAUL_TO_WAREHOUSE);
  assert.equal(nextState({held:'WOODEN_AXE',inventory:{OAK_LOG:9,OAK_SAPLING:1},stumps:[{log:'OAK_LOG'}]}),STATES.REPLANT_SEED,'a stump comes before hauling');
  assert.equal(nextState({held:'WOODEN_AXE',inventory:{},stumps:[{log:'OAK_LOG'}],foliageTries:0}),STATES.CLEAR_FOLIAGE,'no sapling: clear the canopy');
});
test('saplings: the same kind first, any kind otherwise; dark oak only as four',()=>{
  assert.equal(saplingFor('SPRUCE_LOG'),'SPRUCE_SAPLING');assert.equal(saplingFor('MANGROVE_LOG'),'MANGROVE_PROPAGULE');
  assert.equal(pickSapling('BIRCH_LOG',{OAK_SAPLING:2,BIRCH_SAPLING:1}),'BIRCH_SAPLING');
  assert.equal(pickSapling('BIRCH_LOG',{OAK_SAPLING:2}),'OAK_SAPLING');
  assert.equal(pickSapling('DARK_OAK_LOG',{DARK_OAK_SAPLING:2,OAK_SAPLING:1}),'OAK_SAPLING','two dark oak saplings would never grow');
  assert.equal(pickSapling('DARK_OAK_LOG',{DARK_OAK_SAPLING:4}),'DARK_OAK_SAPLING');
  assert.equal(pickSapling('OAK_LOG',{}),null);
});
test('his voice and his ledger',()=>{
  assert.match(line('apology',{tree:'oak'},()=>0),/oak/);
  assert.equal(netGreen({seeds_replanted:7,trees_harvested:5}),2);
});
test('a full cycle: no axe -> craft axe -> fell -> replant every stump -> deposit timber',async()=>{
  const r=await simulate();
  const order=r.states;
  for(const s of ['CRAFT_AXE','SCOUT_TREES','HARVEST_TREE','REPLANT_SEED','HAUL_TO_WAREHOUSE'])assert.ok(order.includes(s),`visited ${s}`);
  assert.ok(order.indexOf('CRAFT_AXE')<order.indexOf('HARVEST_TREE')&&order.indexOf('HARVEST_TREE')<order.indexOf('REPLANT_SEED')&&order.indexOf('REPLANT_SEED')<order.indexOf('HAUL_TO_WAREHOUSE'));
  assert.equal(r.ledger.trees_harvested,4);assert.equal(r.ledger.seeds_replanted,4,'1:1 replanting');
  assert.equal(r.saplingsInWorld,4);assert.equal(r.ledger.total_logs_delivered,20);assert.equal(r.stock.OAK_LOG,20);
  assert.ok(r.events.some(e=>e.type==='foliage_cleared'),'no sapling dropped once: he cleared the canopy for one');
  assert.ok(r.events.some(e=>e.type==='axe_broke')&&r.events.some(e=>e.type==='tree_felled'&&e.manual),'axe broke mid-tree: finished by hand');
  assert.ok(r.said.some(t=>/forgive|sorry|rest well|easy now/i.test(t)),'apologised to a tree');
});
test('a tree he cannot reach is marked unreachable for a while, and he fells the next one instead',async()=>{
  const r=await simulate({trees:[[244,104],[236,118],[232,108]],walledOff:[244,104],maxTicks:300});
  assert.ok(r.events.some(e=>e.type==='tree_unreachable'&&e.x===244&&e.z===104));
  assert.ok(r.events.some(e=>e.type==='tree_felled'&&(e.x===236||e.x===232)),'moved on to the next tree');
  assert.ok(Object.keys(r.town.forest.unreachable).includes('244,104'));
});
