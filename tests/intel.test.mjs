import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../agent-core/intel/db.mjs';
import {createSocial,labelFor,contractTerms} from '../agent-core/intel/social.mjs';
import {createSpatial,classifyBlock,parseQuery} from '../agent-core/intel/spatial.mjs';
import {createBoard,chooseOrder,fulfilmentPlan} from '../agent-core/intel/orders.mjs';
import {createReflector,classify,ruleRecovery,signature} from '../agent-core/intel/reflect.mjs';
import {createGoals,validateMilestones,templatePlan} from '../agent-core/intel/goals.mjs';
import {createArchive,buildWorkbook,normalizeTags,fallbackSummary} from '../agent-core/intel/archive.mjs';
import {sourceBlock} from '../agent-core/intel/executor.mjs';

const clock=(t=Date.parse('2026-09-28T12:00:00Z'))=>{const c=()=>t;c.add=ms=>{t+=ms;};return c;};

test('trust matrix: directional scores, labels, spec adjustments, migration, contract terms',()=>{
  const db=openDatabase(':memory:'),social=createSocial(db);
  assert.equal(labelFor(80,70),'FRIENDLY');assert.equal(labelFor(50,30),'SUSPICIOUS');assert.equal(labelFor(10,90),'HOSTILE');assert.equal(labelFor(50,50),'NEUTRAL');
  social.apply('builder','farmer','order_fulfilled');
  assert.deepEqual([social.view('builder','farmer').trust_score,social.view('builder','farmer').reliability_score],[55,60]);
  assert.equal(social.view('farmer','builder').trust_score,50,'directional');
  for(let i=0;i<3;i++)social.apply('farmer','builder','order_failed');
  const v=social.view('farmer','builder');assert.equal(v.reliability_score,5);assert.equal(v.affinity_label,'SUSPICIOUS');
  assert.equal(contractTerms(v).accept,false,'after three broken promises she refuses');
  assert.equal(contractTerms({trust_score:45,reliability_score:30,affinity_label:'SUSPICIOUS'}).upfront,0.5,'asks half up front from the unreliable');
  assert.equal(contractTerms({...v,trust_score:10,affinity_label:'HOSTILE'}).accept,false);
  assert.equal(social.migrate({'a|b':5,'c|d':-4}),2);assert.equal(social.view('a','b').trust_score,70);assert.equal(social.view('d','c').trust_score,34);
  assert.equal(social.migrate({'a|b':5}),0,'only once');
  assert.ok(social.relationsOf('d').rivals.some(r=>r.id==='c'));
  assert.equal(social.pairScore('a','b'),5);
});

test('spatial memory: observations merge, queries rank by distance and recency, chests match contents',()=>{
  const db=openDatabase(':memory:'),now=clock(),spatial=createSpatial(db,{now,HOSTILE:new Set(['ZOMBIE'])});
  assert.deepEqual(classifyBlock('DEEPSLATE_IRON_ORE'),{category:'ore',item:'IRON'});assert.equal(classifyBlock('STONE'),null);
  assert.deepEqual(parseQuery('where is some coal?').items,['COAL']);
  const snap={agents:[{id:'miner',x:0,z:0,blocks:[{type:'COAL_ORE',x:10,y:40,z:10},{type:'COAL_ORE',x:11,y:40,z:10},{type:'OAK_LOG',x:-5,y:65,z:3}],entities:[{type:'ZOMBIE',x:3,y:64,z:3,uuid:'z'}]}]};
  spatial.observeSnapshot(snap);
  assert.equal(db.get("SELECT count(*) n FROM spatial_memories WHERE category='ore'").n,1,'nearby ore of one kind merges');
  now.add(3600000);
  spatial.record({observed_by:'scout',x:100,y:40,z:100,category:'ore',item:'COAL'});
  const hits=spatial.query('miner','coal',3,null,{from:{x:0,z:0}});
  assert.equal(hits.length,2);assert.equal(hits[0].x,10,'the near one wins despite being older');
  assert.equal(spatial.query('miner','coal',3,50,{from:{x:0,z:0}}).length,1,'radius');
  spatial.observeChests('merchant',[{x:1,y:70,z:1,name:'Supplies & Tools',items:{IRON_INGOT:5,COAL:3}},{x:2,y:70,z:1,items:{BREAD:9}}]);
  assert.equal(spatial.query('smith','iron',5,null,{from:{x:0,z:0}}).filter(h=>h.category==='chest').length,1,'only the chest that holds iron');
  assert.equal(spatial.query('farmer','food',5,null,{from:{x:0,z:0}})[0].details.items.BREAD,9);
  const wood=spatial.query('builder','wood',1,null,{from:{x:0,z:0}})[0];assert.equal(wood.item,'OAK_LOG');
  spatial.markStale(wood.memory_id);assert.equal(spatial.query('builder','wood',1,null,{from:{x:0,z:0}}).filter(h=>h.category==='tree').length,0);
  assert.equal(sourceBlock('SWEET_BERRIES').block,'SWEET_BERRY_BUSH');
});

