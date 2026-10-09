import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../agent-core/intel/db.mjs';
import {createSocial} from '../agent-core/intel/social.mjs';
import {createGoals} from '../agent-core/intel/goals.mjs';
import {createMotivation,survivalVector,urgencies,survivalDrive,criticalNeeds,recovered,homeostaticLoss,threatOf,forwardUpdate,curiosityDrive,
  noveltyOf,affinityOf,transmitProbability,decayed,driveWeights,decide,commitmentOf,PREEMPT,CRITICAL} from '../agent-core/intel/motivation.mjs';

const HOSTILE=new Set(['ZOMBIE','CREEPER','SKELETON']);

test('survival: urgency reaches the preemption level exactly at each critical threshold',()=>{
  const at=k=>urgencies({health:100,hunger:100,energy:100,threat:0,[k]:CRITICAL[k]})[k];
  for(const k of ['health','hunger','energy','threat'])assert.equal(at(k),PREEMPT,k);
  const fine=survivalVector({health:20,needs:{hunger:20,energy:100}});
  assert.deepEqual(fine,{health:100,hunger:100,energy:100,threat:0});
  assert.equal(survivalDrive(fine),0);assert.equal(homeostaticLoss(fine),0);
  const starving=survivalVector({health:20,needs:{hunger:3,energy:90}});
  assert.ok(survivalDrive(starving)>=PREEMPT);assert.deepEqual(criticalNeeds(starving),['hunger']);
  // Hysteresis: past critical is not yet recovered.
  assert.equal(recovered(survivalVector({health:20,needs:{hunger:8,energy:90}})),false);
  assert.equal(recovered(survivalVector({health:20,needs:{hunger:12,energy:90}})),true);
});
test('survival: threat grows with nearby, dangerous mobs and with the alert',()=>{
  const me={x:0,z:0};
  assert.equal(threatOf([],me,{hostile:HOSTILE}),0);
  const far=threatOf([{type:'ZOMBIE',x:20,z:0}],me,{hostile:HOSTILE}),near=threatOf([{type:'ZOMBIE',x:3,z:0}],me,{hostile:HOSTILE});
  const creeper=threatOf([{type:'CREEPER',x:3,z:0}],me,{hostile:HOSTILE}),pack=threatOf([{type:'ZOMBIE',x:3,z:0},{type:'SKELETON',x:4,z:2}],me,{hostile:HOSTILE});
  assert.ok(far<near&&near<creeper&&near<pack,JSON.stringify({far,near,creeper,pack}));
  assert.ok(threatOf([],me,{hostile:HOSTILE,alert:'red'})>=0.3);
  assert.equal(threatOf([{type:'COW',x:1,z:1}],me,{hostile:HOSTILE}),0);
});
test('curiosity: prediction error is high for a surprise and fades as the model learns',()=>{
  let m=null,errs=[];
  for(let i=0;i<8;i++){const r=forwardUpdate(m,true,1000);errs.push(r.error);m=r.model;}
  assert.ok(errs.at(-1)<errs[1],'repeated success becomes expected');
  const surprise=forwardUpdate(m,false,1000).error;
  assert.ok(surprise>0.6,`a failure after many successes is surprising (${surprise})`);
  assert.equal(noveltyOf(0),1);assert.ok(noveltyOf(3)<noveltyOf(1));
  assert.ok(curiosityDrive({novelty:0.9,predError:0.6,stimuli:1})>curiosityDrive({novelty:0.1,predError:0.1}));
  assert.ok(curiosityDrive({idleMinutes:120})>0.3,'boredom builds while idle');
});
test('social: affinity, meme spread and decay',()=>{
  const stranger=affinityOf({}),friend=affinityOf({trust:85,familiarity:70,shared_history:25,alignment:0.6});
  assert.ok(friend>0.7&&stranger<0.4,JSON.stringify({friend,stranger}));
  assert.ok(transmitProbability(1,friend,'recipe')>transmitProbability(1,stranger,'recipe'));
  assert.ok(transmitProbability(1,friend,'recipe')>transmitProbability(1,friend,'knowledge'));
  assert.equal(decayed(1,24*3600000,'knowledge'),0.5,'knowledge: one-day half-life');
});
test('orchestrator: survival pressure crowds out curiosity; a goal is kept unless beaten by the margin',()=>{
  const calm=driveWeights({survival:0,curiosity:0.5,social:0.3}),stressed=driveWeights({survival:0.8,curiosity:0.5,social:0.3});
  assert.ok(stressed.survival>calm.survival&&stressed.curiosity<calm.curiosity/5);
  const D={survival:0.1,curiosity:0.8,social:0.2},W=driveWeights(D);
  const explore={drive:'curiosity',gains:{curiosity:0.9}};
  assert.equal(decide([explore],D,W).choice?.drive,'curiosity','idle: curiosity wins');
  assert.equal(decide([explore],D,W,{current:{goal:{source:'player:jrmym1981'},progress:0.5}}).choice,null,'a player\'s request is kept');
  assert.ok(commitmentOf({source:'player:x'})>commitmentOf({source:'curiosity'}));
  const Ds={survival:0.9,curiosity:0.9,social:0},hungry={drive:'survival',gains:{survival:1}};
  assert.equal(decide([explore,hungry],Ds,driveWeights(Ds),{current:{goal:{source:'player:x'},progress:0.9}}).reason,'survival override');
});

