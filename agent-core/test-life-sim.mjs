// A full in-game day for five citizens through the life-simulation layer (lifesim.mjs), with the real needs rules,
// the real gossip and relationship engines (intel/social.mjs on in-memory sqlite) and a scripted world:
//   - needs decay over the day and drive breakfast, eating and rest
//   - at DUSK_SOCIAL everyone walks to the gathering place, and a rumor about the Banker spreads and gets distorted
//   - a vote against a proposal and a trial leave lasting grudges (and favours) in the relationship matrix
//   - at NIGHT_REST everyone ends the day in their own bed; private chests: own / sheriff's search / theft
//   node agent-core/test-life-sim.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {openDatabase} from './intel/db.mjs';
import {createSocial} from './intel/social.mjs';
import {createLifeSim} from './lifesim.mjs';
import {updateNeeds} from './town.mjs';
import {needsOf,drives,moodOf,schedulePhase} from './skills/needs.mjs';

const CITIZENS=[
  {id:'farmer',role:'farmer',name:'Hazel the Farmer'},{id:'scout',role:'scout',name:'Wren the Scout'},{id:'merchant',role:'merchant',name:'Marlo the Trader'},
  {id:'banker',role:'banker',name:'Finneas the Vault Keeper'},{id:'builder',role:'builder',name:'Bram the Builder'},
];
const LOTS={farmer:{x:294,z:95,door:'east'},scout:{x:294,z:100,door:'east'},merchant:{x:304,z:81,door:'west'},banker:{x:294,z:107,door:'east'},builder:{x:294,z:81,door:'east'}};