test('work orders: posting, merging, claiming, delivery, verification, deadlines',()=>{
  const db=openDatabase(':memory:'),now=clock(),board=createBoard(db,{now});
  const o=board.post({issuer:'builder',item:'OAK_PLANKS',quantity:32,reward:2,priority:'MEDIUM'});
  assert.equal(o.number,1);assert.equal(o.status,'OPEN');assert.equal(o.target_location,'warehouse');
  assert.equal(board.post({issuer:'builder',item:'OAK_PLANKS',quantity:16}).merged,true);
  assert.equal(board.claim(o.order_id,'crafter').status,'CLAIMED');
  assert.equal(board.claim(o.order_id,'scout'),null,'already claimed');
  assert.equal(board.progress(o.order_id,20,'crafter').status,'CLAIMED');
  assert.equal(board.progress(o.order_id,20,'crafter').status,'DELIVERED');
  assert.equal(board.verify(o.order_id,{paid:true}).status,'VERIFIED');
  const late=board.post({issuer:'farmer',item:'BREAD',quantity:4,priority:'EMERGENCY'});board.claim(late.order_id,'courier');
  now.add(9*60000);
  assert.equal(board.sweep()[0].contractor_name,'courier');assert.equal(board.get(late.order_id).status,'OPEN');
  assert.throws(()=>board.post({issuer:'x',type:'NOPE'}),/Order type/);
  assert.equal(board.migrateQuests([{by:'smith',item:'IRON_INGOT',count:8,delivered:0,status:'open',reward:{count:3}}]),1);
});

test('contract choice: skills, stock, priority, named helpers first, distrust',()=>{
  const orders=[
    {order_id:'1',status:'OPEN',issuer_name:'builder',order_type:'RESOURCE_REQUEST',target_item:'OAK_PLANKS',quantity:16,delivered:0,priority:'MEDIUM',target_location:'warehouse',created:0,history_json:'[]'},
    {order_id:'2',status:'OPEN',issuer_name:'miner',order_type:'RESOURCE_REQUEST',target_item:'BREAD',quantity:4,delivered:0,priority:'EMERGENCY',target_location:'agent',created:Date.now(),history_json:JSON.stringify([{preferred:'farmer'}])},
    {order_id:'3',status:'OPEN',issuer_name:'governor',order_type:'GUARD_DUTY',quantity:1,delivered:0,priority:'HIGH',created:0,history_json:'[]'},
  ];
  const agents=[{id:'builder',x:0,z:0},{id:'miner',x:50,z:0},{id:'governor',x:0,z:0}];
  const crafter={id:'crafter',role:'crafter',x:0,z:0,inventory:{OAK_LOG:4}};
  assert.equal(chooseOrder(orders,crafter,{stock:{},agents}).order.order_id,'1','makes planks from logs');
  assert.equal(chooseOrder(orders,crafter,{stock:{},agents,busy:true}),null,'busy: only urgent orders, and it cannot bake');
  const courier={id:'courier',role:'courier',x:0,z:0,inventory:{}};
  assert.equal(chooseOrder(orders,courier,{stock:{BREAD:40},agents}),null,'the named farmer gets two minutes first');
  assert.equal(chooseOrder(orders,{...{id:'farmer',role:'farmer',x:0,z:0},inventory:{BREAD:20}},{stock:{},agents}).order.order_id,'2');
  assert.equal(chooseOrder(orders,{id:'guardian',role:'guardian',x:0,z:0,inventory:{BREAD:30}},{stock:{},agents}).order.order_id,'3','the guard takes guard duty only');
  assert.equal(chooseOrder(orders,crafter,{stock:{},agents,terms:()=>({accept:false})}),null,'refuses issuers it does not trust');
  assert.equal(fulfilmentPlan(orders[0],{id:'x',role:'scout',inventory:{}},{stock:{OAK_PLANKS:99}}),null,'no fetching from the warehouse for the warehouse');
});

