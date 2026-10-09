import test from 'node:test';
import assert from 'node:assert/strict';
import {FAITHS,seedProfile,conversionChance,sermon,persuade,chooseHobby,practice,fade,census} from '../agent-core/faith.mjs';

const H=FAITHS.hearthlight,priest={charisma:0.8,religion:{devotion:0.95}};
const person=(skepticism,{faith=null,devotion=0,values=['community','sociability','curiosity'],tradition=0.4}={})=>
  ({religion:{deity_or_faith:faith,devotion,skepticism,converted_at:null},culture:{heritage:'townsfolk',core_values:values,tradition_adherence:tradition},hobbies:[]});

test('conversion chance: skepticism, another faith and tradition resist; charisma, matching values, unhappiness and trust pull',()=>{
  const open=conversionChance(priest,person(0.1),H),doubter=conversionChance(priest,person(0.8),H);
  assert.ok(open>doubter,`${open} > ${doubter}`);
  assert.ok(conversionChance(priest,person(0.3),H,{morale:20})>conversionChance(priest,person(0.3),H,{morale:90}),'discontent is more open');
  assert.ok(conversionChance(priest,person(0.3,{faith:'the Old Ways',devotion:0.8,tradition:0.9}),H)<conversionChance(priest,person(0.3),H),'devotion elsewhere resists');
  assert.ok(conversionChance(priest,person(0.3),H,{trust:90,believers:0.8})>conversionChance(priest,person(0.3),H,{trust:20}));
  assert.ok(conversionChance(priest,person(0.3,{values:['curiosity','craftsmanship','selfPreservation']}),H)<conversionChance(priest,person(0.3),H),'matching values help');
  assert.equal(conversionChance(priest,person(0.3,{faith:H.name}),H),0,'already a believer');
});
test('a sermon to a room of five: each citizen decides independently (some convert, some resist, believers grow devout)',()=>{
  const room=[0.05,0.2,0.45,0.7,0.95].map((sk,i)=>({id:`c${i}`,profile:person(sk),morale:50,trust:60,believers:0.2}));
  room.push({id:'b',profile:person(0.2,{faith:H.name,devotion:0.5}),morale:60,trust:70,believers:0.2});
  // Deterministic draw: each citizen's own roll (0.15) against its own chance.
  const out=sermon(priest,room,H,{random:()=>0.15,now:123});
  const by=Object.fromEntries(out.map(r=>[r.id,r]));
  assert.equal(by.c0.outcome,'converted');assert.equal(by.c4.outcome,'unmoved');
  assert.ok(out.filter(r=>r.outcome==='converted').length>=1&&out.filter(r=>r.outcome==='unmoved').length>=1,'some convert, some resist');
  assert.ok(out.every((r,i,a)=>i===0||r.id==='b'||a[i-1].id==='b'||r.chance<=a[i-1].chance),'more skeptical, lower chance');
  assert.equal(by.b.outcome,'devoted');assert.ok(room.at(-1).profile.religion.devotion>0.5);
  assert.equal(room[0].profile.religion.converted_at,123);assert.equal(room[0].profile.religion.deity_or_faith,H.name);
});
test('a failed, pushy one-on-one attempt makes the citizen warier',()=>{
  const p=person(0.6);const r=persuade(priest,{profile:p},H,{},{random:()=>0.99});
  assert.equal(r.outcome,'resisted');assert.equal(p.religion.skepticism,0.65);
});
test('hobbies: chosen in free time by weight, time since last practiced and mood; practice builds skill and morale',()=>{
  const now=10*3600000,hobbies=[{name:'gardening',proficiency:0.3,leisure_weight:1,last_practiced:0},{name:'music',proficiency:0.5,leisure_weight:0.75,last_practiced:0},{name:'stargazing',proficiency:0.2,leisure_weight:1,last_practiced:0}];
  assert.equal(chooseHobby(hobbies,{now,phase:'day'}).name,'gardening');
  assert.equal(chooseHobby(hobbies,{now,phase:'day',raining:true}),null,'outdoor hobbies wait for dry weather');
  assert.equal(chooseHobby(hobbies,{now,phase:'night'}).name,'gardening','stargazing competes at night');
  const gain=practice(hobbies[0],now);assert.ok(hobbies[0].proficiency>0.3&&gain>3);
  assert.equal(chooseHobby([hobbies[0]],{now:now+60000}),null,'just practiced');
});
test('profiles are seeded from role and values; faith fades without worship; census counts believers',()=>{
  const a=seedProfile('scribe','scribe',{tradition:0.9,curiosity:0.7}),b=seedProfile('scribe','scribe',{tradition:0.9,curiosity:0.7});
  assert.deepEqual(a,b,'deterministic');assert.equal(a.religion.deity_or_faith,'the Old Ways');assert.ok(a.hobbies.some(h=>h.name==='reading'));
  assert.equal(seedProfile('priest','priest',{}).religion.deity_or_faith,H.name);
  assert.equal(seedProfile('x','farmer',{},{religion:{deity_or_faith:null,devotion:0}}).religion.deity_or_faith,null,'agents.json wins');
  const lapsing=person(0.8,{faith:H.name,devotion:0.05});fade(lapsing,1);assert.equal(lapsing.religion.deity_or_faith,null);
  assert.deepEqual(census([person(0.1,{faith:H.name}),person(0.1),person(0.1)]),{'the Hearthlight':1,'no faith':2});
});
