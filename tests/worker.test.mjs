import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,nextBuildStep,recordPlacements,guardianStep} from '../agent-core/worker.mjs';
import {blueprint} from '../agent-core/blueprints.mjs';
test('roof work keeps the original floor height after lower layers leave the queue',()=>{
 const p=newProject('hall',[{x:0,y:70,z:0,block:'OAK_PLANKS'},{x:0,y:76,z:0,block:'SMOOTH_STONE'}]);p.queue.shift();
 const move=nextBuildStep(p,{x:20,y:66,z:0},7);
 assert.equal(p.baseY,70);assert.ok(move.kind==='unreachable'||move.y===70||move.y===71);assert.notEqual(move.y,76);
});

test('build steps place the lowest layer within reach, then walk to the rest',()=>{
  const p=newProject('floor',blueprint({shape:'floor',width:15,depth:3},0,64,0));
  const self={x:1,y:64,z:1};
  const step=nextBuildStep(p,self,8);
  assert.equal(step.kind,'place');
  assert.ok(step.blocks.every(b=>b.y===64&&b.x<=9));
  recordPlacements(p,p.queue.filter(b=>b.x<=8).map(block=>({block,ok:true})));
  const move=nextBuildStep(p,self,8);
  assert.equal(move.kind,'move');
  assert.equal(nextBuildStep(p,{x:move.x,y:64,z:move.z},8,100).blocks.length,p.queue.length,'rest of the floor reachable after the move');
});
test('clearing a canopy over the site stands underneath it instead of asking for scaffolding',()=>{
  const p={...newProject('lib',[{x:0,y:72,z:0,block:'CLEAR',clear:true},{x:0,y:65,z:0,block:'STONE'}]),baseY:65};
  const st=nextBuildStep(p,{x:20,y:66,z:20},7);
  assert.equal(st.kind,'move');assert.deepEqual([st.x,st.z],[0.5,0.5]);
  assert.equal(nextBuildStep(p,{x:0.5,y:65,z:0.5},7).kind,'place');
  assert.equal(nextBuildStep({...p,queue:[{x:0,y:73,z:0,block:'CLEAR',clear:true}]},{x:0.5,y:65,z:0.5},7).kind,'place','eight blocks up, from the ground');
});
test('placement results retry transient errors, defer hard ones (never skip) and detect stalls',()=>{
  const p=newProject('x',[{x:0,y:1,z:0,block:'A'},{x:1,y:1,z:0,block:'A'},{x:2,y:1,z:0,block:'A'}]);
  const [a,b,c]=p.queue;
  recordPlacements(p,[{block:a,ok:true},{block:b,ok:false,error:'Someone is standing there'},{block:c,ok:false,error:'Space occupied'}]);
  assert.equal(p.placed,1);assert.equal(p.skipped,0);assert.deepEqual(p.queue,[b]);assert.equal(p.stalls,0);
  assert.equal(p.deferred.length,1);assert.equal(p.deferred[0].kind,'obstructed');assert.match(p.deferred[0].reason,/occupied/);
  for(let i=0;i<5;i++)recordPlacements(p,[{block:b,ok:false,error:'Someone is standing there'}]);
  assert.equal(p.queue.length,0,'set aside after repeated retries');assert.equal(p.skipped,0);assert.equal(p.deferred.length,2);
  // An empty queue is not a finished building: the deferred blocks remain to be retried and inspected.
  assert.equal(nextBuildStep(p,{x:0,y:0,z:0},8).kind,'done');assert.ok(p.deferred.every(x=>x.nextAt>0));
});
test('guardian attacks nearby hostiles, chases distant ones, ignores animals and follows the player',()=>{
  const player={x:10,y:64,z:10};
  const base={x:9,y:64,z:9,entities:[]};
  assert.equal(guardianStep({...base,entities:[{uuid:'z',type:'ZOMBIE',x:10,y:64,z:9}]},player).kind,'attack');
  const chase=guardianStep({...base,entities:[{uuid:'s',type:'SKELETON',x:18,y:64,z:14}]},player);
  assert.equal(chase.kind,'chase');assert.equal(chase.target.uuid,'s');
  assert.equal(guardianStep({...base,entities:[{uuid:'c',type:'COW',x:9,y:64,z:10}]},player),null);
  assert.equal(guardianStep({...base,x:30,z:30},player).kind,'follow');
  assert.equal(guardianStep({...base,entities:[{uuid:'p',type:'PLAYER',x:9,y:64,z:10}]},player),null);
});
import {newDig,nextDigStep,recordDig} from '../agent-core/worker.mjs';
import {digPlan} from '../agent-core/blueprints.mjs';
test('dig executor mines column by column, walks down the stairs and stops at lava',()=>{
  const d=newDig('stairs',digPlan({shape:'stairs',direction:'east',length:12},0,68,0),{x:0.5,y:68,z:0.5});
  let self={x:0.5,y:68,z:0.5};
  const first=nextDigStep(d,self,8);
  assert.equal(first.kind,'mine');assert.deepEqual(first.blocks.map(b=>b.y),[69,68,67],'headroom, head, then the new foot level');
  for(let i=0;i<12&&nextDigStep(d,self,8).kind==='mine';i++){
    const step=nextDigStep(d,self,8);recordDig(d,step.blocks.map(block=>({block,ok:true,result:{drops:{COBBLESTONE:1}}})));
  }
  const move=nextDigStep(d,self,8);
  assert.equal(move.kind,'move','deeper steps are out of reach from the top');
  assert.ok(move.y<68);
  self={x:move.x,y:move.y,z:move.z};
  const next=nextDigStep(d,self,8);assert.equal(next.kind,'mine');
  assert.match(recordDig(d,[{block:next.blocks[0],ok:false,error:'Lava behind this block; leave it'}]).stop,/Lava/);
  assert.ok(d.drops.COBBLESTONE>0);
});
import {idleStep} from '../agent-core/worker.mjs';
test('idle reflex separates stacked agents at once and wanders near the post when idle',()=>{
  const self={x:10.5,y:64,z:10.5,pathing:false};
  const apart=idleStep(self,[{x:10.6,z:10.4}],{since:Date.now(),random:()=>0});
  assert.equal(apart.kind,'separate');assert.ok(Math.hypot(apart.x-self.x,apart.z-self.z)>=3);
  assert.equal(idleStep(self,[{x:20,z:20}],{since:Date.now()}),null,'recently active and not crowded');
  const stroll=idleStep(self,[],{since:0,post:{x:50,z:50},random:()=>0.5});
  assert.equal(stroll.kind,'wander');assert.ok(Math.hypot(stroll.x-50,stroll.z-50)<=6.5,'stays near its post');
  assert.equal(idleStep({...self,pathing:true},[{x:10.5,z:10.5}],{since:0}),null,'never interrupts walking');
});
import {isNight,mentionedAgents,parseCommand,frontOf,patrolStep} from '../agent-core/worker.mjs';
test('night detection, chat addressing and /sid parsing',()=>{
  assert.equal(isNight(6000),false);assert.equal(isNight(14000),true);assert.equal(isNight(24000+18000),true);assert.equal(isNight(undefined),false);
  const ids=['scout','builder','guardian'];
  assert.deepEqual(mentionedAgents('Hey builder, can you help?',ids),['builder']);
  assert.deepEqual(mentionedAgents('@scout and Guardian: over here',ids),['scout','guardian']);
  assert.deepEqual(mentionedAgents('good morning everyone',ids),ids);
  assert.deepEqual(mentionedAgents('the scouting party',ids),[],'no partial-word matches');
  assert.deepEqual(parseCommand(['come','all'],ids),{kind:'come',targets:ids});
  assert.match(parseCommand(['follow','all'],ids).error,/one bot/);
  assert.match(parseCommand(['stay','bob'],ids).error,/Name a bot/);
  assert.deepEqual(parseCommand(['build','house','9','stone_bricks'],ids),{kind:'build',shape:'house',size:9,material:'STONE_BRICKS'});
  assert.equal(parseCommand(['build','house'],ids).size,7);
  assert.match(parseCommand(['build','castle'],ids).error,/Build one of/);
});
test('builds land in front of the player with the door facing them; patrol loops waypoints',()=>{
  const south=frontOf({x:0.5,z:0.5,yaw:0},7);
  assert.equal(south.facing,'south');assert.equal(south.door,'north');assert.deepEqual([south.x,south.z],[-3,2]);
  const east=frontOf({x:10,z:10,yaw:-90},5);
  assert.equal(east.facing,'east');assert.equal(east.door,'west');assert.ok(east.x>10);
  const route=[{x:0,z:0},{x:20,z:0}],state={};
  assert.deepEqual(patrolStep({x:10,z:10},route,state),{kind:'patrol',x:0,z:0});
  assert.deepEqual(patrolStep({x:0.5,z:0.5},route,state),{kind:'patrol',x:20,z:0});
});
test('running out of a material pauses the project instead of skipping blocks; vote and veto commands parse',()=>{
  const p=newProject('x',[{x:0,y:1,z:0,block:'OAK_PLANKS'}]);
  recordPlacements(p,[{block:p.queue[0],ok:false,error:'Out of OAK_PLANKS; fetch more from the warehouse'}]);
  assert.equal(p.queue.length,1);assert.equal(p.skipped,0);assert.equal(p.waiting,true);assert.equal(p.stalls,0);
  const ids=['governor'];
  assert.deepEqual(parseCommand(['vote','#3','yes'],ids),{kind:'vote',id:'3',vote:'yes'});
  assert.deepEqual(parseCommand(['veto','4'],ids),{kind:'vote',id:'4',vote:'no',veto:true});
  assert.match(parseCommand(['vote','x'],ids).error,/Usage/);
  assert.deepEqual(parseCommand(['quests'],ids),{kind:'quests'});
});
test('builder stands inside the building when that reaches more of the next layer (roof peaks)',()=>{
  const blocks=blueprint({shape:'warehouse'},0,70,0);
  const roof=newProject('warehouse',blocks.filter(b=>b.y>=75));
  roof.baseY=70;
  const step=nextBuildStep(roof,{x:-20,y:70,z:-20},10);
  assert.equal(step.kind,'move');
  const next=nextBuildStep(roof,{x:step.x,y:step.y,z:step.z},10,100);
  assert.equal(next.kind,'place','from the chosen spot the layer is in reach');
});
test('agents answer to their given names and /sid accepts them',()=>{
  const ids=['scout','builder'],aliases={wren:'scout',bram:'builder'};
  assert.deepEqual(mentionedAgents('Hi Wren, how are you?',ids,aliases),['scout']);
  assert.deepEqual(parseCommand(['come','bram'],ids,aliases),{kind:'come',targets:['builder']});
  assert.deepEqual(parseCommand(['endorse','wren'],ids,aliases),{kind:'endorse',target:'scout'});
});