test('reflection: exception types, no repeats, three attempts, rules without a model',async()=>{
  assert.equal(classify('Destination obstructed'),'PathBlockedException');assert.equal(classify('That chest has no BREAD'),'ContainerEmptyException');
  assert.equal(classify('Unknown or offline recipient'),'TargetMissingException');
  const r=ruleRecovery('PathBlockedException',{action:{type:'pathfind',x:10,z:0},self:{x:0,z:0}});
  assert.equal(r.strategy,'alternate_action');assert.notEqual(signature(r.action),signature({type:'pathfind',x:10,z:0}));
  const db=openDatabase(':memory:');
  let calls=0;const lm={online:true,callUtilityTask:async()=>{calls++;return '{"reflection":"The chest was empty; ask for help.","strategy":"request_help"}';}};
  const ref=createReflector(db,{lm});
  const a={type:'withdraw',target:'BREAD',x:0,z:0};
  const first=await ref.reflect({agent:'scout',subject:'s1',action:a,error:'That chest has no BREAD',goal:'eat'});
  assert.equal(first.strategy,'request_help');assert.equal(first.source,'llm');assert.equal(calls,1);
  assert.match(ref.repeatOf('scout',a),/has no BREAD/);
  await ref.reflect({agent:'scout',subject:'s1',action:a,error:'x'});await ref.reflect({agent:'scout',subject:'s1',action:a,error:'x'});
  assert.equal((await ref.reflect({agent:'scout',subject:'s1',action:a,error:'x'})).giveUp,true);
  const offline=createReflector(db,{lm:{online:false}});
  assert.equal((await offline.reflect({agent:'b',subject:'s2',action:a,error:'That chest has no BREAD'})).source,'rules');
  assert.equal(db.get('SELECT count(*) n FROM reflections').n,5);
});

test('goals: milestone validation, templates, planning with and without a model, replanning',async()=>{
  assert.deepEqual(validateMilestones([{type:'gather',item:'oak planks',quantity:'128'},{type:'FLY'},{type:'GOTO',x:1}]).map(m=>[m.type,m.item,m.quantity]),[['GATHER','OAK_PLANKS',128]]);
  assert.equal(templatePlan('Prepare Winter Food Reserve',{role:'farmer'}).at(-1).type,'DELIVER');
  const db=openDatabase(':memory:');
  const lm={callPrimaryTask:async()=>'{"milestones":[{"type":"GATHER","item":"OAK_PLANKS","quantity":128,"title":"Gather 128 Oak Planks"},{"type":"BUILD","site":"town_hall","title":"Build the town hall"}]}'};
  const goals=createGoals(db,{lm});
  const g=goals.create('builder','Build Town Hall');assert.equal(g.status,'PENDING');
  await goals.plan(g.goal_id,{role:'builder'});
  let cur=goals.current('builder');assert.equal(cur.milestone.title,'Gather 128 Oak Planks');assert.equal(cur.goal.status,'IN_PROGRESS');
  goals.completeMilestone(cur.milestone.goal_id);cur=goals.current('builder');assert.equal(cur.milestone.spec.site,'town_hall');
  const broken=createGoals(db,{lm:{callPrimaryTask:async()=>{throw Object.assign(Error('down'),{offline:true});}}});
  assert.equal(await broken.failMilestone(cur.milestone.goal_id,'blocked',{role:'builder'}),'replanned');
  cur=goals.current('builder');assert.equal(cur.milestones.filter(m=>m.status==='COMPLETED').length,1,'finished work is kept');
  assert.ok(cur.milestone,'a template plan replaced the rest');
  goals.completeMilestone(cur.milestone.goal_id);
  for(const m of goals.current('builder')?.milestones??[])goals.completeMilestone(m.goal_id);
  assert.equal(goals.finishIfDone(g.goal_id),true);assert.equal(goals.current('builder'),null);
});

