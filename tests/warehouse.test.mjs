import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../agent-core/test-warehouse.mjs';

test('the warehouse clerk: categories, the drop box, misfiled goods, merging, the location index, overflow and locks (agent-core/test-warehouse.mjs)',async()=>{
  const r=await simulate();assert.deepEqual(r.failures,[]);
});
import {WarehouseMap} from '../agent-core/skills/warehouse.mjs';
test('retired floor chests are emptied into the wall chests first, and never receive anything',()=>{
  const map=new WarehouseMap({assign:{'285,70,108':'RETIRED','282,70,102':'BUILDING_BLOCKS','286,70,102':'ORES_AND_METALS','288,70,111':'INPUT_DROP_BOX'}});
  const chests=[{x:285,y:70,z:108,size:54,free:40,items:{COBBLESTONE:100,COAL:20}},{x:282,y:70,z:102,size:54,free:54,items:{}},{x:286,y:70,z:102,size:54,free:54,items:{}},{x:288,y:70,z:111,size:54,free:54,items:{}}];
  const m=map.nextMove(chests);
  assert.equal(m.kind,'retire');assert.equal(m.from.x,285);assert.ok([102].includes(m.to.z));
  assert.notEqual(map.targetFor('COBBLESTONE',chests).x,285,'never deposit into a retired chest');
  assert.equal(map.retiredLeft(chests).length,1);
  chests[0].items={};assert.equal(map.retiredLeft(chests).length,0);
});
test('an empty chest is given to one item when its category has no room for the load (30 beds, a slot each)',()=>{
  const map=new WarehouseMap({assign:{'1,70,1':'INPUT_DROP_BOX','2,70,1':'BUILDING_BLOCKS','3,70,1':'BUILDING_BLOCKS','4,70,1':'ORES_AND_METALS'}});
  const chests=[{x:1,y:70,z:1,size:54,free:7,items:{RED_BED:30}},{x:2,y:70,z:1,size:54,free:2,items:{COBBLESTONE:3200}},{x:3,y:70,z:1,size:54,free:54,items:{}},{x:4,y:70,z:1,size:54,free:54,items:{}}];
  const m=map.nextMove(chests);
  assert.equal(m.kind,'drop_box');assert.equal(m.item,'RED_BED');assert.equal(m.to.x,3);   // the empty building-blocks chest, not the one with 2 slots
  assert.equal(map.dedicatedTo(chests[2]),'RED_BED');
  // Given to beds: cobblestone does not go there, and a stray item in it is misfiled.
  chests[2].items={RED_BED:30,DIRT:5};chests[2].free=19;
  assert.notEqual(map.targetFor('DIRT',chests,{count:5})?.x,3);
  chests[0].items={};const mv=map.nextMove(chests);assert.equal(mv.item,'DIRT');assert.equal(mv.from.x,3);
  // Emptied: free again.
  chests[2].items={};chests[2].free=54;map.nextMove(chests);assert.equal(map.dedicatedTo(chests[2]),null);
});
