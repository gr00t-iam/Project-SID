import test from 'node:test';
import assert from 'node:assert/strict';
import {similarity,duplicateOf,candidates,choose,voteOf,remember,TOPICS,DOMAINS} from '../agent-core/skills/proposals.mjs';
import {simulate} from '../agent-core/test-proposal-engine.mjs';

// The governor's guideline proposal as it was adopted again and again (rules #1, #8, #10, #12 in the live town).
const G1='Settlement guidelines proposal – with jrmym1981’s wishes guiding us: 1) Food security first – pause new builds until the pantry is healthy';
const G2='Settlement guidelines with jrmym1981’s wishes guiding us: 1) Food security first – pause new builds until pantry is healthy; 2) build only inside zones';

test('repeats are recognised: the same guidelines reworded, an open proposal, a recent decision',()=>{
  assert.ok(similarity(G1,G2)>=0.5,`similar enough (${similarity(G1,G2)})`);
  assert.equal(duplicateOf(G2,{rules:[{id:'1',text:G1}]}).id,'1');
  assert.equal(duplicateOf('Build a fishing dock on the lake',{rules:[{id:'1',text:G1}]}),null,'something new is not a repeat');
  assert.equal(duplicateOf('An earlier curfew every evening',{history:[{id:'9',title:'An earlier curfew',outcome:'rejected'}]}).kind,'rejected');
});
test('every topic has a domain, wording and an effect; candidates follow the town\'s state',()=>{
  for(const t of TOPICS)assert.ok(DOMAINS.includes(t.domain),t.topic);
  assert.deepEqual(new Set(TOPICS.map(t=>t.domain)),new Set(DOMAINS),'all six domains are covered');
  const quiet={day:10,pantryStatus:'healthy',treasury:50,shortages:[],pendingBuilds:[],threats:0,darkSpots:0,damageOpen:0,avgMorale:70,avgStress:20,daysSinceFestival:1,conflicts:[],faith:{believers:0,skeptics:5},shrineBuilt:true,hasPark:true,hasLake:false,marketActive:false,policy:{}};
  const none=candidates(quiet,{random:()=>0});
  assert.ok(!none.some(c=>['night_watch','food_reserve','materials_drive','holy_day'].includes(c.topic)),'a calm, fed, faithless town is not asked about curfews, food or holy days');
  const hungry=choose({...quiet,pantryStatus:'critical',avgStress:50},{random:()=>0});
  assert.equal(hungry.topic,'food_reserve','an empty pantry comes first');
});
test('nothing open, adopted or recently rejected is tabled again; variety across domains',()=>{
  const ctx={day:20,pantryStatus:'healthy',treasury:30,shortages:['COBBLESTONE'],pendingBuilds:[{id:'forge',name:'forge'}],threats:8,darkSpots:0,damageOpen:0,avgMorale:60,avgStress:30,daysSinceFestival:2,conflicts:[],faith:{believers:0},shrineBuilt:true,hasPark:true,policy:{}};
  const first=choose(ctx,{random:()=>0});
  assert.ok(!candidates(ctx,{open:[{key:first.key,topic:first.topic}],random:()=>0}).some(c=>c.key===first.key),'open: not again');
  const h=remember([],{...first,id:'1'},'rejected',20);
  assert.ok(!candidates({...ctx,day:22},{history:h,random:()=>0}).some(c=>c.key===first.key),'rejected two days ago: not again');
  assert.ok(candidates({...ctx,day:30},{history:h,random:()=>0}).some(c=>c.key===first.key),'but it may come back much later');
  const next=choose(ctx,{history:h,random:()=>0});
  assert.notEqual(next.domain,first.domain,'the next meeting looks at another part of town life');
});
test('citizens vote by their own values, role, faith and mood',()=>{
  const priest={role:'priest',faith:'the Hearthlight',values:{tradition:0.9,community:0.8}},skeptic={role:'scout',faith:null,values:{tradition:0.1,curiosity:0.95}};
  assert.equal(voteOf({topic:'holy_day',domain:'RELIGIOUS'},priest,()=>0.5).vote,'yes');
  assert.equal(voteOf({topic:'holy_day',domain:'RELIGIOUS'},skeptic,()=>0.5).vote,'no');
  const tired={role:'miner',values:{sociability:0.5,selfPreservation:0.5},morale:25,stress:30};
  assert.ok(voteOf({topic:'rest_day',domain:'LEISURE'},tired,()=>0.5).score>voteOf({topic:'rest_day',domain:'LEISURE'},{...tired,morale:80},()=>0.5).score,'unhappy citizens want a rest more');
  assert.ok(voteOf({topic:'holy_day',domain:'RELIGIOUS'},priest,()=>0.5).why.length>0,'every vote has a reason');
});
test('five consecutive meetings: unique, relevant, varied, remembered (agent-core/test-proposal-engine.mjs)',()=>{
  for(const seed of [17,3,29,101]){const r=simulate({seed});assert.deepEqual(r.failures,[],`seed ${seed}`);assert.equal(r.meetings.length,5);}
});
