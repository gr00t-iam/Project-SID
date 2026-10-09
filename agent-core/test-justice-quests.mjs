// Quests and justice end to end, on the real order board (in-memory sqlite), the real executor's payment and the
// real court, with a scripted town and a clock we move by hand:
//   1. a quest is posted, claimed, completed and paid (and the new kinds: craft, community service, patrol)
//   2. a dispute is recorded with an ISO timestamp, tick and location, and witnesses
//   3. a complaint -> the sheriff's investigation (statements) -> a trial that catches a lie by its timestamp
//   4. a theft -> warrant -> jail (restricted, sentence in ticks) -> released when the sentence runs out; a pardon
//   node agent-core/test-justice-quests.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {openDatabase} from './intel/db.mjs';
import {createBoard,fulfilmentPlan} from './intel/orders.mjs';
import {createSocial} from './intel/social.mjs';
import {createExecutor} from './intel/executor.mjs';
import {createQuests,categoryOf} from './skills/quests.mjs';
import {createJustice,weighEvidence,migrateConflict} from './skills/justice.mjs';

const CONFIGS=[
  {id:'governor',role:'governor',name:'Governor Elia'},{id:'sheriff',role:'sheriff',name:'Sheriff Wade Harlan'},{id:'builder',role:'builder',name:'Bram the Builder'},
  {id:'crafter',role:'crafter',name:'Tink the Crafter'},{id:'smith',role:'smith',name:'Hal the Smith'},{id:'merchant',role:'merchant',name:'Marlo the Trader'},
  {id:'scout',role:'scout',name:'Wren the Scout'},{id:'farmer',role:'farmer',name:'Hazel the Farmer'},{id:'chef',role:'chef',name:'Chef Antoine'},
];

