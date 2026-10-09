import test from 'node:test';
import assert from 'node:assert/strict';
import {createMinds,reasonText} from '../agent-core/minds.mjs';

test('a thought: the brain lights up while thinking, the map is told, and the conclusion lands in the feed',async()=>{
  let t=1000;const sent=[];
  const minds=createMinds({act:async(id,a)=>{sent.push([id,a.target,a.text]);},names:id=>({builder:'Bram'})[id]??id,now:()=>t});
  minds.start('builder','addressed','plan');
  assert.equal(minds.thinking('builder'),true);
  assert.deepEqual(sent[0].slice(0,2),['builder','thinking']);assert.match(sent[0][2],/someone spoke to them/);
  t=4500;minds.end('builder',{reflection:'The wall is open',plan:'Repair it',action:{type:'chat',text:'On it!'}});
  const v=minds.view(['builder','farmer']);
  assert.equal(v.agents.builder.thinking,false);assert.equal(v.agents.builder.last.ms,3500);assert.equal(v.agents.builder.last.name,'Bram');
  assert.equal(v.feed[0].plan,'Repair it');assert.equal(v.agents.farmer.thinking,false);
  assert.deepEqual(sent[1].slice(0,2),['builder','idle']);assert.match(sent[1][2],/Plan: Repair it/);
});
test('a turn that dies without a thought still stops the brain, and leaves the feed alone',()=>{
  const minds=createMinds({});
  minds.start('scout','heartbeat');minds.stop('scout');
  assert.equal(minds.thinking('scout'),false);assert.equal(minds.view().feed.length,0);
});
test('reasons read like plain words',()=>{
  assert.equal(reasonText('phase:dawn'),'dawn');assert.equal(reasonText('encounter:jrmym1981'),'meeting jrmym1981');assert.equal(reasonText('heartbeat'),'a quiet moment to take stock');
});
