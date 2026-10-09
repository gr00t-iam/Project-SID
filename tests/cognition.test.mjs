import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCognition,deriveValues,valueWeights,applyAffect,driftAffect,feelingOf,baselineOf,salienceOf,recallScore,perceive,reasonToThink,phaseOf} from '../agent-core/cognition.mjs';
import {Memory} from '../agent-core/memory.mjs';

test('values: role template, personality words and a stable personal twist',()=>{
  const a=deriveValues('wren','scout','curious and adventurous'),b=deriveValues('wren','scout','curious and adventurous');
  assert.deepEqual(a,b,'deterministic');
  assert.ok(a.curiosity>a.tradition);
  assert.ok(deriveValues('x','builder','meticulous').craftsmanship>=deriveValues('x','builder','').craftsmanship);
  const w=valueWeights(a);assert.ok(w.curiosity>valueWeights(deriveValues('bram','builder','')).curiosity);
});
test('affect: events move morale and stress; both drift back to the baseline',()=>{
  const base=baselineOf(deriveValues('hazel','farmer','')),a=applyAffect(base,'danger');
  assert.ok(a.stress>base.stress+10);
  const later=driftAffect(a,base,1800000);assert.ok(Math.abs(later.stress-base.stress)<Math.abs(a.stress-base.stress)/1.9,'half-life 30 min');
  assert.equal(feelingOf({morale:80,stress:20}),'content');assert.equal(feelingOf({morale:20,stress:80}),'overwhelmed');
});
test('episodic memory: a relevant, vivid memory beats a merely recent one',()=>{
  const now=Date.now();
  const vivid={t:now-5*3600000,text:'Bram gave me bread when I was starving',who:['bram'],where:{x:0,z:0},salience:salienceOf({emotion:0.8,social:1})};
  const recent={t:now-60000,text:'Walked past the well',who:[],where:{x:500,z:500},salience:0.3};
  assert.ok(recallScore(vivid,{who:['bram'],where:{x:3,z:3}},now)>recallScore(recent,{who:['bram'],where:{x:3,z:3}},now));
  assert.ok(recallScore(recent,{},now)>recallScore({...recent,t:now-24*3600000},{},now));
});
test('perception: only chat within earshot is heard; hazards and weather are sensed',()=>{
  const self={id:'hazel',x:0,y:64,z:0,entities:[{type:'ZOMBIE',x:5,z:0},{type:'COW',x:3,z:3},{type:'TEXT_DISPLAY',x:1,z:1}],blocks:[{x:0,y:64,z:0,type:'WATER'}]};
  const p=perceive(self,{worldTime:14000,weather:{storm:true},agents:[self,{id:'bram',x:10,z:0}]},{ids:['hazel','bram'],hostile:new Set(['ZOMBIE']),
    chats:[{time:10,from:'bram',text:'near',x:10,z:0},{time:11,from:'wren',text:'far away',x:100,z:100},{time:12,from:'jrmym1981',text:'no position'}],players:[{name:'jrmym1981',x:6,z:0}],since:5});
  assert.deepEqual(p.heard.map(h=>h.text),['near','no position']);assert.deepEqual(p.heard.map(h=>h.player),[false,true]);
  assert.equal(perceive(self,{agents:[self]},{ids:['hazel'],chats:[{time:9,from:'bram',text:'Hazel, bread?'}],aliases:['hazel','Hazel']}).heard[0].addressed,true);
  assert.deepEqual(p.citizens,[{id:'bram',d:10}]);assert.equal(p.players[0].name,'jrmym1981');
  assert.deepEqual(p.creatures,['COW']);assert.equal(p.weather,'rain');assert.equal(p.phase,'night');
  assert.ok(p.hazards.includes('in water')&&p.hazards.some(h=>/zombie/.test(h)));
  assert.equal(phaseOf(500),'dawn');assert.equal(phaseOf(6000),'day');assert.equal(phaseOf(12000),'dusk');
});
test('attention: the model is called only for a reason',()=>{
  const now=1_000_000,cog={lastThink:now-60000,lastPhase:'day',metPlayers:{},affectAtThink:{morale:50,stress:30}},quiet={heard:[],players:[],hostiles:[],phase:'day'};
  assert.equal(reasonToThink({percept:quiet,cog,now}),null,'nothing new: no call');
  assert.equal(reasonToThink({inbox:1,percept:quiet,cog:{...cog,lastThink:now-1000},now}),'message','messages always');
  assert.equal(reasonToThink({percept:{...quiet,heard:[{from:'bram'}]},cog:{...cog,lastThink:now-5000},now}),null,'minimum gap');
  assert.equal(reasonToThink({percept:{...quiet,heard:[{from:'bram'}]},cog,now}),null,'citizen chatter: not yet');
  assert.equal(reasonToThink({percept:{...quiet,heard:[{from:'bram'}]},cog:{...cog,lastThink:now-200000},now}),null,'chatter alone never triggers');
  assert.equal(reasonToThink({percept:{...quiet,heard:[{from:'bram',addressed:true}]},cog,now}),'addressed');
  assert.equal(reasonToThink({percept:{...quiet,heard:[{from:'jrmym1981',player:true}]},cog,now}),'heard');
  assert.equal(reasonToThink({percept:{...quiet,players:[{name:'jrmym1981',d:6}]},cog,now}),'encounter:jrmym1981');
  assert.equal(reasonToThink({percept:{...quiet,players:[{name:'jrmym1981',d:6}]},cog:{...cog,metPlayers:{jrmym1981:now-30000}},now}),null,'already greeted');
  assert.equal(reasonToThink({percept:quiet,cog,now,lastError:{time:now-30000}}),'failure');
  assert.equal(reasonToThink({percept:{...quiet,phase:'dusk'},cog,now}),'phase:dusk');
  assert.equal(reasonToThink({percept:{...quiet,phase:'night'},cog:{...cog,lastPhase:'dusk'},now}),null,'into the night: no thought needed');
  assert.equal(reasonToThink({percept:quiet,cog,now,affect:{morale:50,stress:50}}),'feeling');
  assert.equal(reasonToThink({percept:{...quiet,hostiles:[{type:'ZOMBIE',d:6}]},cog,now}),'danger');
  assert.equal(reasonToThink({percept:quiet,cog:{...cog,lastThink:now-310000},now}),'heartbeat');
  assert.equal(reasonToThink({percept:quiet,cog:{...cog,lastThink:now-310000},every:8,now}),null,'background roles: every N minutes');
  assert.equal(reasonToThink({percept:{...quiet,phase:'night'},cog:{...cog,lastThink:now-310000},resting:true,now}),null,'resting: only messages, voices, visitors');
});

