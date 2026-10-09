import test from 'node:test';
import assert from 'node:assert/strict';
import {priceFactor,marketPrices,payoutFor,scarceFood,growthRate,rollDrought,readiness,nearestShelter,wallColumns,openStages,councilVote,councilDue,
  emergencyPlan,questErrand,nextPatrolStop,toolNeeds,smithStep,brewNext,patientsOf,needsHerbs,MASTER_PLANS} from '../agent-core/plans.mjs';

test('prices rise when stock is short and fall when plentiful',()=>{
  assert.equal(priceFactor(100,100),1);
  assert.ok(priceFactor(50,100)>1.5&&priceFactor(50,100)<1.7);
  assert.equal(priceFactor(0,100),3);
  assert.equal(priceFactor(1000,100),0.5);
  const p=marketPrices({BREAD:40,COBBLESTONE:900});
  assert.ok(p.BREAD.value>3,'bread below 100 pays more');
  assert.ok(p.COBBLESTONE.factor<1);
  assert.ok(marketPrices({BREAD:40},{emergency:true}).BREAD.factor>p.BREAD.factor,'emergency raises food prices');
  assert.deepEqual(scarceFood(p).includes('BREAD'),true);
  assert.equal(payoutFor({BREAD:16},{BREAD:{value:4}}),1.6);
});
test('seasons and droughts slow the crops',()=>{
  assert.equal(growthRate('spring',false),100);
  assert.equal(growthRate('winter',false),35);
  assert.equal(growthRate('summer',true),30);
  assert.equal(rollDrought('summer',0.1,0.9),3);
  assert.equal(rollDrought('summer',0.5,0.1),0);
  assert.equal(rollDrought('winter',0,0),0);
});
test('raid readiness levels and shelters',()=>{
  assert.equal(readiness({hostilesNow:5}),'red');
  assert.equal(readiness({hostilesNow:1}),'yellow');
  assert.equal(readiness({recentThreat:true}),'yellow');
  assert.equal(readiness({}),'green');
  assert.equal(nearestShelter({x:0,z:0},[{id:'a',x:10,z:0},{id:'b',x:3,z:3}]).id,'b');
});
test('wall ring segments leave gates open and carry lanterns',()=>{
  const c={x:272.5,z:96.5};
  const north=wallColumns(c,45,[225,315]);
  assert.ok(north.length>50);
  assert.ok(north.every(p=>Math.abs(Math.hypot(p.x+0.5-c.x,p.z+0.5-c.z)-45)<1.5));
  assert.ok(!north.some(p=>Math.abs(p.x+0.5-c.x)<=1&&p.z<c.z),'north gate open');
  assert.ok(north.some(p=>p.lamp));
  const all=[[225,315],[-45,45],[45,135],[135,225]].flatMap(arc=>wallColumns(c,45,arc));   // (the wall plan is retired; the geometry stays)
  assert.ok(all.length>250&&all.length<360);
});
test('council: candidates, votes, due dates and emergencies',()=>{
  const open=openStages([]);
  assert.deepEqual(open.map(o=>o.stage),['walk_west','market_hall'],'no town walls on offer (the plan is retired)');
  const voters=[{id:'guardian',role:'guardian'},{id:'smith',role:'smith'},{id:'merchant',role:'merchant'}];
  const r=councilVote(voters,open,{threats:5},()=>0);
  assert.equal(r.winner.stage,"walk_west");assert.equal(r.tally.walk_west,2);
  assert.equal(councilVote(voters,open,{pantryStatus:'critical'},()=>0).votes.merchant,'market_hall');
  assert.ok(councilDue(8,1));assert.ok(!councilDue(5,1));
  assert.equal(emergencyPlan({pantryStatus:'healthy'}),null);
  assert.equal(emergencyPlan({pantryStatus:'critical'}).grant,4);
});
test('courier: quest runs and patrol order',()=>{
  const quests=[{id:'3',by:'builder',item:'COBBLESTONE',count:32,delivered:0,status:'open'}];
  const agents=[{id:'miner',role:'miner',inventory:{COBBLESTONE:80,IRON_PICKAXE:1}},{id:'builder',role:'builder',inventory:{}},{id:'courier',role:'courier',inventory:{COBBLESTONE:99}}];
  assert.deepEqual(questErrand(quests,agents,'courier'),{kind:'quest-collect',quest:'3',from:'miner',item:'COBBLESTONE',count:32,to:'builder'});
  assert.equal(questErrand([{...quests[0],item:'IRON_PICKAXE'}],agents,'courier'),null,'tools are never taken');
  const stops=[{id:'farm'},{id:'dock'},{id:'mine'}];
  assert.equal(nextPatrolStop(stops,'dock').id,'mine');assert.equal(nextPatrolStop(stops,'mine').id,'farm');assert.equal(nextPatrolStop(stops,undefined).id,'farm');
});
test('smith: finds missing and worn tools and plans the work',()=>{
  const agents=[{id:'farmer',role:'farmer',inventory:{}},{id:'miner',role:'miner',inventory:{IRON_PICKAXE:1,IRON_SHOVEL:1,IRON_AXE:1},wear:{IRON_PICKAXE:20,IRON_SHOVEL:200,IRON_AXE:200}},
    {id:'guardian',role:'guardian',inventory:{IRON_SWORD:1},wear:{IRON_SWORD:240}}];
  const needs=toolNeeds(agents);
  assert.deepEqual(needs.map(n=>`${n.agent}:${n.kind}:${n.reason}`),['farmer:HOE:missing','miner:PICKAXE:worn']);
  assert.deepEqual(smithStep({IRON_PICKAXE:1},'PICKAXE'),{step:'give',item:'IRON_PICKAXE'});
  assert.deepEqual(smithStep({IRON_INGOT:3,STICK:2},'PICKAXE'),{step:'craft',item:'IRON_PICKAXE',count:1});
  assert.deepEqual(smithStep({RAW_IRON:3,STICK:2},'PICKAXE'),{step:'smelt',item:'RAW_IRON',count:3});
  assert.deepEqual(smithStep({IRON_INGOT:3,OAK_PLANKS:4},'PICKAXE'),{step:'craft',item:'STICK',count:1});
  assert.deepEqual(smithStep({COBBLESTONE:5,STICK:4},'SWORD'),{step:'craft',item:'STONE_SWORD',count:1});
  assert.equal(smithStep({},'HOE').step,'need');
});
test('herbalist: what to brew and who to treat',()=>{
  assert.equal(brewNext({POPPY:2,SWEET_BERRIES:4},{}),'HEALING');
  assert.equal(brewNext({POPPY:2,SUGAR_CANE:2},{}),'SWIFTNESS');
  assert.equal(brewNext({POPPY:2,SWEET_BERRIES:4},{HEALING:4,SPLASH_HEALING:2}),null);
  assert.equal(brewNext({},{}),null);
  assert.deepEqual(patientsOf([{id:'a',health:20},{id:'b',health:6},{id:'c',health:11}]).map(a=>a.id),['b','c']);
  assert.ok(needsHerbs({}));assert.ok(!needsHerbs({POPPY:6,APPLE:6,SUGAR:2}));
});
