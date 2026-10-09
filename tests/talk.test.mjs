import test from 'node:test';
import assert from 'node:assert/strict';
import {similarity,addMemory,overusedPhrases,openerOf,pickTopic,recall,newTalk} from '../agent-core/talk.mjs';

test('stock phrases are spotted across lines',()=>{
  const lines=['Morning! Clear winter air, perfect for a run.','Clear winter air, good day to check the pantry.','Clear winter sky, perfect for noting visitors.',
    'Heard Finley found a fishing spot at 278,82 by the lake?','Finley found a good spot at 278,82 by the lake.','Did you hear Finley found a spot at 278,82 by the lake?',
    'I will have wheat ready at first light.','Bring seed at first light.','Wheat by first light, I promise.'];
  const p=overusedPhrases(lines);
  assert.ok(p.some(x=>x.includes('clear winter')),'clear winter');
  assert.ok(p.some(x=>x.includes('278 82')),'the fishing spot');
  assert.ok(p.includes('first light'));
  assert.ok(!p.some(x=>/^(the|a) \w+ (the|a)$/.test(x)),'no filler-only phrases');
});
test('memories do not pile up duplicates',()=>{
  let m=[];
  m=addMemory(m,{text:'Finley found a fishing spot by the lake',from:'courier'});
  m=addMemory(m,{text:'finley found a good fishing spot by the lake',from:'merchant'});
  assert.equal(m.length,1);assert.equal(m[0].from,'merchant');
  m=addMemory(m,{text:'The smith wants more iron for the forge'});
  assert.equal(m.length,2);
  for(let i=0;i<30;i++)m=addMemory(m,{text:`fact number ${i} about item${i}`},20);
  assert.equal(m.length,20);
  assert.ok(similarity('The wheat is thin this winter','Wheat looks thin in winter')>=0.6);
});
test('topics avoid what was just discussed and prefer open threads',()=>{
  const a={id:'smith',role:'smith'},b={id:'miner',role:'miner'};
  assert.equal(pickTopic({a,b,pair:{followUp:'whether the new pickaxe holds up'},rand:()=>0}),'follow up on: whether the new pickaxe holds up');
  const recentTopics=['the forge and good steel','something strange found underground'];
  for(let i=0;i<50;i++){const t=pickTopic({a,b,recentTopics,rand:Math.random});assert.ok(!recentTopics.includes(t),t);}
  // Gossip already discussed twice around town is not picked again.
  for(let i=0;i<50;i++)assert.ok(!pickTopic({a,b,news:['Finley found a spot'],newsUse:{'Finley found a spot':2}}).includes('Finley'));
});
test('recall gives each speaker their own history',()=>{
  const t=newTalk();
  t.said=['one','two'];t.learned=[{text:'the lake freezes in winter',from:'fisher'}];
  t.pairs.miner={notes:[{text:'argued about coal'}],followUp:'the coal debt'};
  const r=recall(t,'miner');
  assert.deepEqual(r.pastTalks,['argued about coal']);assert.equal(r.openThread,'the coal debt');
  assert.deepEqual(r.learnedRecently,['the lake freezes in winter (from fisher)']);
  assert.deepEqual(recall(t,'scout').pastTalks,[]);
  assert.equal(openerOf('Morning Marlo! Clear winter air'),'morning marlo clear');
});