function town({day=3,worldTime=6000,storm=false}={}){
  const configs=[{id:'hazel',name:'Hazel the Farmer',role:'farmer'},{id:'bram',name:'Bram the Builder',role:'builder'},{id:'wren',name:'Wren the Scout',role:'scout'}];
  const memory={data:{agents:Object.fromEntries(configs.map(c=>[c.id,{needs:{hunger:18,energy:90},episodes:[],inbox:[],motivation:{}}])),town:{day}}};
  const snap={worldTime,weather:{storm},agents:[{id:'hazel',x:280,y:70,z:100,entities:[]},{id:'bram',x:330,y:70,z:140,entities:[]},{id:'wren',x:300,y:70,z:118,entities:[]}]};
  const moves=[],logs=[],t={now:10_000_000};
  const cog=createCognition({configs,memory,getSnapshot:()=>snap,homeOf:id=>({hazel:{cx:276,cz:98},bram:{cx:290,cz:100}})[id],homeBuilt:id=>id!=='wren',
    travel:async(id,self,dest)=>moves.push({id,...dest}),log:(type,data)=>logs.push({type,...data}),now:()=>t.now,random:()=>0,
    intel:()=>({motivation:{affinity:(a,b)=>a==='wren'&&b==='bram'?0.7:0.2}})});
  return {configs,memory,snap,cog,moves,logs,t,self:id=>snap.agents.find(a=>a.id===id),st:id=>memory.data.agents[id],c:id=>configs.find(x=>x.id===id)};
}
test('behaviour: rain sends citizens with a roof home; a tired citizen naps at home',async()=>{
  const w=town({storm:true});
  await w.cog.idleJob(w.c('hazel'),w.st('hazel'),w.self('hazel'))();
  assert.deepEqual([w.moves[0].id,w.moves[0].x,w.moves[0].z],['hazel',276,98]);
  const d=town();d.st('bram').needs.energy=20;Object.assign(d.self('bram'),{x:290,z:100});
  d.cog.idleJob(d.c('bram'),d.st('bram'),d.self('bram'));
  assert.equal(d.st('bram').motivation.nap,true,'napping restores energy (civic reads the flag)');
  d.st('bram').needs.energy=85;d.cog.idleJob(d.c('bram'),d.st('bram'),d.self('bram'));
  assert.equal(d.st('bram').motivation.nap,false,'wakes up rested');
});
test('behaviour: market days draw citizens to the market; lonely citizens visit their closest friend',async()=>{
  const w=town({day:3});
  await w.cog.idleJob(w.c('hazel'),w.st('hazel'),w.self('hazel'))();
  assert.ok(Math.hypot(w.moves[0].x-278.5,w.moves[0].z-105.5)<=7,'went to the market');
  assert.equal(w.st('hazel').cog.linger.why,'browsing the market');
  const v=town({day:4});
  await v.cog.idleJob(v.c('wren'),v.st('wren'),v.self('wren'))();
  assert.ok(Math.hypot(v.moves[0].x-330,v.moves[0].z-140)<=4,'walked over to Bram');
  assert.ok(v.logs.some(l=>l.type==='behaviour'&&l.what==='visit'&&l.friend==='bram'));
});
test('experience: log events become feelings and salient memories, recalled for the people present',()=>{
  const w=town();
  const before=w.cog.affectOf('hazel').morale;
  w.cog.onLog('trade',{kind:'give',agent:'bram',to:'hazel',item:'BREAD',count:4});
  w.cog.onLog('dialogue',{a:'hazel',b:'wren',topic:'the harvest'});
  w.cog.onLog('ate',{agent:'hazel'});   // everyday: a feeling, not a memory
  assert.ok(w.cog.affectOf('hazel').morale>before);
  const mem=w.st('hazel').memories;assert.equal(mem.length,2);
  assert.equal(w.cog.recall('hazel',{who:['bram']},1)[0].text,'Bram gave me 4 bread');
  const ctx=w.cog.context(w.c('hazel'),w.st('hazel'),w.self('hazel'));
  assert.ok(ctx.feeling.word&&ctx.values.length===3&&ctx.senses.weather==='clear');
});
test('attention in the engine: a skipped check is counted; thinking records the moment',()=>{
  const w=town();
  assert.equal(w.cog.shouldThink(w.c('hazel'),w.st('hazel'),w.self('hazel')),'heartbeat','never thought yet');
  w.cog.noteThought(w.c('hazel'),w.st('hazel'),'heartbeat');
  w.t.now+=20000;
  assert.equal(w.cog.shouldThink(w.c('hazel'),w.st('hazel'),w.self('hazel')),null);
  assert.deepEqual([w.cog.attention().thinks.heartbeat,w.cog.attention().skipped],[1,1]);
});
test('memory: debounced saves coalesce into one compact write; flush writes at once',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sid-mem-'));
  const m=new Memory(dir,{debounceMs:50});await m.load();
  for(let i=0;i<20;i++){m.data.board.push({i});await m.save();}
  assert.equal(m.writes,0,'nothing written yet');
  await new Promise(r=>setTimeout(r,120));await m.saving;
  assert.equal(m.writes,1,'twenty saves, one write');
  const text=await readFile(path.join(dir,'memory.json'),'utf8');assert.ok(!text.includes('\n  '),'compact JSON');
  m.data.board.push({last:true});await m.flush();assert.equal(m.writes,2);
  const again=new Memory(dir);await again.load();assert.equal(again.data.board.at(-1).last,true);
});

test('vandalism: the mayor\'s edits upset nobody; a spree is one upset, felt only by citizens nearby',()=>{
  const w=town();w.memory.data.town.mayor='jrmym1981';
  const mood=id=>({...w.cog.affectOf(id)});const before=mood('hazel');
  for(let i=0;i<50;i++)w.cog.onLog('vandalism',{player:'jrmym1981',block:{x:280,y:70,z:100,type:'COBBLESTONE'}});
  assert.deepEqual(mood('hazel'),before,'the mayor landscaping');
  for(let i=0;i<50;i++)w.cog.onLog('vandalism',{player:'griefer',block:{x:280,y:70,z:100,type:'COBBLESTONE'}});
  assert.equal(mood('hazel').morale,before.morale-6,'one upset for the whole spree');
  assert.equal(mood('bram').morale,w.cog.affectOf('bram').morale);
  const far=town();far.cog.affectOf('bram');const b0={...far.cog.affectOf('bram')};
  far.cog.onLog('vandalism',{player:'griefer',block:{x:280,y:70,z:100,type:'COBBLESTONE'}});
  assert.deepEqual({...far.cog.affectOf('bram')},b0,'Bram is 64 blocks away and did not see it');
});
