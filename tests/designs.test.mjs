import test from 'node:test';
import assert from 'node:assert/strict';
import {designOptions,voteDesign,STYLES} from '../agent-core/designs.mjs';

test('design options: three styles sized from the blueprint, limited to allowed materials',()=>{
  const all=designOptions('hall');
  assert.deepEqual(all.map(o=>o.id),['grand','practical','cozy']);
  assert.deepEqual(all.map(o=>[o.spec.width,o.spec.depth]),[[13,11],[11,9],[9,7]]);
  assert.equal(designOptions('tower')[0].spec.width,undefined,'towers keep their size');
  assert.deepEqual(designOptions('hall',['COBBLESTONE','OAK_LOG','SPRUCE_PLANKS','OAK_PLANKS']).map(o=>o.id),['practical'],'only what may be placed');
});
test('the vote follows the citizens values; ties go to the builder',()=>{
  const opts=designOptions('library'),none=()=>0.5;
  const traditional={tradition:0.95,community:0.9,craftsmanship:0.9,selfPreservation:0.2,sociability:0.2,curiosity:0.2};
  const social={sociability:0.95,curiosity:0.9,community:0.6,tradition:0.1,craftsmanship:0.2,selfPreservation:0.2};
  const r=voteDesign(opts,[{id:'a',values:traditional},{id:'b',values:traditional},{id:'c',values:social}],{random:none});
  assert.equal(r.winner.id,'grand');assert.deepEqual(r.tally,{grand:2,practical:0,cozy:1});assert.equal(r.ballots.c,'cozy');
  const tie=voteDesign(opts,[{id:'a',values:traditional},{id:'bram',values:social}],{random:none,builder:'bram'});
  assert.equal(tie.winner.id,'cozy','the builder breaks a tie');
  assert.ok(Object.values(STYLES).every(s=>typeof s.appeal({tradition:1,community:1,craftsmanship:1,selfPreservation:1,sociability:1,curiosity:1})==='number'));
});
