import test from 'node:test';
import assert from 'node:assert/strict';
import {familyOf,logsFor,supplyPlan,supplySteps,shortages,recipeFor} from '../agent-core/materials.mjs';

// The warehouse on day 235: lots of oak and stone, no spruce, no cobblestone, no fittings.
const stock={OAK_LOG:425,OAK_PLANKS:217,BIRCH_PLANKS:128,STONE_BRICKS:195,BRICKS:23,MOSSY_STONE_BRICKS:64,STONE:64,DIRT:740,GLASS_PANE:106};
const total=(steps,kind,key,item)=>steps.filter(s=>s.kind===kind&&s[key]===item).reduce((n,s)=>n+s.count,0);

test('block kinds and logs for planks',()=>{
  assert.equal(familyOf('SPRUCE_PLANKS'),'planks');assert.equal(familyOf('STRIPPED_OAK_LOG'),'log');
  assert.equal(familyOf('COBBLESTONE'),'stone');assert.equal(familyOf('FURNACE'),null);
  assert.deepEqual(logsFor('SPRUCE_PLANKS'),['SPRUCE_LOG','STRIPPED_SPRUCE_LOG','SPRUCE_WOOD']);
});
test('the forge: every block is fetched, crafted, swapped or left out - nothing waits on supplies that are not coming',()=>{
  const missing=[['SPRUCE_PLANKS',81],['STRIPPED_OAK_LOG',16],['COBBLESTONE',44],['BRICKS',121],['STONE_BRICKS',99],['FURNACE',2],['ANVIL',1],['CRAFTING_TABLE',1],['DIRT',28]];
  const steps=supplyPlan(missing,{stock,have:{SPRUCE_LOG:16}});
  const targets=new Set(steps.filter(s=>s.kind==='swap').map(s=>s.to));
  for(const [item,n] of missing){
    if(targets.has(item))continue;   // its fetches also cover the blocks swapped to it
    const covered=total(steps,'fetch','item',item)+total(steps,'craft','item',item)+total(steps,'swap','from',item)+total(steps,'drop','item',item);
    assert.equal(covered,n,item);
  }
  assert.equal(total(steps,'fetch','item','STONE_BRICKS')>=99,true,'the stone-brick walls get the stone bricks before stand-ins do');
  assert.equal(total(steps,'craft','item','SPRUCE_PLANKS'),64,'16 spruce logs on hand make 64 planks');
  assert.ok(steps.some(s=>s.kind==='swap'&&s.from==='SPRUCE_PLANKS'&&familyOf(s.to)==='planks'&&s.count===17));
  assert.ok(steps.some(s=>s.kind==='swap'&&s.from==='STRIPPED_OAK_LOG'&&s.to==='OAK_LOG'));
  assert.equal(total(steps,'drop','item','FURNACE'),2);assert.equal(total(steps,'drop','item','ANVIL'),1);
  assert.equal(total(steps,'craft','item','CRAFTING_TABLE'),1,'a crafting table is made from planks');
  // Never takes more from the warehouse than it holds.
  const fetched={};for(const s of steps.filter(s=>s.kind==='fetch'))fetched[s.item]=(fetched[s.item]??0)+s.count;
  for(const [k,n] of Object.entries(fetched))assert.ok(n<=stock[k],`${k}: ${n} <= ${stock[k]}`);
});
test('planks are crafted from logs of the same wood before swapping; any logs make planks when none are stocked',()=>{
  assert.deepEqual(supplyPlan([['SPRUCE_PLANKS',40]],{stock:{SPRUCE_LOG:20,OAK_PLANKS:500}}),[{kind:'craft',item:'SPRUCE_PLANKS',count:40,from:'SPRUCE_LOG',logs:10}]);
  assert.deepEqual(supplyPlan([['SPRUCE_PLANKS',10]],{stock:{OAK_LOG:5}}),[{kind:'swap',from:'SPRUCE_PLANKS',to:'OAK_PLANKS',count:10},{kind:'craft',item:'OAK_PLANKS',count:10,from:'OAK_LOG',logs:3}]);
  assert.deepEqual(supplyPlan([['LANTERN',1]],{stock}),[{kind:'drop',item:'LANTERN',count:1}]);
});

test('the crafter knows how to make building materials, and what it must fell or leave to the miner',()=>{
  // 81 spruce planks with 3 spruce logs in stock: craft 21 times, fell 18 more spruce logs.
  const p=supplySteps('SPRUCE_PLANKS',81,{SPRUCE_LOG:3});
  assert.deepEqual(p.gather,{SPRUCE_LOG:18});assert.deepEqual(p.steps,[{how:'craft',item:'SPRUCE_PLANKS',times:21,inputs:{SPRUCE_LOG:21}}]);
  // Fences need planks and sticks, all from oak logs in stock.
  const f=supplySteps('OAK_FENCE',20,{OAK_LOG:10});
  assert.deepEqual(f.gather,{});assert.deepEqual(f.short,{});assert.equal(f.steps.at(-1).item,'OAK_FENCE');assert.ok(f.steps.some(s=>s.item==='STICK'));
  // Stone has to come from the miner.
  assert.deepEqual(supplySteps('COBBLESTONE',44,{}).short,{COBBLESTONE:44});
  assert.deepEqual(supplySteps('STONE_BRICKS',8,{COBBLESTONE:8}).steps.map(s=>s.item),['STONE','STONE_BRICKS']);
  assert.equal(recipeFor('DARK_OAK_STAIRS').inputs.DARK_OAK_PLANKS,6);
});
test('shortages: what a build queue needs beyond the warehouse and the builder\'s pockets (site clearing needs nothing)',()=>{
  const q=[...Array(5)].map(()=>({block:'SPRUCE_PLANKS'})).concat([{block:'CLEAR',clear:true},{block:'DIRT'},{block:'DIRT'}]);
  assert.deepEqual(shortages(q,{SPRUCE_PLANKS:1,DIRT:5},{SPRUCE_PLANKS:1}),[['SPRUCE_PLANKS',3]]);
});