export async function simulate({seed=11}={}){
  const failures=[],steps=[];const check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=Date.parse('2026-10-02T06:00:00Z');const now=()=>t;
  let s=seed;const random=()=>((s=(s*16807)%2147483647)/2147483647);
  const db=openDatabase(':memory:'),social=createSocial(db,{now});
  const memory={data:{town:{day:301,built:{}},agents:Object.fromEntries(CITIZENS.map(c=>[c.id,{needs:{hunger:14,energy:70}}]))}};
  const pos=Object.fromEntries(CITIZENS.map((c,i)=>[c.id,{id:c.id,x:260+i*4,y:64,z:90,health:20,inventory:{BREAD:3}}]));
  let worldTime=0;const snap=()=>({worldTime,weather:{},agents:Object.values(pos)});
  const said=[],ate=[],logs=[];
  const log=(type,data)=>{logs.push({type,...data});};
  const lifesim=createLifeSim({memory,configs:CITIZENS,act:async(id,a)=>{if(a.type==='scan')return {cells:[[a.x,65,a.z,'RED_BED',false]]};return {ok:true};},say:async(id,x)=>said.push(`${id}: ${x}`),log,ledger:()=>{},
    getSnapshot:snap,now,random,social:()=>social,nameOf:id=>CITIZENS.find(c=>c.id===id)?.name.split(' the ')[0]??id,
    homeOf:id=>LOTS[id],homeBuilt:()=>true,valuesOf:()=>({sociability:0.9,community:0.6}),   // a sociable crowd: everyone comes tonight
tavernSpot:()=>null,affectOf:()=>({morale:55,stress:30}),
    travel:async(id,self,to)=>{Object.assign(pos[id],{x:to.x,z:to.z});},   // walking is instant in the test
    eatJob:async c=>{const st=memory.data.agents[c.id];st.needs={...st.needs,hunger:20};ate.push({id:c.id,worldTime});},
    befriend:(a,b,n)=>social.adjust(a,b,{trust:n},'gathering','spent the evening together'),
    justice:()=>({openConflict:x=>({conflict_id:'C-100',...x}),complain:()=>{}}),warrantsFor:()=>['merchant']});

  // The scout distrusts the Banker (a fee went wrong last week) - so the story will grow in the telling.
  social.mark('scout','banker','grudge','charged me a fee twice',0.6);
  const r0=lifesim.seed('bank_error',{subject:'banker',origin:'scout'});
  check(r0&&r0.veracity===1&&r0.details==='Finneas booked a fee wrong at the bank','a true rumor is seeded from the event');

  // ---------- the day: 24000 ticks in steps of 200 (10 s of real time each) ----------
  const phasesSeen=new Set(),hubVisits={};let peakHunger=0,peakFatigue=0,ateWhenHungry=0;
  for(let step=0;step<=120;step++){
    worldTime=step*200;t+=10000;
    const phase=schedulePhase(worldTime);phasesSeen.add(phase);
    for(const c of CITIZENS){
      const st=memory.data.agents[c.id];
      // The civic needs loop: work burns food and energy (the builder does heavy work), night restores energy.
      st.resting=phase==='NIGHT_REST';
      // Real time per 200 ticks with the plugin's clock: 30 s by day (12000 ticks in 30 min), 5 s by night.
      st.needs=updateNeeds(st.needs,worldTime<12000?30:5,{working:phase==='WORK_SHIFT'?(c.id==='builder'?'heavy':true):false,resting:st.resting});
      const n=needsOf(st.needs);peakHunger=Math.max(peakHunger,n.hunger);peakFatigue=Math.max(peakFatigue,n.fatigue);
      // A hungry citizen eats (the runtime's eat jobs); count it when the drive asked for it.
      if(drives(n).includes('eat')){ateWhenHungry++;st.needs={...st.needs,hunger:20};}
      const job=lifesim.job(c,st,pos[c.id],phase==='NIGHT_REST');
      if(job)await job();
      if(phase==='DUSK_SOCIAL'&&Math.hypot(pos[c.id].x-lifesim.hub().x,pos[c.id].z-lifesim.hub().z)<=4)hubVisits[c.id]=true;
      // NIGHT_REST: the runtime walks each citizen to the bed in its own dwelling.
      if(phase==='NIGHT_REST'){const bed=lifesim.dwelling(c.id).bed_coordinates;Object.assign(pos[c.id],{x:bed.x+0.5,z:bed.z+0.5});}
    }
    lifesim.tick();
    // At the gathering people mingle every 45 s; move the clock on so they get the chance.
    if(phase==='DUSK_SOCIAL')for(const c of CITIZENS)memory.data.agents[c.id].lastMingle=0;
  }
  check(['DAWN_PREP','WORK_SHIFT','DUSK_SOCIAL','NIGHT_REST'].every(p=>phasesSeen.has(p)),'all four schedule phases happen in a day');
  check(peakHunger>=0.6&&ateWhenHungry>0,`needs decay (peak hunger ${peakHunger}) and hunger drives eating (${ateWhenHungry} meals)`);
  check(ate.length>=3,`breakfast at DAWN_PREP (${ate.length} citizens)`);
  check(peakFatigue>0.3,`work tires citizens (peak fatigue ${peakFatigue})`);
  const fatigueAfterNight=needsOf(memory.data.agents.builder.needs).fatigue;
  check(fatigueAfterNight<0.5,`a night in bed restores energy (builder fatigue ${fatigueAfterNight})`);
  steps.push(`needs: peak hunger ${peakHunger}, peak fatigue ${peakFatigue}; breakfasts ${ate.length}, meals when hungry ${ateWhenHungry}`);

  // ---------- the gathering and the rumor ----------
  check(Object.keys(hubVisits).length===5,`everyone came to ${lifesim.hub().name} at dusk (${Object.keys(hubVisits).join(', ')})`);
  check(lifesim.state.gatherings[0]?.people.length===5,'the gathering is recorded with all five');
  const {joinsGathering}=await import('./skills/traits.mjs');
  const shyNights=[...Array(30).keys()].filter(day=>!joinsGathering({sociability:0.1},day,'hermit')).length;
  check(shyNights>=10&&shyNights<30,`a reserved citizen skips some evenings (${shyNights} of 30)`);
  const heard=CITIZENS.filter(c=>lifesim.rumorsOf(c.id).some(r=>r.id===r0.id));
  check(heard.length>=4,`the rumor spread at the gathering (${heard.length} of 5 know it)`);
  const copies=CITIZENS.flatMap(c=>lifesim.rumorsOf(c.id).filter(r=>r.id===r0.id));
  const worst=copies.sort((a,b)=>b.level-a.level)[0];
  check(worst.level>0&&worst.veracity<1,`the rumor got distorted on the way ("${worst.details}", veracity ${worst.veracity})`);
  check(logs.some(l=>l.type==='rumor_spread'&&l.distorted),'a distortion is logged');
  check(social.view(heard.find(c=>c.id!=='scout'&&c.id!=='banker')?.id??'farmer','banker').trust_score<50,'believing the rumor lowered trust in the Banker');
  steps.push(`rumor ${r0.id}: "${r0.details}" -> "${worst.details}" (veracity ${worst.veracity}, ${worst.hops} retellings)`);
  steps.push(`said at the gathering: ${said.filter(x=>/did you hear/.test(x)).slice(0,2).join(' | ')}`);

  // ---------- grudges that last ----------
  lifesim.onVote('merchant','farmer','no',{id:'31',title:'a market fee'});
  lifesim.onVote('merchant','builder','yes',{id:'31',title:'a market fee'});
  const rel=social.relationship('merchant','farmer');
  check(rel.grudges.some(g=>/voted against my proposal #31/.test(g.reason))&&rel.trust<0,'a vote against leaves a grudge (and lowers trust)');
  check(social.relationship('merchant','builder').favors.length===1,'a vote for leaves a favour');
  lifesim.onEvent('trial_held',{conflict_id:'C-007',fault:'scout',magistrate:'banker'});   // no conflict record: no rumor, but the call is safe
  const conflicts={'C-008':{conflict_id:'C-008',kind:'dispute',party_a:'farmer',party_b:'scout',reason:'trampled wheat',evidence:[]}};
  const withCourt=createLifeSim({memory,configs:CITIZENS,act:async()=>({}),say:async()=>{},log,ledger:()=>{},getSnapshot:snap,now,random,social:()=>social,conflict:id=>conflicts[id]});
  withCourt.onEvent('trial_held',{conflict_id:'C-008',fault:'scout',magistrate:'banker'});
  check(social.relationship('scout','farmer').grudges.some(g=>/took me to court/.test(g.reason)),'the convicted party holds a grudge against the one who took them to court');
  check(social.relationship('farmer','banker').favors.some(f=>/gave me justice/.test(f.reason)),'the wronged party owes the magistrate a favour');
  t+=12*3600000;   // half a real day later the grudge has faded but is still remembered
  const later=social.relationship('merchant','farmer');
  check(later.grudges.length===1&&later.affinity>rel.affinity,'grudges stay on record while their sting fades');
  steps.push(`relationships: merchant->farmer ${JSON.stringify(later)}`);

  // ---------- every citizen in their own bed; private chests ----------
  const beds=CITIZENS.map(c=>lifesim.dwelling(c.id).bed_coordinates);
  check(new Set(beds.map(b=>`${b.x},${b.z}`)).size===5,'five different beds');
  check(CITIZENS.every(c=>{const b=lifesim.dwelling(c.id).bed_coordinates,l=LOTS[c.id];return Math.hypot(pos[c.id].x-(b.x+0.5),pos[c.id].z-(b.z+0.5))<1&&b.x>l.x&&b.x<l.x+4&&b.z>l.z&&b.z<l.z+4;}),'each citizen ended the night in the bed inside their own house');
  check(CITIZENS.every(c=>lifesim.dwelling(c.id).dwelling_id===`D-${c.id}`),'dwellings have ids');
  for(const c of CITIZENS){const ch=lifesim.dwelling(c.id).private_chest_coordinates;lifesim.state.chests[c.id]={x:ch.x,y:65,z:ch.z,registered:true};}
  const at=id=>{const ch=lifesim.state.chests[id];return {x:ch.x+0.5,y:65,z:ch.z+0.5};};
  check((await lifesim.chestAction('farmer',{type:'stash',target:'WHEAT',count:5},at('farmer'))).access==='own','a citizen uses their own chest');
  check((await lifesim.chestAction('scout',{type:'take_from_chest',to:'merchant',target:'EMERALD',count:2},{...at('merchant'),id:'scout'})).access==='theft','taking from another citizen\'s chest is theft');
  check(logs.some(l=>l.type==='chest_theft'&&l.thief==='scout'&&l.owner==='merchant'),'the theft is recorded for the court');
  let refused=null;try{await lifesim.chestAction('farmer',{type:'stash',target:'WHEAT',count:1},{x:0,y:65,z:0});}catch(e){refused=e.message;}
  check(/Walk to the chest/.test(refused),'chests are used in person');

  // ---------- mood in the prompt ----------
  const m=moodOf({hunger:0.9,fatigue:0.85,socialization:0.3,comfort:0.2});
  check(/exhausted \(Fatigue: 85%\) and starving \(Hunger: 90%\)/.test(m.text)&&/irritable/.test(m.text)&&m.irritable&&m.voteBias<0&&m.persuadability<1,'a starving, exhausted citizen is irritable in the prompt and in judgement');
  const ctx=lifesim.context(CITIZENS[0]);
  check(/^CURRENT STATE:/.test(ctx.currentState)&&ctx.schedule_phase&&ctx.dwelling.id==='D-farmer','the planning context carries state, phase and dwelling');
  return {failures,steps};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();
  for(const s of r.steps)console.log('-',s);
  if(r.failures.length){console.log('\nFAILED:\n - '+r.failures.join('\n - '));process.exit(1);}
  console.log('\nAll checks passed: needs and schedule, the gathering and a distorted rumor, lasting grudges, own beds and private chests.');
}
