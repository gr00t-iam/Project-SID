import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../agent-core/intel/db.mjs';
import {createSocial,baselineTrust,DRIFT_HALF_LIFE_MS} from '../agent-core/intel/social.mjs';

test('trust drifts back toward a baseline over time: grudges fade, unkept friendships cool',()=>{
  const t={now:1_000_000},db=openDatabase(':memory:'),social=createSocial(db,{now:()=>t.now});
  social.adjust('a','b',{trust:-45},'argument');social.adjust('b','a',{trust:+40},'food_shared');
  social.drift(DRIFT_HALF_LIFE_MS,()=>60);
  assert.equal(Math.round(social.view('a','b').trust_score),33,'5 -> halfway to 60');
  assert.equal(Math.round(social.view('b','a').trust_score),75,'90 -> halfway to 60');
  assert.equal(social.events().length,2,'drift is time passing, not events');
});
test('baseline trust: warmer between familiar neighbours and for community-minded citizens',()=>{
  assert.ok(baselineTrust({familiarity:80})>baselineTrust({familiarity:0}));
  assert.ok(baselineTrust({community:0.9})>baselineTrust({community:0.2}));
  assert.ok(baselineTrust({familiarity:100,community:1})<=75&&baselineTrust({community:0})>=40);
});
test('rebuild from the event log skips polluted events and replays the real history',()=>{
  const t={now:1_000_000},db=openDatabase(':memory:'),social=createSocial(db,{now:()=>t.now});
  for(let i=0;i<300;i++)social.adjustPair('a','b',{trust:-0.2},'friction');   // the bug: a flood of tiny penalties
  social.adjustPair('a','b',{trust:2},'conversation');social.apply('b','a','food_shared','bread');
  assert.ok(social.view('a','b').trust_score<5);
  social.rebuild(e=>e.kind==='friction',()=>55);
  assert.equal(Math.round(social.view('a','b').trust_score),52,'50 + conversation');
  assert.deepEqual([Math.round(social.view('b','a').trust_score),Math.round(social.view('b','a').reliability_score)],[57,60],'50 + 2 + food shared (+5 trust, +10 reliability)');
  assert.equal(social.view('a','b').affinity_label,'NEUTRAL');
});