// ---------------------------------------------------------------- the engine against a small fake world
function world(){
  const db=openDatabase(':memory:'),social=createSocial(db),goals=createGoals(db,{lm:null});
  const configs=[{id:'hazel',role:'farmer'},{id:'bram',role:'builder'},{id:'wren',role:'scout'}];
  const memory={data:{agents:Object.fromEntries(configs.map(c=>[c.id,{needs:{hunger:18,energy:90}}])),town:{},charter:{rules:[],proposals:[]}}};
  const snap={worldTime:6000,agents:[
    {id:'hazel',x:280,y:70,z:100,health:20,inventory:{BREAD:6,WHEAT:10},entities:[]},
    {id:'bram',x:284,y:70,z:102,health:20,inventory:{OAK_PLANKS:40},entities:[]},
    {id:'wren',x:300,y:70,z:120,health:20,inventory:{EMERALD:3},entities:[]}]};
  const said=[],events=[],t={now:1_000_000};
  const ime=createMotivation({db,social,goals,configs,memory,getSnapshot:()=>snap,log:(type,data)=>events.push({type,...data}),say:async(id,text)=>{said.push({id,text});},
    act:async()=>({}),travel:async(id,self,dest)=>{Object.assign(snap.agents.find(a=>a.id===id),{x:dest.x,z:dest.z});},
    civic:()=>({eatJob:async()=>{},stockItems:()=>({})}),hostile:HOSTILE,now:()=>t.now,rng:()=>0});
  const self=id=>snap.agents.find(a=>a.id===id),conf=id=>configs.find(c=>c.id===id),st=id=>memory.data.agents[id];
  const step=(ms=20000)=>{t.now+=ms;ime.tick();};
  return {db,social,goals,ime,memory,snap,said,events,self,conf,st,step,t};
}

