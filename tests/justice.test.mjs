import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../agent-core/test-justice-quests.mjs';
import {newConflict,addEvidence,weighEvidence,sentenceFor,tickJail,jailRecord,jailCells,statementOf} from '../agent-core/skills/justice.mjs';
import {eligible,generateQuests,patrolRoute,questReward} from '../agent-core/skills/quests.mjs';
import {blueprint} from '../agent-core/blueprints.mjs';
import {assertAction} from '../agent-core/actions.mjs';
import {createSheriff} from '../agent-core/roles/sheriff.mjs';

test('quests and justice end to end (agent-core/test-justice-quests.mjs)',async()=>{
  const r=await simulate();
  assert.deepEqual(r.failures,[]);
});

test('conflict schema: ISO timestamp, tick, parties, location, status',()=>{
  const c=newConflict({n:7,party_a:'a',party_b:'b',reason:'noise',location:{x:1.4,y:64,z:2.6},tick:123,time:Date.parse('2026-10-01T12:00:00Z')});
  assert.equal(c.conflict_id,'C-007');assert.equal(c.timestamp,'2026-10-01T12:00:00.000Z');assert.equal(c.tick,123);
  assert.deepEqual(c.location,{x:1,y:64,z:3});assert.equal(c.status,'OPEN');
  assert.equal(c.a,'a');assert.equal(c.topic,'noise');assert.equal(c.resolved,false);   // old names still work
});

test('timestamps decide: an alibi contradicted by a sighting at the same minute',()=>{
  const T=Date.parse('2026-10-01T12:00:00Z');
  const c=newConflict({n:1,party_a:'a',party_b:'b',reason:'r',location:{x:0,z:0},time:T});
  addEvidence(c,{kind:'sighting',by:'w',about:'b',time:T+30000,location:{x:1,z:1},text:'saw b'});
  addEvidence(c,{kind:'statement',by:'b',about:'b',time:T+600000,text:'elsewhere',claim:{place:{x:100,z:100},at:T}});
  const v=weighEvidence(c);
  assert.equal(v.fault,'b');assert.match(v.findings[0],/12:00:00, but w saw them at the scene at 12:00:30/);
  // The same sighting three minutes off does not contradict it.
  const c2=newConflict({n:2,party_a:'a',party_b:'b',reason:'r',location:{x:0,z:0},time:T});
  addEvidence(c2,{kind:'sighting',by:'w',about:'b',time:T+240000,location:{x:1,z:1},text:'saw b'});
  addEvidence(c2,{kind:'statement',by:'b',about:'b',time:T+600000,text:'elsewhere',claim:{place:{x:100,z:100},at:T}});
  assert.equal(weighEvidence(c2).fault,null);
});

test('sentences and the jail clock',()=>{
  const c={party_a:'a',party_b:'b',kind:'dispute'};
  assert.equal(sentenceFor(c,{fault:null}).outcome,'dismissed');
  assert.equal(sentenceFor(c,{fault:'both'}).outcome,'reconcile');
  assert.equal(sentenceFor(c,{fault:'b',confidence:0.8}).outcome,'fine');
  assert.equal(sentenceFor(c,{fault:'b',confidence:0.8},{priors:{b:1}}).outcome,'jail');
  const theft=sentenceFor({...c,kind:'theft',amount:4},{fault:'b'});assert.equal(theft.outcome,'jail');assert.equal(theft.restitution,4);
  const jail=[jailRecord({jailed_citizen_id:'b',sentence_duration_ticks:1200,reason:'r'})];
  assert.deepEqual(tickJail(jail,600),[]);assert.equal(jail[0].remaining_ticks,600);
  assert.equal(tickJail(jail,600)[0].jailed_citizen_id,'b');assert.equal(jail.length,0);
});

test('a lying culprit and an honest witness',()=>{
  const c=newConflict({n:3,party_a:'a',party_b:'b',reason:'r',location:{x:0,z:0},truth:{instigator:'b'}});
  addEvidence(c,{kind:'sighting',by:'w',about:'b',location:{x:0,z:0},text:'saw b'});
  assert.ok(statementOf(c,'b',{random:()=>0.99,honesty:0.5}).lie);
  assert.ok(!statementOf(c,'b',{random:()=>0.1,honesty:0.5}).lie);
  assert.equal(statementOf(c,'w').provocation,'b');
  assert.match(statementOf(c,'z').text,/did not see/);
});

test('the jail blueprint has three closed cells at the stand points',()=>{
  const b=blueprint({shape:'jail'},10,64,20),at=(x,y,z)=>b.find(q=>q.x===x&&q.y===y&&q.z===z)?.block;
  for(const cell of jailCells({x:10,y:64,z:20})){
    const x=Math.floor(cell.x),z=Math.floor(cell.z);
    assert.equal(cell.y,65);assert.equal(at(x,65,z),undefined);assert.equal(at(x,66,z),undefined);   // room to stand
    assert.equal(at(x,64,z),'COBBLESTONE');                                                           // a floor
    assert.ok(['IRON_BARS','COBBLESTONE'].includes(at(x,65,z+2)));                                   // closed in front
  }
  assert.equal(at(14,65,26),undefined);   // the door
  assert.ok(b.length<600);
});

