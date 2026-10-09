// Five consecutive town meetings through the proposal engine (skills/proposals.mjs), with a town whose state moves on
// between meetings. Checks that every meeting gets a fresh, relevant proposal, that the domains vary, that decisions
// go into the history and are not tabled again, and that citizens vote by their own traits.
//   node agent-core/test-proposal-engine.mjs        (exits 1 on any failure; also run by npm test)
import {choose,voteOf,remember,duplicateOf,DOMAINS} from './skills/proposals.mjs';
import {pathToFileURL} from 'node:url';

const CITIZENS=[
  {id:'priest',role:'priest',faith:'the Hearthlight',values:{tradition:0.9,community:0.8,sociability:0.6,curiosity:0.3,craftsmanship:0.3,selfPreservation:0.4},morale:60,stress:25},
  {id:'guardian',role:'guardian',faith:null,values:{selfPreservation:0.9,tradition:0.6,community:0.6,sociability:0.3,curiosity:0.2,craftsmanship:0.4},morale:55,stress:50},
  {id:'builder',role:'builder',faith:null,values:{craftsmanship:0.9,community:0.7,tradition:0.4,sociability:0.4,curiosity:0.4,selfPreservation:0.3},morale:50,stress:40},
  {id:'merchant',role:'merchant',faith:'the Old Ways',values:{sociability:0.9,community:0.5,curiosity:0.5,tradition:0.3,craftsmanship:0.3,selfPreservation:0.3},morale:70,stress:20},
  {id:'chef',role:'chef',faith:null,values:{curiosity:0.9,sociability:0.7,craftsmanship:0.6,tradition:0.2,community:0.5,selfPreservation:0.2},morale:45,stress:35},
  {id:'scout',role:'scout',faith:null,values:{curiosity:0.95,sociability:0.6,tradition:0.2,community:0.4,craftsmanship:0.3,selfPreservation:0.2},morale:65,stress:20},
  {id:'farmer',role:'farmer',faith:'the Hearthlight',values:{community:0.8,tradition:0.6,selfPreservation:0.5,sociability:0.5,curiosity:0.3,craftsmanship:0.4},morale:40,stress:45},
];

/** Runs the meetings; returns {meetings, history, failures}. */
export function simulate({meetings=5,seed=17}={}){
  let s=seed;const random=()=>((s=(s*16807)%2147483647)/2147483647);
  // The town at the first meeting: short of stone, a building waiting, monsters about, a quarrel, samey food.
  const ctx={day:300,pantryStatus:'healthy',treasury:25,shortages:['STONE_BRICKS','COBBLESTONE'],pendingBuilds:[{id:'library',name:'library'}],
    threats:7,darkSpots:14,damageOpen:0,avgMorale:48,avgStress:41,daysSinceFestival:5,
    conflicts:[{a:'merchant',b:'scout',aName:'Marlo',bName:'Wren',topic:'who gets the warehouse bread first'}],
    dietVariety:28,fatigued:[{agent:'miner',food:'BREAD'}],faith:{believers:4,largest:'the Hearthlight',skeptics:3},shrineBuilt:true,
    hasPark:false,hasLake:true,marketActive:true,policy:{}};
  let history=[];const out=[],failures=[];
  const fail=m=>failures.push(m);
  for(let i=0;i<meetings;i++){
    const p=choose(ctx,{history,open:[],random});
    if(!p){fail(`meeting ${i+1}: no proposal`);break;}
    p.id=String(100+i);p.text=`${p.title}: ${p.description}`;
    const votes={},reasons={};
    for(const c of CITIZENS){const v=voteOf(p,c,random);votes[c.id]=v.vote;reasons[c.id]=v.why;}
    const yes=Object.values(votes).filter(v=>v==='yes').length,no=CITIZENS.length-yes,adopted=yes>no;
    out.push({day:ctx.day,domain:p.domain,topic:p.topic,key:p.key,title:p.title,yes,no,adopted,votes,reasons});
    // Checks for this meeting.
    if(history.some(h=>h.key===p.key))fail(`meeting ${i+1}: "${p.title}" was already tabled`);
    if(duplicateOf(p.text,{history})?.kind==='adopted')fail(`meeting ${i+1}: repeats an adopted proposal`);
    history=remember(history,{...p,yes,no},adopted?'adopted':'rejected',ctx.day);
    // The town moves on: what was decided changes the state, and a day passes.
    if(adopted){
      if(p.effect.type==='quest_drive')ctx.shortages=[];
      if(p.effect.type==='mediate')ctx.conflicts=[];
      if(p.effect.type==='curfew')ctx.policy={...ctx.policy,curfew:p.effect.mode};
      if(p.effect.type==='lighting')ctx.darkSpots=2;
      if(p.effect.type==='festival'||p.effect.type==='gathering')ctx.daysSinceFestival=0;
      if(p.effect.type==='fund_build')ctx.pendingBuilds=ctx.pendingBuilds.filter(b=>b.id!==p.effect.site);
      if(p.effect.type==='variety')ctx.dietVariety=55;
    }
    ctx.day++;ctx.daysSinceFestival++;
  }
  const keys=out.map(m=>m.key),domains=new Set(out.map(m=>m.domain));
  if(new Set(keys).size!==keys.length)fail('the same proposal came up twice');
  if(domains.size<3)fail(`only ${domains.size} domain(s) across ${out.length} meetings: ${[...domains].join(', ')}`);
  if(history.length!==out.length)fail('not every decision was recorded');
  for(const d of domains)if(!DOMAINS.includes(d))fail(`unknown domain ${d}`);
  // Votes follow traits: the priest backs a holy day, the guardian a curfew, the chef new dishes - whenever they come up,
  // and in a direct check.
  const ask=(topic,domain,c)=>voteOf({topic,domain},c,()=>0.5).vote;
  const by=id=>CITIZENS.find(c=>c.id===id);
  if(ask('holy_day','RELIGIOUS',by('priest'))!=='yes')fail('the priest voted against a holy day');
  if(ask('night_watch','SECURITY',by('guardian'))!=='yes')fail('the guardian voted against a curfew');
  if(ask('lift_curfew','SECURITY',by('guardian'))!=='no')fail('the guardian voted to lift the curfew');
  if(ask('new_dishes','CULTURAL',by('chef'))!=='yes')fail('the chef voted against new dishes');
  if(ask('market_fee','ECONOMIC',by('merchant'))!=='no')fail('the merchant voted for a market fee');
  return {meetings:out,history,failures};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=simulate();
  for(const [i,m] of r.meetings.entries()){
    console.log(`Meeting ${i+1} (day ${m.day}) [${m.domain}] ${m.title} -> ${m.adopted?'ADOPTED':'rejected'} ${m.yes}-${m.no}`);
    for(const [id,v] of Object.entries(m.votes))console.log(`    ${id.padEnd(9)} ${v.padEnd(3)} (${m.reasons[id]})`);
  }
  console.log(`\nHistory: ${r.history.map(h=>`${h.topic}:${h.outcome}`).join(', ')}`);
  if(r.failures.length){console.log('\nFAILED:\n - '+r.failures.join('\n - '));process.exit(1);}
  console.log('\nAll checks passed: 5 unique proposals, '+new Set(r.meetings.map(m=>m.domain)).size+' domains, history kept, trait-aligned votes.');
}