test('conversation archive: capture, end on silence, offloaded summary, retrieval, search, workbook',async()=>{
  const db=openDatabase(':memory:'),now=clock();
  const lm={online:true,callUtilityTask:async()=>'{"summary":"Hazel and jrmym1981 agreed to plant carrots beside the wheat.","topic_tags":["Carrot Planting","wheat supply"]}'};
  const archive=createArchive(db,{lm,now,nameOf:id=>({farmer:'Hazel'})[id]??id,isAgent:id=>id==='farmer',playerPos:()=>({x:0,y:64,z:0}),
    getSnapshot:()=>({agents:[{id:'farmer',x:2,y:64,z:2}]}),getTick:()=>({day:71,worldTime:5000})});
  archive.playerSaid('jrmym1981','Can you plant carrots next to the wheat?');now.add(2000);
  archive.agentSaidTo('farmer','jrmym1981','Gladly! I have eight carrots ready.');
  assert.equal(archive.hasOpen('jrmym1981'),true);
  now.add(31000);archive.tick();assert.equal(archive.hasOpen('jrmym1981'),false,'ended after 30 s of silence');
  assert.equal(await archive.processOne(),true);
  const [e]=archive.getRecentConversations('Hazel',5);
  assert.deepEqual(e.participants,['jrmym1981','Hazel']);assert.deepEqual(e.topic_tags,['carrot_planting','wheat_supply']);assert.deepEqual(e.location,[0,64,0],'where it started');
  assert.equal(archive.getRecentConversations('farmer',5).length,1,'by id too');
  assert.equal(archive.query({q:'carrot'}).total,1);assert.equal(archive.query({from:'2026-09-29'}).total,0);
  assert.equal(archive.get(e.conversation_id).transcript.length,2);
  // Offline: the conversation waits in the queue.
  const off=createArchive(db,{lm:{online:false},now});const id=off.start({kind:'npc_dialogue',participants:['a','b']});off.add(id,'a','hi');off.end(id);
  assert.equal(await off.processOne(),false);assert.equal(off.stats().queued,1);
  assert.deepEqual(normalizeTags(['Wheat Supply!','wheat_supply','a']),['wheat_supply']);
  assert.match(fallbackSummary({participants:['A','B'],transcript:[{speaker:'A',message:'the wheat the wheat harvest'}]}).summary,/A, B talked/);
  const ExcelJS=(await import('exceljs')).default;
  const wb=buildWorkbook([archive.get(e.conversation_id)],ExcelJS);
  const buf=await wb.xlsx.writeBuffer();
  const back=new ExcelJS.Workbook();await back.xlsx.load(buf);
  assert.deepEqual(back.worksheets.map(w=>w.name),['Summary Index','Full Transcripts']);
  assert.deepEqual(back.getWorksheet('Summary Index').getRow(1).values.slice(1),['Date/Time','ID','Participants','Location','Topic Tags','Summary']);
  assert.deepEqual(back.getWorksheet('Full Transcripts').getRow(1).values.slice(1),['Conversation ID','Timestamp','Speaker','Message']);
  assert.equal(back.getWorksheet('Full Transcripts').rowCount,3);
});
