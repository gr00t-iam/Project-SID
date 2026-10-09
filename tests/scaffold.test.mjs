import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,nextBuildStep,recordPlacements} from '../agent-core/worker.mjs';

test('a roof layer out of reach from the floor and the ground asks for scaffolding',()=>{
  // An 11x9 hall: floor at y 70, roof peak at y 82 - far above anyone standing on the floor.
  const blocks=[];for(let x=0;x<11;x++)for(let z=0;z<9;z++)blocks.push({x,y:82,z,block:'BRICKS'});
  const p=newProject('hall',blocks);p.baseY=70;
  const st=nextBuildStep(p,{x:5.5,y:71,z:4.5},7);
  assert.equal(st.kind,'unreachable');assert.equal(st.layer,82);
  // A low roof is just walked to.
  const low=newProject('house',[{x:2,y:74,z:2,block:'BRICKS'}]);low.baseY=70;
  assert.notEqual(nextBuildStep(low,{x:20,y:71,z:20},7).kind,'unreachable');
});
test('a block a little out of reach is kept (step closer), not skipped',()=>{
  const b={x:1,y:75,z:1,block:'BRICKS'},p=newProject('house',[b]);
  recordPlacements(p,[{block:p.queue[0],ok:false,error:'Target outside allowed range'}]);
  assert.equal(p.queue.length,1);assert.equal(p.skipped,0);assert.equal(p.closer,true);
  for(let i=0;i<12;i++)recordPlacements(p,[{block:p.queue[0],ok:false,error:'Target outside allowed range'}]);
  // After many tries it is deferred with its reason (an access task), never skipped.
  assert.equal(p.skipped,0);assert.equal(p.queue.length,0);assert.equal(p.deferred.length,1);assert.equal(p.deferred[0].kind,'access');
});