export async function simulate({seed=7}={}){
  const failures=[],steps=[];
  const check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=Date.parse('2026-10-01T15:00:00Z');const now=()=>t;
  let s=seed;const random=()=>((s=(s*16807)%2147483647)/2147483647);
  const db=openDatabase(':memory:'),board=createBoard(db,{now}),social=createSocial(db,{now});
  const paid=[],said=[],confined=[];
  const act=async(id,a)=>{
    if(a.type==='wage')paid.push({from:id,to:a.to,count:a.count,item:a.target});
    if(a.type==='pay')paid.push({from:id,to:'treasury',count:a.count,item:a.target});
    if(a.type==='confine')confined.push({id,x:a.x,y:a.y,z:a.z});
    if(a.type==='survey')return {heights:[63]};
    return {ok:true};
  };
  const say=async(id,text)=>{said.push(`${id}: ${text}`);};
  const nameOf=id=>CONFIGS.find(c=>c.id===id)?.name.split(' the ')[0]??id;
  const roleOf=id=>CONFIGS.find(c=>c.id===id)?.role??id;
  const executor=createExecutor({act,say,board,social,log:()=>{},ledger:()=>{},nameOf,roleOf,getSnapshot:()=>snap});
  const memory={data:{town:{day:300,conflicts:[{id:'1',a:'merchant',b:'scout',topic:'old quarrel',day:290,resolved:false},{id:'2',a:'builder',b:'crafter',topic:'credit',day:299,resolved:false}],built:{}},agents:{}}};
  // Where everyone stands: the merchant and the scout on the square, the farmer watching from the well, the rest far off.
  let snap={worldTime:6000,agents:[
    {id:'merchant',x:283,y:64,z:93},{id:'scout',x:285,y:64,z:94},{id:'farmer',x:281,y:64,z:92},
    {id:'governor',x:263,y:64,z:62},{id:'sheriff',x:281,y:64,z:98},{id:'builder',x:240,y:64,z:80},{id:'crafter',x:230,y:64,z:120},
    {id:'smith',x:235,y:64,z:87},{id:'chef',x:279,y:64,z:104,inventory:{BAKED_POTATO:6}}]};
  const quests=createQuests({board,executor,configs:CONFIGS,act,say,nameOf,roleOf,now,award:()=>{},valueOf:()=>1});
  const justice=createJustice({memory,configs:CONFIGS,act,say,nameOf,getSnapshot:()=>snap,now,random,quests:()=>quests,
    valuesOf:()=>({community:0.2,tradition:0.8,selfPreservation:0.6}),trust:()=>50,trialDelayMs:120000,square:{x:283.5,z:93.5},
    onServiceDone:null});
  quests.onServiceDone=justice.onServiceDone;

  // ---------- 1. quests ----------
  const fetch=quests.post({category:'FETCH_RESOURCES',issuer:'builder',item:'COBBLESTONE',quantity:8,note:'for the jail'});
  check(categoryOf(fetch)==='FETCH_RESOURCES'&&fetch.reward_emeralds>=1,'fetch quest posted with a reward');
  let threw=null;try{quests.claim('sheriff',fetch.number);}catch(e){threw=e.message;}
  check(threw,'the sheriff may not take a fetch quest');
  quests.claim('crafter',fetch.number);
  t+=60000;board.progress(fetch.order_id,8,'crafter');   // delivered to the warehouse by the executor's contract
  const before=paid.length,done=await quests.turnIn('crafter',fetch.number);
  check(done.status==='VERIFIED','fetch quest verified after turn-in');
  check(paid.slice(before).some(p=>p.to==='crafter'&&p.count===fetch.reward_emeralds),'the crafter was paid the reward');
  check(social.view('builder','crafter').trust_score>50,'the builder trusts the crafter more after the quest');
  steps.push(`quest #${fetch.number} fetch 8 cobblestone: claimed by Tink, delivered, paid ${fetch.reward_emeralds} emeralds`);
  // Craft: the smith makes a pickaxe; the claim lasts 40 minutes, a building claim three hours.
  const craft=quests.post({category:'CRAFT_ITEM',issuer:'merchant',item:'IRON_PICKAXE',quantity:1});
  check(!!fulfilmentPlan(craft,{id:'smith',role:'smith',inventory:{IRON_INGOT:3,STICK:2}},{stock:{}}),'the smith can make the pickaxe');
  check(!fulfilmentPlan(craft,{id:'merchant2',role:'merchant',inventory:{}},{stock:{IRON_PICKAXE:4}}),'a craft quest is not filled from the warehouse');
  const build=quests.post({category:'BUILD_STRUCTURE',issuer:'governor',quantity:1,targetLocation:{stage:'site:jail',name:'jail'}});
  const claimedBuild=quests.claim('builder',build.number);
  check(claimedBuild.deadline-claimedBuild.claimed_at>=3*3600000,'a building claim lasts hours, not 15 minutes');
  await quests.syncConstruction(['site:jail'],'builder');
  check(board.get(build.order_id).status==='VERIFIED','a finished building pays its construction quest');
  // Food: a hungry citizen's bread request is filled by the chef with a baked potato.
  const bread=board.post({issuer:'farmer',item:'BREAD',quantity:1,reward:2,targetLocation:'agent'});
  const plan=fulfilmentPlan(bread,{id:'chef',role:'chef',inventory:{BAKED_POTATO:6}},{stock:{}});
  check(plan?.item==='BAKED_POTATO','bread orders accept other food');
  steps.push(`bread order #${bread.number}: the chef would bring ${plan?.item}`);
  // Generated quests from the town's needs (a patrol when monsters were about, service when repairs are open).
  const gen=quests.generate({shortages:[{item:'OAK_FENCE',n:12,by:'builder'}],threats:5,damageOpen:6,darkSpots:0,roles:Object.fromEntries(CONFIGS.map(c=>[c.role,c.id])),square:{x:283.5,z:93.5},fundedStages:[]});
  check(gen.some(o=>o.order_type==='PATROL_TERRITORY')&&gen.some(o=>o.order_type==='COMMUNITY_SERVICE')&&gen.some(o=>o.target_item==='OAK_FENCE'),'needs become quests (fetch, patrol, service)');
  check(quests.generate({threats:5,roles:{governor:'governor'}}).every(o=>o.order_type!=='PATROL_TERRITORY'),'an active patrol quest is not posted twice');

  // ---------- 2. migration and a timestamped dispute ----------
  check(memory.data.town.conflicts.every(c=>/^C-\d{3}$/.test(c.conflict_id)&&!Number.isNaN(Date.parse(c.timestamp))),'old conflicts migrated to the schema');
  check(memory.data.town.conflicts.find(c=>c.id==='1').status==='RESOLVED','a quarrel ten days old has cooled off');
  check(memory.data.town.conflicts.find(c=>c.id==='2').status==='OPEN','yesterday\'s quarrel is still open');
  const k=justice.openConflict({a:'merchant',b:'scout',reason:'who gets the warehouse bread first',truth:{instigator:'scout',alibi:{x:330,z:40}}});
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(k.timestamp),'conflict timestamp is ISO 8601');
  check(Number.isFinite(k.tick)&&k.location&&k.party_a==='merchant'&&k.party_b==='scout'&&k.status==='OPEN','conflict has tick, location, parties and OPEN status');
  check(k.evidence.some(e=>e.kind==='sighting'&&e.by==='farmer'&&e.about==='scout'),'the farmer at the well is recorded as a witness');
  check(!k.evidence.some(e=>e.by==='builder'),'citizens far away are not witnesses');
  steps.push(`${k.conflict_id} at ${k.timestamp} tick ${k.tick} at ${k.location.x},${k.location.z}: merchant v scout, witnesses: farmer`);

  // ---------- 3. complaint -> investigation -> trial ----------
  t+=30000;justice.complain('merchant','scout','Wren shoved past me at the warehouse and shouted');
  await justice.tick();
  const inv=board.active().find(o=>o.order_type==='INVESTIGATE_DISPUTE');
  check(inv&&board.preferredOf(inv)==='sheriff','the complaint became an investigation quest for the sheriff');
  check(k.investigation?.status==='open','the investigation is open');
  quests.claim('sheriff',inv.number);
  s=1;   // the dice: the scout lies about where it was
  const heard=justice.interviewees(k);
  check(heard[0]==='merchant'&&heard.includes('farmer'),'the sheriff hears the parties, then the witness');
  for(const who of heard){t+=20000;justice.takeStatement(k,who,'sheriff');}
  const lie=k.evidence.find(e=>e.kind==='statement'&&e.by==='scout'&&e.claim&&Math.hypot(e.claim.place.x-k.location.x,e.claim.place.z-k.location.z)>16);
  steps.push(`statements: ${k.evidence.filter(e=>e.kind==='statement').map(e=>`${e.by} "${e.text}"`).join(' | ')}`);
  const trial=justice.fileFindings(k,'sheriff');quests.progress('sheriff',inv.number,1);await quests.turnIn('sheriff',inv.number);
  check(trial&&!Number.isNaN(Date.parse(trial.scheduled_at)),'a trial is scheduled');
  check(board.get(inv.order_id).status==='VERIFIED','the sheriff is paid for the investigation');
  await justice.tick();check(!k.trial.held,'the trial waits for its time');
  t+=130000;await justice.tick();await new Promise(r=>setTimeout(r,10));
  check(k.trial.held&&k.status==='TRIED','the trial was held and the conflict is TRIED');
  check(k.verdict?.fault==='scout','the magistrate found the scout at fault');
  if(lie)check(k.verdict.findings.some(f=>/said they were at .* but farmer saw them at the scene/.test(f)),'the lie was caught by the timestamped sighting');
  check(k.verdict.outcome==='fine'&&paid.some(p=>p.from==='scout'&&p.to==='treasury'),'first offence: a fine paid into the treasury');
  const service=board.active().find(o=>o.order_type==='COMMUNITY_SERVICE'&&JSON.parse(o.target_location).assigned==='scout');
  check(!!service,'and community service for the scout');
  steps.push(`trial ${k.conflict_id}: ${k.verdict.outcome}, fault ${k.verdict.fault} (${k.verdict.confidence}); ${k.verdict.findings.join('; ')}`);
  // The scout serves the sentence: the case is resolved.
  quests.claim('scout',service.number);quests.progress('scout',service.number,service.quantity);await quests.turnIn('scout',service.number);
  justice.onServiceDone('scout',board.get(service.order_id));
  check(k.status==='RESOLVED','after the service the conflict is RESOLVED');

  // ---------- 4. theft -> warrant -> jail -> release; a pardon ----------
  snap={...snap,agents:snap.agents.map(a=>a.id==='smith'?{...a,x:283,z:107}:a)};   // the smith by the warehouse at night
  const theft=justice.openConflict({a:'governor',b:'smith',kind:'theft',reason:'5 emeralds missing from the treasury',location:{x:286,y:64,z:107},truth:{culprit:'smith'},extra:{amount:5,scene:'warehouse'}});
  justice.complain('governor','smith','5 emeralds are missing from the treasury',{kind:'theft'});
  await justice.tick();
  for(const who of justice.interviewees(theft))justice.takeStatement(theft,who,'sheriff');
  justice.fileFindings(theft,'sheriff');t+=130000;await justice.tick();await new Promise(r=>setTimeout(r,10));
  check(theft.verdict?.outcome==='jail'&&theft.verdict.guilty==='smith','the thief is sentenced to jail');
  check(theft.verdict.findings.some(f=>/treasury chest was opened by/.test(f)),'the treasury record is evidence');
  check(justice.warrants().some(w=>w.suspect==='smith'),'a warrant is out for the smith');
  justice.detain('smith','sheriff');check(justice.restricted('smith'),'the detained smith is restricted');
  const rec=await justice.imprison('smith',{by:'sheriff'});
  check(rec&&rec.jailed_citizen_id==='smith'&&rec.sentence_duration_ticks===rec.remaining_ticks&&rec.sentence_duration_ticks>0&&rec.reason,'jail record {jailed_citizen_id, sentence_duration_ticks, remaining_ticks, reason}');
  check(confined.some(c=>c.id==='smith'),'the plugin was told to confine the smith');
  check(justice.restricted('smith')&&!!justice.jailJob({id:'smith'},{needs:{hunger:20}},{x:0,z:0,inventory:{}}),'the jailed smith gets only the jail job');
  steps.push(`theft ${theft.conflict_id}: smith jailed for ${rec.sentence_duration_ticks} ticks (${Math.round(rec.sentence_duration_ticks/1200)} min)`);
  // Half the sentence passes: still inside; the rest: released.
  t+=rec.sentence_duration_ticks/2/20*1000;await justice.tick();
  check(justice.jailed('smith')&&justice.jailed('smith').remaining_ticks<rec.sentence_duration_ticks,'the sentence counts down in ticks');
  for(let i=0;i<20&&justice.jailed('smith');i++){t+=60000;await justice.tick();}
  check(!justice.jailed('smith')&&!justice.restricted('smith'),'released when the sentence is over');
  check(theft.status==='RESOLVED','the theft case is RESOLVED once served');
  // A second dispute for the scout (a prior conviction): jail, then the mayor pardons.
  const again=justice.openConflict({a:'farmer',b:'scout',reason:'trampled crops',truth:{instigator:'scout'}});
  addWitnessProvocation(again);
  justice.complain('farmer','scout','Wren trampled my wheat');await justice.tick();
  for(const who of justice.interviewees(again))justice.takeStatement(again,who,'sheriff');
  justice.fileFindings(again,'sheriff');t+=130000;await justice.tick();await new Promise(r=>setTimeout(r,10));
  check(again.verdict?.outcome==='jail','a repeat offender goes to jail');
  check(again.verdict.findings.some(f=>/said they were at .* but \w+ saw them at the scene/.test(f)),'a false alibi is caught by a sighting at the same minute');
  steps.push(`trial ${again.conflict_id}: ${again.verdict.outcome} (${again.verdict.findings[0]})`);
  await justice.imprison('scout',{by:'sheriff'});
  await justice.pardonCitizen('scout','jrmym1981');
  check(!justice.jailed('scout')&&again.status==='RESOLVED','a pardon releases at once and resolves the case');
  // Evidence weighing alone: no witnesses and conflicting stories -> no verdict.
  const blank={conflict_id:'C-999',timestamp:new Date(t).toISOString(),party_a:'a',party_b:'b',location:{x:0,z:0},evidence:[]};
  check(weighEvidence(blank).fault===null,'no evidence, no fault');
  check(migrateConflict({id:'9',a:'x',b:'y',topic:'t',day:1,resolved:true}).status==='RESOLVED','migration keeps resolved ones resolved');
  return {failures,steps,said:said.slice(-6)};

  function addWitnessProvocation(c){c.evidence.push({kind:'provocation',by:'farmer',about:'scout',timestamp:c.timestamp,tick:c.tick,location:c.location,text:'Wren started it'});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();
  for(const st of r.steps)console.log('-',st);
  console.log('\nLast words in town:\n  '+r.said.join('\n  '));
  if(r.failures.length){console.log('\nFAILED:\n - '+r.failures.join('\n - '));process.exit(1);}
  console.log('\nAll checks passed: quests post/claim/complete/pay, timestamped disputes, investigation -> trial -> sentence, jail and pardon.');
}
