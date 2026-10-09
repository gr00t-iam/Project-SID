import test from 'node:test';
import assert from 'node:assert/strict';
import {mineLayout,loadOf,bestPickaxe,MINE} from '../agent-core/roles/miner.mjs';
import {digPlan} from '../agent-core/blueprints.mjs';
import {recordDig,newDig} from '../agent-core/worker.mjs';

test('the strip-mine: galleries west from the hub, branches north and south every 4 blocks, all below the mining limit',()=>{
  const l=mineLayout();
  assert.deepEqual(l[0],{x:240,y:47,z:112,direction:'west',length:12,kind:'gallery'});
  assert.deepEqual(l.slice(1,3).map(t=>[t.x,t.direction]),[[236,'north'],[236,'south']]);
  assert.equal(l.filter(t=>t.kind==='gallery').length,MINE.maxLegs);
  assert.ok(l.every(t=>t.y<50),'tunnels stay below y 50 where mining is allowed');
  const plan=digPlan({shape:'tunnel',direction:'north',length:16},236,47,112);
  assert.equal(plan.length,16);assert.deepEqual(plan[0].dig,[{x:236,y:48,z:111},{x:236,y:47,z:111}]);
});
test('a block a little out of reach no longer ends the dig; lava still does',()=>{
  const dig=newDig('t',[{dig:[{x:1,y:1,z:1}],stand:{x:1,y:1,z:1}}],{x:0,y:1,z:0});
  assert.equal(recordDig(dig,[{block:dig.steps[0].dig[0],ok:false,error:'Target outside allowed range'}]).stop,undefined);
  assert.match(recordDig(dig,[{block:dig.steps[0].dig[0],ok:false,error:'Lava behind this block; leave it'}]).stop,/Lava/);
});
test('load and pickaxes',()=>{
  assert.equal(loadOf({RAW_IRON:40,COAL:30,COBBLESTONE:60,TORCH:32,BREAD:4}),130);
  assert.equal(bestPickaxe('NONE',{STONE_PICKAXE:1,WOODEN_PICKAXE:1}),'STONE_PICKAXE');
  assert.equal(bestPickaxe('IRON_PICKAXE',{}),'IRON_PICKAXE');
});