test('renovated jail has four equal cells and individually powered doors',()=>{
  const b=blueprint({shape:'jail',layoutVersion:2},258,69,116);
  const doors=b.filter(q=>q.block==='IRON_DOOR'),levers=b.filter(q=>q.block==='LEVER');
  assert.equal(doors.length,4);assert.equal(levers.length,4);
  assert.equal(jailCells({x:258,y:69,z:116,layoutVersion:2}).length,4);
  for(const d of doors){assert.ok(levers.some(l=>l.x===d.x&&l.z===d.z+1&&l.y===d.y));
    for(let dz=1;dz<=2;dz++)assert.equal(b.some(q=>q.x===d.x&&q.y===70&&q.z===116+dz),false);
    for(let dx=0;dx<=1;dx++)for(let dz=1;dz<=2;dz++)for(let dy=1;dy<=2;dy++)assert.equal(b.some(q=>q.x===d.x+dx&&q.y===69+dy&&q.z===116+dz),false);
    assert.equal(b.filter(q=>q.x===d.x+1&&q.z===119&&q.block==='IRON_BARS').length,2);
  }
  assert.ok(b.some(q=>q.block==='SPRUCE_DOOR'&&q.x===258&&q.z===120));
  assert.ok(Math.max(...b.map(q=>q.x))<=270);assert.ok(Math.max(...b.map(q=>q.z))<=124);
});

test('who may take which quest; needs become quests; patrol routes',()=>{
  assert.ok(eligible('INVESTIGATE_DISPUTE','sheriff'));assert.ok(!eligible('INVESTIGATE_DISPUTE','farmer'));
  assert.ok(eligible('INVESTIGATE_DISPUTE','guardian',{sheriffExists:false}));
  assert.ok(!eligible('FETCH_RESOURCES','sheriff'));assert.ok(eligible('CRAFT_ITEM','smith'));assert.ok(!eligible('COMMUNITY_SERVICE','governor'));
  const q=generateQuests({brokenTools:[{agent:'miner',tool:'IRON_PICKAXE'}],fundedStages:[{stage:'site:forge',name:'forge'}],roles:{governor:'g',smith:'s',builder:'b'}});
  assert.deepEqual(q.map(x=>x.category).sort(),['BUILD_STRUCTURE','CRAFT_ITEM']);
  assert.equal(q.find(x=>x.category==='CRAFT_ITEM').preferred,'s');
  assert.equal(patrolRoute({x:0,z:0},{points:4,radius:10}).length,4);
  assert.ok(questReward('COMMUNITY_SERVICE',10).emeralds>=1);
});

test('the new actions are validated',()=>{
  const self={id:'a',x:0,y:64,z:0,entities:[]},ids=['a','b'];
  const base={type:'wait',x:0,y:64,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{}};
  assert.ok(assertAction({...base,type:'claim_quest',target:'#12'},self,ids));
  assert.throws(()=>assertAction({...base,type:'claim_quest',target:'bread'},self,ids),/quest number/);
  assert.ok(assertAction({...base,type:'complain',to:'b',text:'took my bread'},self,ids));
  assert.throws(()=>assertAction({...base,type:'complain',to:'a',text:'me'},self,ids),/fellow citizen/);
  assert.throws(()=>assertAction({...base,type:'pardon',to:'nobody'},self,ids),/citizen id/);
});

test('the sheriff: escort before warrant before investigation before patrol',()=>{
  const j={warrants:()=>[],restricted:()=>false,investigations:()=>[],find:()=>null,jailDoor:()=>({x:0,z:0})};
  const q={workJob:()=>null,maybeTakeWork:()=>null};
  const sh=createSheriff({memory:{data:{}},configs:[{id:'sheriff',role:'sheriff'}],act:async()=>{},say:async()=>{},log:()=>{},ledger:()=>{},getSnapshot:()=>({agents:[]}),travel:async()=>{},
    justice:()=>j,quests:()=>q,board:()=>({active:()=>[]})});
  const c={id:'sheriff',role:'sheriff'},self={x:0,y:64,z:0};
  assert.equal(sh.job({id:'farmer',role:'farmer'},{},self,false),null);
  assert.ok(sh.job(c,{},self,false));                              // patrol
  j.investigations=()=>[{conflict_id:'C-001'}];const inv=sh.job(c,{},self,false);
  j.warrants=()=>[{suspect:'x',conflict_id:'C-001'}];const arrest=sh.job(c,{},self,false);
  const escort=sh.job(c,{escort:{suspect:'x',since:Date.now()}},self,false);
  assert.ok(inv&&arrest&&escort);
  assert.notEqual(String(inv),String(arrest));assert.notEqual(String(arrest),String(escort));
});
