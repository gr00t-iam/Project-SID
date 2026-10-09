import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../agent-core/test-construction-pipeline.mjs';
import {describeBlocker,inspect,standingSpots,scaffoldColumn,deferBlock,requeueDue,phaseOf,createConstruction} from '../agent-core/construction.mjs';
import {nextBuildStep,recordPlacements} from '../agent-core/worker.mjs';
test('resuming a layer clears a consumed breakpoint instead of permanently yielding the build',async()=>{
 const p={name:'floor',queue:[{x:0,y:1,z:0,block:'COBBLESTONE'},{x:1,y:1,z:0,block:'COBBLESTONE'}],expected:[{x:0,y:1,z:0,block:'COBBLESTONE'},{x:1,y:1,z:0,block:'COBBLESTONE'}],total:2,placed:0,atBreak:true,placedSinceBreak:60},s={project:p};
 const controller=createConstruction({memory:{data:{town:{}}},nextBuildStep,recordPlacements,civic:()=>({economyReady:()=>true,batchFor:()=>1,award:()=>{}}),reach:10,placeAll:async(id,blocks)=>blocks.map(block=>({block,ok:true}))});
 await controller.step({id:'builder'},s,{x:0,y:1,z:0});assert.equal(p.atBreak,false);assert.equal(p.placedSinceBreak,1);assert.equal(p.queue.length,1);
});

test('terrain preparation blocks placement until a successful retry',async()=>{
 let placed=0,retries=0,time=10;
 const p={name:'coastal building',queue:[{x:0,y:1,z:0,block:'COBBLESTONE'}],expected:[{x:0,y:1,z:0,block:'COBBLESTONE'}],total:1,placed:0,terrainPending:true,terrainRetryAt:20,prepared:{unsupported:1}},s={project:p};
 const civic={prepareProject:async()=>{retries++;p.terrainPending=false;},economyReady:()=>true,batchFor:()=>1,award:()=>{}};
 const construction=createConstruction({memory:{data:{town:{}}},nextBuildStep,recordPlacements,now:()=>time,civic:()=>civic,reach:10,act:async()=>{},log:()=>{},ledger:()=>{},say:async()=>{},placeAll:async(id,blocks)=>{placed++;return blocks.map(block=>({block,ok:true}));}});
 assert.equal(await construction.step({id:'builder'},s,{x:0,y:1,z:0}), 'blocked');assert.equal(placed,0);assert.equal(retries,0);
 time=21;assert.equal(await construction.step({id:'builder'},s,{x:0,y:1,z:0}), 'placed');assert.equal(retries,1);assert.equal(placed,1);
});

test('renovation inspection requires clear interior and iron cell doors',()=>{
 const expected=[{x:0,y:0,z:0,block:'AIR'},{x:1,y:0,z:0,block:'IRON_DOOR'}];
 assert.equal(inspect(expected,[[1,0,0,'IRON_DOOR']]).pct,100);
 assert.equal(inspect(expected,[[0,0,0,'COBBLESTONE'],[1,0,0,'SPRUCE_DOOR']]).pct,0);
});
import {createReservations,requestPhase} from '../agent-core/reservations.mjs';
import {supplySteps,recipeFor} from '../agent-core/materials.mjs';
import {mealDecision} from '../agent-core/skills/needs.mjs';
import {traitsFor} from '../agent-core/skills/traits.mjs';
import {surveyNextSite,nextLevelHub} from '../agent-core/roles/miner.mjs';
import {destinationCheck} from '../agent-core/intel/executor.mjs';
import {newProject} from '../agent-core/worker.mjs';
import {blueprint} from '../agent-core/blueprints.mjs';

