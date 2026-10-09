import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../agent-core/test-life-sim.mjs';
import {schedulePhase,decaySocialComfort,needsOf} from '../agent-core/skills/needs.mjs';
import {seedRumor,retell,distortionChance,pickToTell,learn} from '../agent-core/skills/gossip.mjs';
import {dwellingOf,accessOf,assignLots} from '../agent-core/skills/property.mjs';
import {relationshipOf} from '../agent-core/intel/social.mjs';
import {blueprint} from '../agent-core/blueprints.mjs';

test('a day in town (agent-core/test-life-sim.mjs)',async()=>{assert.deepEqual((await simulate()).failures,[]);});

test('schedule phases from the world clock',()=>{
  assert.deepEqual([0,1500,8999,9000,12999,13000,22999,23000].map(schedulePhase),['DAWN_PREP','WORK_SHIFT','WORK_SHIFT','DUSK_SOCIAL','DUSK_SOCIAL','NIGHT_REST','NIGHT_REST','DAWN_PREP']);
  assert.equal(schedulePhase('evening'),'DUSK_SOCIAL');
});
test('loneliness and comfort',()=>{
  const alone=decaySocialComfort({social:0.2,comfort:0.2},600,{company:0});
  const party=decaySocialComfort({social:0.8,comfort:0.5},300,{socializing:true});
  const storm=decaySocialComfort({social:0.2,comfort:0.2},300,{raining:true,sheltered:false});
  assert.ok(alone.social>0.4);assert.ok(party.social<0.1&&party.comfort<0.5);assert.ok(storm.comfort>0.4);
  assert.deepEqual(needsOf({hunger:10,energy:25,social:0.5,comfort:0.1}),{hunger:0.5,fatigue:0.75,socialization:0.5,comfort:0.1});
});
test('rumors: distortion follows bias, nobody hears a story twice',()=>{
  const r=seedRumor({id:'R-1',origin:'a',subject:'b',event_type:'theft',vars:{s:'Bo',n:3}});
  assert.equal(r.details,'Bo took 3 emeralds from the treasury');
  assert.ok(distortionChance({bias:0.8,tellerReliability:0.2})>distortionChance({bias:0,tellerReliability:0.9}));
  const twisted=retell(r,{teller:'c',bias:1,tellerReliability:0,random:()=>0});
  assert.equal(twisted.level,1);assert.match(twisted.details,/for weeks/);assert.ok(twisted.veracity<0.6);
  const faithful=retell(r,{teller:'c',random:()=>0.99});assert.equal(faithful.level,0);assert.equal(faithful.veracity,0.95);
  assert.equal(pickToTell([r],[twisted]),null);assert.equal(learn([r],twisted).length,1);
});
test('dwellings: bed and chest inside the house; access rules; nine new lots',()=>{
  const d=dwellingOf('x',{x:100,z:200,door:'east'});
  assert.deepEqual([d.bed_coordinates.x,d.bed_coordinates.z,d.private_chest_coordinates.x,d.private_chest_coordinates.z],[101,201,101,203]);
  const b=blueprint({shape:'house',width:5,depth:5,height:3,door:'east',bed:true,chest:true},100,64,200);
  assert.ok(b.some(q=>q.block==='CHEST'&&q.x===101&&q.z===203&&q.y===65));
  assert.equal(accessOf('a','a'),'own');assert.equal(accessOf('s','a',{role:'sheriff',warrantFor:['a']}),'search');assert.equal(accessOf('s','a',{role:'sheriff'}),'theft');
  const lots=assignLots({a:{x:294,z:107}},['a','b','c']);assert.deepEqual(Object.keys(lots),['b','c']);assert.notEqual(lots.b.z,107);
  assert.ok(blueprint({shape:'tavern'},0,64,0).length<600);
});
test('relationship view: -1..1 with fading grudges',()=>{
  const now=Date.parse('2026-10-02T00:00:00Z');
  const r=relationshipOf({trust_score:30},[{kind:'grudge',reason:'x',impact:-0.5,time:now}],now);
  assert.equal(r.trust,-0.4);assert.equal(r.grudges.length,1);assert.ok(r.affinity<-0.6);
  assert.ok(relationshipOf({trust_score:30},[{kind:'grudge',reason:'x',impact:-0.5,time:now-48*3600000}],now).affinity>r.affinity);
});
