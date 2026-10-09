import test from 'node:test';
import assert from 'node:assert/strict';
import {FOOD_POINTS,EDIBLE_FOODS,edibleIn,dropOffItems} from '../agent-core/town.mjs';
import {pantryPoints} from '../agent-core/roles/fisher.mjs';

test('everything the pantry holds is food citizens will eat (fish and berries included)',()=>{
  for(const item of ['COOKED_COD','COOKED_SALMON','SWEET_BERRIES','PUMPKIN_PIE','BREAD','BAKED_POTATO'])assert.ok(EDIBLE_FOODS.includes(item),item);
  assert.ok(pantryPoints({SWEET_BERRIES:10})>0&&FOOD_POINTS.SWEET_BERRIES>0,'what the pantry counts, citizens can eat');
});
test('the most filling food is eaten first, and raw fish or seeds are not food',()=>{
  assert.equal(edibleIn({SWEET_BERRIES:80,COOKED_COD:1}),'COOKED_COD');
  assert.equal(edibleIn({SWEET_BERRIES:80}),'SWEET_BERRIES');
  assert.equal(edibleIn({COD:3,WHEAT_SEEDS:5}),null);
  const pts=EDIBLE_FOODS.map(f=>FOOD_POINTS[f]);assert.deepEqual(pts,[...pts].sort((a,b)=>b-a),'ordered most filling first');
});
test('drop-offs keep 8 of each food for the citizen',()=>{
  assert.deepEqual(dropOffItems({SWEET_BERRIES:80},'herbalist'),[['SWEET_BERRIES',72]]);
});
