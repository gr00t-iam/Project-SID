import test from 'node:test';
import assert from 'node:assert/strict';
import {decide,pantryPoints,AGENT,PLUGIN_SETTINGS} from '../agent-core/roles/fisher.mjs';
const base={phase:'day',raining:false,inventory:{FISHING_ROD:1},tripDoneToday:true,onTrip:false,pantryPoints:500,worldTime:8000};
test('Finley rests at night, heads home from trips at dusk or in rain',()=>{
  assert.equal(decide({...base,phase:'night'}),'rest');
  assert.equal(decide({...base,phase:'night',onTrip:true}),'return');
  assert.equal(decide({...base,onTrip:true}),'trip');
  assert.equal(decide({...base,onTrip:true,phase:'evening'}),'return');
  assert.equal(decide({...base,onTrip:true,raining:true}),'return');
});
test('Finley mends his rod, cooks a catch, delivers loads and otherwise fishes',()=>{
  assert.equal(decide({...base,inventory:{}}),'rod');
  assert.equal(decide({...base,inventory:{FISHING_ROD:1,COD:6,SALMON:3}}),'cook');
  assert.equal(decide({...base,inventory:{FISHING_ROD:1,COD:2},phase:'evening'}),'cook','cooks the last fish at dusk');
  assert.equal(decide({...base,inventory:{FISHING_ROD:1,RED_MUSHROOM:1,BROWN_MUSHROOM:1,BOWL:1}}),'cook','stew');
  assert.equal(decide({...base,inventory:{FISHING_ROD:1,COOKED_COD:10,SWEET_BERRIES:8}}),'deliver');
  assert.equal(decide({...base,inventory:{FISHING_ROD:1,APPLE:1},phase:'evening'}),'deliver');
  assert.equal(decide(base),'fish');
});
test('Finley forages around midday in clear weather, once a day, unless the pantry is critical',()=>{
  const midday={...base,worldTime:4000,tripDoneToday:false};
  assert.equal(decide(midday),'trip');
  assert.equal(decide({...midday,raining:true}),'fish');
  assert.equal(decide({...midday,tripDoneToday:true}),'fish');
  assert.equal(decide({...midday,pantryPoints:10}),'fish','a critical pantry keeps him fishing');
  assert.equal(decide({...midday,pantryPoints:150,lean:true}),'fish','in a drought or winter he stays at the lake');
  assert.equal(decide({...midday,pantryPoints:300,lean:true}),'trip');
  assert.equal(decide({...base,gardenDue:true}),'garden');
  assert.equal(decide({...base,escort:true}),'escort');
});
test('pantry points and the agent definition',()=>{
  assert.equal(pantryPoints({BREAD:2,COOKED_SALMON:1,STONE:50}),16);
  assert.equal(AGENT.name,'Finley the Angler');assert.equal(AGENT.camp,true);
  assert.ok(PLUGIN_SETTINGS['expedition-agents'].includes('fisher'));
});
test('without a warehouse Finley keeps fishing instead of trying to deliver',()=>{
  assert.equal(decide({...base,inventory:{FISHING_ROD:1,COOKED_COD:20},hasPantry:false}),'fish');
});
