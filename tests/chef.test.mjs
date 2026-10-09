import test from 'node:test';
import assert from 'node:assert/strict';
import {STATES,RecipeKnowledgeGraph,startingGraph,recipesInText,foodsMentioned,experiment,dietStats,planMenu,nextState,masteryIndex,fuelIn} from '../agent-core/cuisine.mjs';
import {simulate,REGISTRY} from '../scripts/simulate-chef.mjs';

test('the recipe graph: links ingredients to dishes, ignores duplicates, plans intermediates (sugar before pie)',()=>{
  const g=startingGraph(REGISTRY);
  assert.ok(g.recipesFor('BREAD').length&&g.recipesFor('BAKED_POTATO').length,'baseline dishes known from day one');
  assert.equal(g.add(REGISTRY.find(r=>r.result==='PUMPKIN_PIE'),'book'),true);
  assert.equal(g.add(REGISTRY.find(r=>r.result==='PUMPKIN_PIE'),'book'),false,'known already');
  g.add(REGISTRY.find(r=>r.result==='SUGAR'),'book');
  assert.deepEqual(g.usesOf('EGG').map(r=>r.result),['PUMPKIN_PIE']);
  const p=g.plan('PUMPKIN_PIE',4,{PUMPKIN:4,EGG:4,SUGAR_CANE:4});
  assert.deepEqual(p.missing,{});assert.deepEqual(p.steps.map(s=>[s.recipe.result,s.times]),[['SUGAR',4],['PUMPKIN_PIE',4]]);
  assert.deepEqual(g.plan('PUMPKIN_PIE',4,{PUMPKIN:4}).missing,{SUGAR:4,EGG:4});
  // Any item name works - a mod's food is just another node.
  assert.equal(g.add({result:'MODDED_RAMEN',heat:'campfire',inputs:{NOODLES:1,BROTH:1},nutrition:9},'talk'),true);
  assert.equal(RecipeKnowledgeGraph.fromJSON(g.toJSON()).size,g.size,'survives saving');
});
test('learning: books, conversation and experiments find recipes in the world registry',()=>{
  const g=startingGraph(REGISTRY);
  assert.deepEqual(recipesInText('My grandmother made pumpkin pie every autumn.',REGISTRY,g).map(r=>r.result),['PUMPKIN_PIE']);
  // The restorative broths (and their bowls) are baseline knowledge now: nothing new to learn from that line.
  assert.deepEqual(recipesInText('Brown mushroom, red mushroom and a bowl - simple.',REGISTRY,g).map(r=>r.result),[]);
  assert.ok(g.recipesFor('MUSHROOM_STEW').length&&g.recipesFor('BOWL').length,'he knows the broth and its bowl from day one');
  assert.ok(foodsMentioned('Found cocoa beans down by the jungle river!',REGISTRY).includes('COCOA_BEANS'));
  assert.equal(experiment(REGISTRY,g,{WHEAT:4,COCOA_BEANS:2},()=>0).recipe.result,'COOKIE','a new dish from what is at hand');
  assert.ok(experiment(REGISTRY,g,{BEEF:1},()=>0).tried,'nothing new to discover');
});
test('the town diet: variety score, monotony and food fatigue',()=>{
  const bread=[...Array(12)].map((_,i)=>({agent:['a','b'][i%2],food:'BREAD'}));
  const d=dietStats(bread);assert.equal(d.score,0);assert.equal(d.top[0].share,100);assert.equal(d.fatigued.length,2);
  const mixed=['BREAD','BAKED_POTATO','PUMPKIN_PIE','COOKED_COD','MUSHROOM_STEW','COOKIE'].flatMap(f=>[{agent:'a',food:f},{agent:'b',food:f}]);
  assert.ok(dietStats(mixed).score>90);assert.equal(dietStats(mixed).fatigued.length,0);
});
test('menus: real meals only, novelty and cravings first; a crop failure falls back to simple dishes and asks the farmers',()=>{
  const g=startingGraph(REGISTRY);for(const r of REGISTRY)g.add(r,'book');
  const pool={WHEAT:30,POTATO:20,PUMPKIN:14,SUGAR_CANE:20,EGG:16,BROWN_MUSHROOM:12,RED_MUSHROOM:12,OAK_PLANKS:12,COAL:4};
  const meals=[...Array(12)].map((_,i)=>({agent:'a'+(i%3),food:'BREAD'}));
  const m=planMenu({graph:g,pool,meals,requests:[{food:'MUSHROOM_STEW'}]});
  assert.ok(!m.menu.some(x=>['SUGAR','BOWL'].includes(x.dish)),'sugar and bowls are never served');
  assert.equal(m.menu[0].dish,'MUSHROOM_STEW','the craving wins');assert.ok(!m.menu.some(x=>x.dish==='BREAD'),'not more bread');
  const failed=planMenu({graph:g,pool:{POTATO:20,COAL:3},meals});
  assert.deepEqual(failed.menu.map(x=>x.dish),['BAKED_POTATO']);assert.ok(failed.fallback);assert.ok(failed.shortages.length);
  const cold=planMenu({graph:g,pool:{POTATO:20,WHEAT:30},meals:[]});
  assert.deepEqual(cold.menu.map(x=>x.dish),['BREAD'],'no fuel: only dishes that need no fire');assert.equal(fuelIn({OAK_LOG:3}),'OAK_LOG');
});
test('states: an interrupted batch first, then serving, then the routine',()=>{
  const t=1e6;
  assert.equal(nextState({now:t}),STATES.INSPECT_INVENTORY);
  assert.equal(nextState({now:t,inspectedAt:t}),STATES.LEARN_RECIPES);
  assert.equal(nextState({now:t,inspectedAt:t,learnedAt:t}),STATES.PLAN_MENU);
  assert.equal(nextState({now:t,inspectedAt:t,learnedAt:t,menu:[{dish:'BREAD',done:false}],needs:{WHEAT:3}}),STATES.FETCH_INGREDIENTS);
  assert.equal(nextState({now:t,inspectedAt:t,learnedAt:t,menu:[{dish:'BREAD',done:false}],needs:{}}),STATES.COOK_MEAL);
  assert.equal(nextState({now:t,batch:{dish:'BREAD'},carrying:1}),STATES.COOK_MEAL);
  assert.equal(nextState({now:t,carrying:1}),STATES.SERVE_CITIZENS);
  assert.ok(masteryIndex({known:16,dishesCooked:3,batches:4,variety:50})>masteryIndex({known:8}));
});
test('a full cycle: inspect -> discover a recipe -> fetch -> cook (interrupted and resumed) -> serve and store',async()=>{
  const r=await simulate();
  for(const s of ['INSPECT_INVENTORY','LEARN_RECIPES','PLAN_MENU','FETCH_INGREDIENTS','COOK_MEAL','SERVE_CITIZENS'])assert.ok(r.states.includes(s),s);
  assert.ok(r.events.some(e=>e.type==='recipe_learned'&&e.dish==='PUMPKIN_PIE'&&/book/.test(e.how)),'learned pumpkin pie from the book');
  assert.ok(r.events.some(e=>e.type==='batch_resumed'),'the interrupted batch was resumed');
  assert.equal(r.state.cooked.PUMPKIN_PIE,12);assert.ok(r.farmer.inventory.PUMPKIN_PIE>=2,'the hungry farmer got pie');
  assert.ok(r.stock.PUMPKIN_PIE>=8,'the rest is in the food store');
  assert.ok(r.said.some(t=>/Bon appétit|specialty|kitchen presents|menu/i.test(t)),'the menu was announced');
  assert.ok(r.state.mastery>0);
});
test('a new dish becomes food the town eats; deposits skip a full chest',async()=>{
  const {registerFood,FOOD_POINTS,EDIBLE_FOODS,edibleIn,chooseChest}=await import('../agent-core/town.mjs');
  assert.equal(registerFood('RABBIT_STEW',10),true);assert.equal(FOOD_POINTS.RABBIT_STEW,10);
  assert.equal(EDIBLE_FOODS[0],'RABBIT_STEW','most filling first');assert.equal(edibleIn({RABBIT_STEW:1,BREAD:2}),'RABBIT_STEW');
  assert.equal(registerFood('BREAD',9),false,'known foods keep their value');
  const chests=[{name:'Food Storage',free:0,items:{BREAD:3456}},{name:'chest',free:6,items:{}}];
  assert.equal(chooseChest(chests,'BREAD','deposit').free,6);
});
test('experiments: a pair that does not combine is remembered and never tried again',()=>{
  const g=startingGraph(REGISTRY);for(const r of REGISTRY)g.add(r,'book');   // nothing left to discover from these
  const first=experiment(REGISTRY,g,{WHEAT:4,EGG:4},()=>0,[]);
  assert.deepEqual(first.tried.sort(),['EGG','WHEAT']);
  const again=experiment(REGISTRY,g,{WHEAT:4,EGG:4},()=>0,[first.pair]);
  assert.equal(again.tried.length,0);assert.ok(again.exhausted,'every pair at hand has failed: nothing to try');
});
test('a worn-out town gets the restorative broth first',()=>{
  const g=startingGraph(REGISTRY);
  const pool={BROWN_MUSHROOM:8,RED_MUSHROOM:8,OAK_PLANKS:12,POTATO:20,COAL:4,WHEAT:30};
  assert.equal(planMenu({graph:g,pool,meals:[],restorative:true}).menu[0].dish,'MUSHROOM_STEW');
});