test('a house from short supplies to a 100% inspection, across a restart (agent-core/test-construction-pipeline.mjs)',async()=>{
  const r=await simulate();assert.deepEqual(r.failures,[]);
});
test('blocker sentences say what, who and when',()=>{
  const t=describeBlocker({kind:'materials',phase:'Roof',missing:{STONE_STAIRS:24},assigned:{courier:'courier',miner:'miner'},nextCheck:31000},{now:1000});
  assert.equal(t,'Roof paused: missing 24 stone stairs. Courier assigned. Miner needs a new excavation site. Next check in 30 seconds.');
  assert.match(describeBlocker({kind:'access',phase:'Roof',detail:'roof section 1:0 out of reach',nextCheck:301000},{now:1000}),/Next check in 5 minutes/);
  assert.match(describeBlocker({kind:'materials',phase:'Walls',missing:{COBBLESTONE:9},assigned:{miner:'miner',minerSite:'opening a new mine level'},nextCheck:1000},{now:1000,nameOf:()=>'Dorn'}),/Dorn is opening a new mine level/);
});
test('deferred blocks come back after their back-off; an empty queue is not done',()=>{
  const p=newProject('x',[{x:0,y:1,z:0,block:'A'}]);deferBlock(p,p.queue[0],'Space occupied',{now:0});
  assert.equal(p.queue.length,0);assert.equal(requeueDue(p,{now:10000}),0);assert.equal(requeueDue(p,{now:31000}),1);assert.equal(p.queue.length,1);
});
test('inspection compares every blueprint block with the world',()=>{
  const bp=[{x:0,y:1,z:0,block:'STONE'},{x:1,y:1,z:0,block:'RED_BED'},{x:2,y:1,z:0,block:'OAK_PLANKS'}];
  const r=inspect(bp,[[0,1,0,'STONE'],[1,1,0,'BLUE_BED'],[2,1,0,'DIRT']]);
  assert.equal(r.matched,2);assert.equal(r.wrong.length,1);assert.equal(r.pct,66);
});
test('standing spots and scaffold columns avoid the building itself and failed spots',()=>{
  const p={...newProject('h',blueprint({shape:'house',width:7,depth:7,height:4},0,65,0)),baseY:65};
  const roof=p.queue.reduce((a,b)=>b.y>a.y?b:a);
  const spots=standingSpots(roof,p,{reach:7,base:65});
  assert.ok(spots.every(s=>!p.expected.some(b=>b.x===Math.floor(s.x)&&b.z===Math.floor(s.z)&&(b.y===s.y||b.y===s.y+1))));
  // Nothing is built yet: no spot on the (unbuilt) roof.
  assert.ok(!spots.some(s=>s.onBuilding),'no spot on an unbuilt roof');
  // Built up to the ridge: no scaffold column fits (the lantern and the roof rings), so the builder stands on the roof.
  const built={...p,queue:[roof]};
  assert.ok(standingSpots(roof,built,{reach:7,base:65}).some(s=>s.onBuilding),'a spot on the roof for the ridge');
  const eave=p.queue.find(b=>b.y===70&&b.x===-1&&b.z===3);
  const col=scaffoldColumn(p,eave,{floor:66,ground:65});assert.ok(col&&col.beside,'a scaffold column for the eaves');
  const again=scaffoldColumn(p,eave,{floor:66,ground:65,tried:[col.key]});assert.notEqual(again?.key,col.key);
  assert.equal(phaseOf(p,roof.y),'Roof');
});
test('requesting a phase reserves stock, promises suppliers and never invents supply',()=>{
  const res=createReservations({});
  const r=requestPhase(res,{key:'b:h',builder:'b',project:'h',phase:'Walls',need:{COBBLESTONE:40,OAK_PLANKS:10,BOOKSHELF:2},stock:{OAK_PLANKS:6},have:{},roles:{crafter:'c',miner:'m',courier:'k'}},{supplySteps,recipeFor});
  assert.equal(r.reserved.OAK_PLANKS,6);assert.equal(r.missing.COBBLESTONE,40);assert.equal(r.unsupplied.BOOKSHELF,2);
  assert.equal(r.assigned.miner,'m');assert.equal(r.assigned.courier,'k');
  // another builder cannot take what is reserved; the builder (and its courier) can
  assert.equal(res.availableFor('other','OAK_PLANKS',{OAK_PLANKS:6}),0);assert.equal(res.availableFor('b','OAK_PLANKS',{OAK_PLANKS:6}),6);assert.equal(res.availableFor('k','OAK_PLANKS',{OAK_PLANKS:6}),6);
});
test('meals: mild hunger waits for a break, critical hunger does not',()=>{
  assert.equal(mealDecision({hunger:0.5},{owner:true,breakpoint:false,now:0}).eat,false);
  assert.equal(mealDecision({hunger:0.5},{owner:true,breakpoint:true,now:0}).eat,true);
  assert.equal(mealDecision({hunger:0.5},{owner:true,breakpoint:false,hungrySince:0,now:300000}).eat,true);
  assert.equal(mealDecision({hunger:0.8},{owner:true,breakpoint:false,now:0}).eat,true);
});
test('traits are stable and follow values and words',()=>{
  const a=traitsFor('bram',{craftsmanship:0.9,selfPreservation:0.8},'meticulous and cautious'),b=traitsFor('bram',{craftsmanship:0.9,selfPreservation:0.8},'meticulous and cautious');
  assert.deepEqual(a,b);assert.ok(a.craftsmanship>0.8);assert.ok(a.risk_tolerance<0.45);
});
test('the mine opens a new level (or a clay pit) instead of stopping',()=>{
  assert.deepEqual(nextLevelHub({x:240,y:47,z:112}),{x:228,y:35,z:112});
  assert.equal(surveyNextSite({hub:{x:240,y:47,z:112}},{orders:[{item:'CLAY_BALL'}]}).kind,'clay');
  assert.equal(surveyNextSite({hub:{x:240,y:47,z:112}},{orders:[{item:'COBBLESTONE'}]}).kind,'level');
});
test('destinations: the world border and height, not a fixed distance from town',()=>{
  const world={border:{x:0,z:0,size:60000000},minY:-64,maxY:320};
  assert.equal(destinationCheck({x:1500,z:-900},{x:272,z:96},world),null);
  assert.match(destinationCheck({x:40000000,z:0},{x:0,z:0},world),/world border/);
  assert.match(destinationCheck({x:0,y:400,z:0},{x:0,z:0},world),/height/);
  assert.match(destinationCheck({x:9000,z:0},{x:0,z:0},world),/one trip/);
});