test('engine: critical health suspends the goal queue with its context, runs survival, and resumes after recovery',async()=>{
  const w=world();w.step();
  const g=w.goals.create('bram','Build the watchtower',{source:'player:jrmym1981',milestones:[{type:'BUILD',site:'watchtower'}]});
  Object.assign(w.self('bram'),{health:5,entities:[{type:'ZOMBIE',x:287,z:103,uuid:'z1'}]});
  const job=w.ime.job(w.conf('bram'),w.st('bram'),w.self('bram'));
  assert.equal(typeof job,'function','a survival subroutine runs now');
  assert.equal(w.ime.busy('bram'),true);
  const row=w.goals.get(g.goal_id),spec=JSON.parse(row.spec_json);
  assert.equal(row.status,'SUSPENDED');
  assert.equal(spec.suspended.by,'survival');assert.equal(spec.suspended.prevStatus,'IN_PROGRESS');
  assert.equal(spec.suspended.milestone,'build watchtower');assert.deepEqual(spec.suspended.position,{x:284,y:70,z:102});
  assert.equal(w.goals.current('bram'),null,'the executor sees no active goal while suspended');
  await job();
  assert.ok(w.self('bram').x<284,'retreated away from the zombie');
  assert.ok(w.said.some(s=>s.id==='bram'&&/zombie/.test(s.text)),'warned the others');
  // Healed and safe again.
  Object.assign(w.self('bram'),{health:18,entities:[]});w.step();
  assert.equal(w.ime.job(w.conf('bram'),w.st('bram'),w.self('bram')),null);
  assert.equal(w.ime.busy('bram'),false);
  assert.equal(w.goals.get(g.goal_id).status,'IN_PROGRESS','resumed where it was');
  assert.equal(w.goals.current('bram').goal.goal_id,g.goal_id);
});
test('engine: exhaustion means a nap (energy restores while napping); hunger with no food anywhere asks a trusted friend',async()=>{
  const w=world();w.step();
  w.st('wren').needs.energy=10;
  const nap=w.ime.job(w.conf('wren'),w.st('wren'),w.self('wren'));await nap();
  assert.equal(w.ime.napping('wren'),true);
  w.st('hazel').needs.hunger=2;w.self('hazel').inventory={};
  w.social.adjust('hazel','bram',{trust:30},'test');w.self('bram').inventory={BREAD:5};
  const orders=[];
  const ime2=createMotivation({db:w.db,social:w.social,goals:w.goals,configs:[{id:'hazel',role:'farmer'},{id:'bram',role:'builder'},{id:'wren',role:'scout'}],memory:w.memory,getSnapshot:()=>w.snap,
    say:async(id,text)=>w.said.push({id,text}),civic:()=>({eatJob:async()=>{},stockItems:()=>({})}),postOrder:(...a)=>orders.push(a),hostile:HOSTILE,now:()=>w.t.now});
  await ime2.job({id:'hazel',role:'farmer'},w.st('hazel'),w.self('hazel'))();
  assert.equal(orders[0][0],'hazel');assert.equal(orders[0][1],'BREAD');assert.equal(orders[0][3].preferred,'bram');assert.equal(orders[0][3].priority,'EMERGENCY');
});
test('engine: a creature never seen before makes an idle citizen curious enough to investigate',()=>{
  const w=world();w.step();w.step();   // baseline observation first: nothing is a surprise yet
  w.self('wren').entities=[{type:'FOX',x:310,z:130,uuid:'f1'}];
  w.step(6000);
  assert.equal(w.ime.stimuli('wren')[0].key,'FOX');
  w.ime.job(w.conf('wren'),w.st('wren'),w.self('wren'));
  const cur=w.goals.current('wren');
  assert.equal(cur.goal.source,'curiosity');assert.match(cur.goal.title,/Investigate the fox near 310,130/);
  assert.deepEqual(cur.milestones.map(m=>JSON.parse(m.spec_json).type),['GOTO','SAY']);
  assert.ok(w.events.some(e=>e.type==='motivation'&&e.kind==='investigate'));
});
test('engine: a trusted neighbour in distress gets food (theory of mind -> altruistic goal); strangers do not',()=>{
  const w=world();w.step();
  w.st('bram').needs.hunger=2;   // Bram is starving next to Hazel, who carries bread
  w.ime.job(w.conf('hazel'),w.st('hazel'),w.self('hazel'));
  assert.equal(w.goals.current('hazel'),null,'a stranger is not helped');
  w.social.adjust('hazel','bram',{trust:40},'test');
  for(let i=0;i<20;i++)w.ime.exchange('hazel','bram');   // (no memes yet: just exercises the path)
  w.t.now+=16000;w.ime.job(w.conf('hazel'),w.st('hazel'),w.self('hazel'));
  const cur=w.goals.current('hazel');
  assert.equal(cur?.goal.source,'altruism');assert.equal(cur.goal.title,'Bring food to bram');
  const m=JSON.parse(cur.milestones[0].spec_json);
  assert.deepEqual([m.type,m.item,m.quantity,m.to],['DELIVER','BREAD',4,'bram']);
});
test('engine: memes pass along bonds, and fade',()=>{
  const w=world();w.step();
  w.ime.seedMeme('hazel','recipe','recipe:BREAD','how to make bread',1);
  w.social.adjust('bram','hazel',{trust:40},'test');
  assert.equal(w.ime.exchange('hazel','bram'),1);
  const b=w.ime.beliefs('bram');assert.equal(b[0].content,'how to make bread');assert.ok(b[0].strength<1);
  const ctx=w.ime.context('bram').motivation;assert.ok(ctx.beliefs.includes('knows how to make bread'));assert.match(ctx.drives,/survival \d+%/);
  // The forward model and a successful craft also create a recipe meme.
  w.ime.observeOutcome('wren',{type:'craft',target:'TORCH'},true,800);
  assert.equal(w.ime.beliefs('wren')[0].content,'how to make torch');
});
