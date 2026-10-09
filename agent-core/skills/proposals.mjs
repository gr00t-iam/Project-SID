// The proposal engine: what the town votes on at its meetings, drawn from what is actually going on.
//
// Before a meeting, synthesize(ctx) turns the town's state (stock and shortages, pending builds, threats and damage,
// morale and stress, food fatigue and cravings, faith and festivals, treasury and wages, conflicts) into candidate
// proposals in six domains. choose() picks one that is relevant, not a repeat of anything open, adopted or recently
// decided, and preferably from a domain the last meetings did not cover. Each citizen then votes by its own values,
// role, faith and mood (voteOf), and an adopted proposal carries an effect the civic module applies.
// Pure functions: no game, no model, no clock of its own - tested in tests/proposals.test.mjs.

export const DOMAINS=Object.freeze(['MUNICIPAL','ECONOMIC','CULTURAL','RELIGIOUS','SECURITY','LEISURE']);
export const HISTORY_SIZE=20;
const DAY=1;   // topics are spaced in town days

const label=x=>String(x??'').toLowerCase().replace(/_/g,' ');
const list=a=>a.length<=1?a.join(''):`${a.slice(0,-1).join(', ')} and ${a.at(-1)}`;

/**
 * The topics. Each: domain, when(ctx) -> relevance 0-1 (0 = not now), make(ctx) -> {title, description, pros, cons,
 * effect}, and appeal: which values (cognition.mjs: community, sociability, curiosity, craftsmanship, tradition,
 * selfPreservation), roles and faiths lean towards it (negative = against). cooldown: days before the same topic again.
 */
export const TOPICS=[
  // ---- MUNICIPAL ----
  {topic:'fund_build',domain:'MUNICIPAL',cooldown:2,
    when:c=>c.pendingBuilds?.length?0.6+Math.min(0.3,c.pendingBuilds.length*0.05):0,
    make:c=>{const b=c.pendingBuilds[0];return {key:`fund_build:${b.id}`,title:`Build the ${b.name} next`,
      description:`The ${b.name} is unlocked but nobody has funded it. Should the builder start on it once the current work is done?`,
      pros:['a new public building','work for the builder and the crafters'],cons:['uses stone and timber the warehouse is short of'],
      effect:{type:'fund_build',site:b.id,name:b.name}};},
    appeal:{values:{community:0.6,craftsmanship:0.5,tradition:0.2},roles:{builder:0.6,governor:0.3,crafter:0.3,lumberjack:0.2},faith:{}}},
  {topic:'storage',domain:'MUNICIPAL',cooldown:3,
    when:c=>c.warehouseFull?0.8:0,
    make:c=>({title:'More storage in the warehouse',description:`${c.warehouseFull} of the warehouse chests are full, so deposits are being turned away. Add another chest row?`,
      pros:['food and goods stop piling up in pockets'],cons:['costs planks'],effect:{type:'storage'}}),
    appeal:{values:{community:0.4,craftsmanship:0.4},roles:{courier:0.6,crafter:0.4,farmer:0.3,merchant:0.4},faith:{}}},
  {topic:'tidy_roads',domain:'MUNICIPAL',cooldown:4,
    when:c=>c.roadsPending?0.45:0,
    make:c=>({title:`Finish the road: ${c.roadsPending}`,description:`The next road on the plan (${c.roadsPending}) is still unbuilt. Put it ahead of other work?`,
      pros:['faster walks between farms, mine and warehouse'],cons:['delays a building'],effect:{type:'road'}}),
    appeal:{values:{community:0.5,curiosity:0.2},roles:{courier:0.7,scout:0.5,merchant:0.3,builder:0.2},faith:{}}},
  // ---- ECONOMIC ----
  {topic:'materials_drive',domain:'ECONOMIC',cooldown:2,
    when:c=>c.shortages?.length?0.7+Math.min(0.2,c.shortages.length*0.05):0,
    make:c=>({key:`materials_drive:${c.shortages.slice(0,2).join('+')}`,title:`A drive for ${list(c.shortages.slice(0,2).map(label))}`,
      description:`The warehouse is out of ${list(c.shortages.slice(0,3).map(label))}, and building has stalled. Offer a bounty and have the miner and lumberjack put it first?`,
      pros:['stalled buildings get going again'],cons:['bounties come out of the treasury'],effect:{type:'quest_drive',items:c.shortages.slice(0,3)}}),
    appeal:{values:{community:0.5,craftsmanship:0.4},roles:{builder:0.6,crafter:0.4,miner:0.3,lumberjack:0.3,governor:0.3},faith:{}}},
  {topic:'raise_wages',domain:'ECONOMIC',cooldown:4,
    when:c=>c.avgMorale<55&&c.treasury>=40?0.55:c.treasury>=120?0.4:0,
    make:c=>({title:'Raise the daily wage',description:`The treasury holds ${c.treasury} emeralds while morale is ${c.avgMorale}. Pay everyone half again as much each day?`,
      pros:['more money to spend at the market','better spirits'],cons:['the treasury empties faster'],effect:{type:'wages',multiplier:1.5}}),
    appeal:{values:{community:0.3,sociability:0.4,selfPreservation:0.2},roles:{merchant:-0.3,governor:-0.2,scribe:-0.1},faith:{}}},
  {topic:'save_treasury',domain:'ECONOMIC',cooldown:4,
    when:c=>c.treasury<10?0.6:0,
    make:c=>({title:'Tighten the purse strings',description:`Only ${c.treasury} emeralds are left in the treasury. Pay smaller wages until it recovers?`,
      pros:['the town can still pay bounties and emergencies'],cons:['less money in everyone\'s pocket'],effect:{type:'wages',multiplier:0.5}}),
    appeal:{values:{tradition:0.3,selfPreservation:0.3,sociability:-0.4},roles:{merchant:0.5,governor:0.4,scribe:0.3},faith:{}}},
  {topic:'market_fee',domain:'ECONOMIC',cooldown:5,
    when:c=>c.treasury<40&&c.marketActive?0.45:0,
    make:c=>({title:'A small market fee',description:'Charge one emerald in ten on market sales, paid into the treasury for wages and bounties?',
      pros:['a steady income for the town'],cons:['traders keep less'],effect:{type:'market_fee',rate:0.1}}),
    appeal:{values:{community:0.4,tradition:0.2,sociability:-0.2},roles:{merchant:-0.7,governor:0.5,scribe:0.3},faith:{}}},
  {topic:'food_reserve',domain:'ECONOMIC',cooldown:3,
    when:c=>c.pantryStatus&&c.pantryStatus!=='healthy'?0.9:0,
    make:c=>({title:'Feed the town first',description:`The pantry is ${c.pantryStatus}. Pause new buildings and pay a bonus to the farmer, fisher and chef until it recovers?`,
      pros:['nobody goes hungry'],cons:['building waits'],effect:{type:'food_first'}}),
    appeal:{values:{selfPreservation:0.6,community:0.5},roles:{farmer:0.4,fisher:0.4,chef:0.5,builder:-0.4},faith:{'the Hearthlight':0.2}}},
  // ---- SECURITY ----
  {topic:'night_watch',domain:'SECURITY',cooldown:3,
    when:c=>c.threats>=6?0.7:c.threats>=3?0.45:0,
    make:c=>({title:'An earlier curfew',description:`${c.threats} monster attacks this week. Ring the curfew bell every evening, not only on bad nights?`,
      pros:['fewer people caught outside at dusk'],cons:['less time for evening work and visits'],effect:{type:'curfew',mode:'always'}}),
    appeal:{values:{selfPreservation:0.7,tradition:0.2,sociability:-0.3,curiosity:-0.2},roles:{guardian:0.8,scout:-0.3,fisher:-0.2},faith:{}}},
  {topic:'lift_curfew',domain:'SECURITY',cooldown:4,
    when:c=>c.policy?.curfew==='always'&&c.threats<3?0.6:0,
    make:c=>({title:'Lift the standing curfew',description:'It has been a quiet week. Go back to ringing the bell only when danger is near?',
      pros:['evenings free again'],cons:['a risk if the monsters return'],effect:{type:'curfew',mode:'normal'}}),
    appeal:{values:{sociability:0.5,curiosity:0.3,selfPreservation:-0.4},roles:{guardian:-0.5,scout:0.4,fisher:0.3},faith:{}}},
  {topic:'light_streets',domain:'SECURITY',cooldown:3,
    when:c=>c.darkSpots>=8?0.6:c.darkSpots>0?0.3:0,
    make:c=>({title:'Light every dark corner',description:`${c.darkSpots} dark spots in town are left where monsters can spawn. Have the guardian, scout and courier put up torches until they are gone?`,
      pros:['no monsters spawning among the houses'],cons:['uses torches and coal'],effect:{type:'lighting'}}),
    appeal:{values:{selfPreservation:0.6,community:0.4},roles:{guardian:0.5,scout:0.2},faith:{'the Hearthlight':0.3}}},
  {topic:'repair_crews',domain:'SECURITY',cooldown:2,
    when:c=>c.damageOpen>=10?0.75:0,
    make:c=>({title:'Everyone helps with repairs',description:`${c.damageOpen} blocks of damage are still open after the last attack. Let every free hand help the builder patch them today?`,
      pros:['the walls are whole by nightfall'],cons:['other work waits a few hours'],effect:{type:'repairs'}}),
    appeal:{values:{community:0.6,selfPreservation:0.5},roles:{builder:0.5,guardian:0.4},faith:{}}},
  // ---- CULTURAL ----
  {topic:'festival',domain:'CULTURAL',cooldown:3,
    when:c=>(c.daysSinceFestival??9)>=3?0.5+(c.avgMorale<50?0.2:0):0,
    make:c=>({title:'A town festival on the square',description:`It has been ${c.daysSinceFestival??'many'} days since the last celebration. Hold a festival on the square tomorrow?`,
      pros:['friendships and spirits grow','a break from work'],cons:['a morning of work lost'],effect:{type:'festival',kind:'town festival'}}),
    appeal:{values:{sociability:0.7,community:0.5,tradition:0.3,selfPreservation:-0.1},roles:{priest:0.3,chef:0.4,merchant:0.3,guardian:-0.2},faith:{}}},
  {topic:'mediation',domain:'CULTURAL',cooldown:2,
    when:c=>c.conflicts?.length?0.65:0,
    make:c=>{const k=c.conflicts[0];return {key:`mediation:${k.a}:${k.b}`,title:`Settle the quarrel between ${k.aName} and ${k.bName}`,
      description:`${k.aName} and ${k.bName} have been arguing about ${k.topic}. Ask the governor to sit them down and settle it?`,
      pros:['peace in town'],cons:['someone may feel overruled'],effect:{type:'mediate',a:k.a,b:k.b}};},
    appeal:{values:{community:0.6,sociability:0.4,tradition:0.2},roles:{governor:0.5,priest:0.4},faith:{'the Hearthlight':0.2}}},
  {topic:'new_dishes',domain:'CULTURAL',cooldown:3,
    when:c=>c.dietVariety!=null&&c.dietVariety<40?0.6:0,
    make:c=>({title:'A week of new dishes',description:`Meals have been samey (variety ${c.dietVariety}/100${c.fatigued?.length?`; ${c.fatigued.length} are tired of ${label(c.fatigued[0].food)}`:''}). Ask Chef Antoine to try new recipes and the farmers to grow something different?`,
      pros:['better meals','happier citizens'],cons:['ingredients must be found'],effect:{type:'variety'}}),
    appeal:{values:{curiosity:0.6,sociability:0.3,tradition:-0.3},roles:{chef:0.8,farmer:0.2,merchant:0.2},faith:{}}},
  {topic:'story_night',domain:'CULTURAL',cooldown:4,
    when:c=>c.avgMorale<60?0.35:0.2,
    make:c=>({title:'A storytelling night',description:'Gather at the square after work tonight and share stories of the town\'s first days. The scribe will write them into the chronicle.',
      pros:['the town remembers its history'],cons:['a later night'],effect:{type:'gathering',name:'storytelling night'}}),
    appeal:{values:{tradition:0.6,sociability:0.5,curiosity:0.2},roles:{scribe:0.7,priest:0.2},faith:{'the Old Ways':0.4}}},
  // ---- RELIGIOUS ----
  {topic:'holy_day',domain:'RELIGIOUS',cooldown:4,
    when:c=>(c.faith?.believers??0)>=3?0.5:0,
    make:c=>({title:`A ${c.faith.largest} holy day`,description:`${c.faith.believers} citizens keep a faith now. Set aside a day of rest and prayer at the shrine?`,
      pros:['rest, reflection and togetherness'],cons:['a day without building'],effect:{type:'holy_day',faith:c.faith.largest}}),
    appeal:{values:{tradition:0.7,community:0.4,curiosity:-0.2},roles:{priest:0.9,builder:-0.2},faith:{'*':0.6,none:-0.4}}},
  {topic:'shrine',domain:'RELIGIOUS',cooldown:4,
    when:c=>c.shrineBuilt===false?0.55:0,
    make:c=>({title:'Build the shrine',description:'Sister Maren still preaches in the open. Fund the shrine east of the square?',
      pros:['a place for sermons, weddings and quiet'],cons:['stone and wood for a building that does not produce'],effect:{type:'fund_build',site:'shrine',name:'shrine'}}),
    appeal:{values:{tradition:0.6,community:0.3},roles:{priest:0.9,builder:0.2},faith:{'*':0.5,none:-0.3}}},
  {topic:'quiet_hours',domain:'RELIGIOUS',cooldown:5,
    when:c=>(c.faith?.believers??0)>=2&&(c.faith?.skeptics??0)>=2?0.35:0,
    make:c=>({title:'Quiet at the dawn sermon',description:'Keep the square quiet while the dawn sermon is held, so those who pray can, and those who do not can carry on elsewhere.',
      pros:['respect between believers and skeptics'],cons:['the square is closed for a while each morning'],effect:{type:'policy',key:'quietSermon',value:true}}),
    appeal:{values:{tradition:0.4,community:0.3},roles:{priest:0.6,merchant:-0.2},faith:{'*':0.4,none:-0.1}}},
  // ---- LEISURE ----
  {topic:'park',domain:'LEISURE',cooldown:5,
    when:c=>!c.hasPark?0.45:0,
    make:c=>({title:'A park by the square',description:'Set aside the open ground beside the square as a park: flowers, benches and no building, for walks and hobbies.',
      pros:['a beautiful place to rest'],cons:['that land can never be built on'],effect:{type:'park'}}),
    appeal:{values:{sociability:0.5,curiosity:0.3,craftsmanship:-0.1},roles:{herbalist:0.7,priest:0.3,builder:-0.3},faith:{}}},
  {topic:'rest_day',domain:'LEISURE',cooldown:3,
    when:c=>c.avgStress>=45?0.7:c.avgStress>=35?0.4:0,
    make:c=>({title:'A day of rest',description:`Stress across town is ${c.avgStress}/100. Shorten tomorrow's work so everyone can rest, fish or take up a hobby?`,
      pros:['rested, happier citizens'],cons:['a day of less work'],effect:{type:'rest_day'}}),
    appeal:{values:{sociability:0.4,selfPreservation:0.3,craftsmanship:-0.3},roles:{herbalist:0.3,builder:-0.3,governor:-0.1},faith:{}}},
  {topic:'fishing_contest',domain:'LEISURE',cooldown:5,
    when:c=>c.hasLake?0.3:0,
    make:c=>({title:'A fishing contest at the lake',description:'Finley proposes a friendly contest at the lake: the biggest catch wins a pie from Chef Antoine.',
      pros:['fun, and fish for the pantry'],cons:['an afternoon away from work'],effect:{type:'gathering',name:'fishing contest',place:'lake'}}),
    appeal:{values:{sociability:0.5,curiosity:0.3},roles:{fisher:0.9,chef:0.3},faith:{}}},
  {topic:'craft_fair',domain:'LEISURE',cooldown:5,
    when:c=>c.marketActive?0.3:0.2,
    make:c=>({title:'A craft fair on market day',description:'Everyone shows something they made or grew; the best piece gets a place in the town hall.',
      pros:['pride in good work','trade'],cons:['a busy market day'],effect:{type:'gathering',name:'craft fair'}}),
    appeal:{values:{craftsmanship:0.6,sociability:0.4,curiosity:0.2},roles:{crafter:0.6,smith:0.5,merchant:0.5},faith:{}}},
];

// ---------- duplicates ----------
const STOP=new Set('a an the of to and or in on at for with by from is are be it this that we our us town settlement guidelines proposal propose proposing following should let'.split(' '));
export const words=text=>new Set(String(text??'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(w=>w.length>2&&!STOP.has(w)));
/** How alike two texts are: shared words over all words (0-1). */
export function similarity(a,b){
  const x=words(a),y=words(b);if(!x.size||!y.size)return 0;
  let both=0;for(const w of x)if(y.has(w))both++;
  return both/(x.size+y.size-both);
}
/** The open proposal, rule or recent decision a text repeats, if any. */
export function duplicateOf(text,{open=[],rules=[],history=[]}={},threshold=0.5){
  for(const p of open)if(similarity(text,p.text)>=threshold)return {kind:'open',id:p.id,text:p.text};
  for(const r of rules)if(similarity(text,r.text)>=threshold)return {kind:'rule',id:r.id,text:r.text};
  for(const h of history)if(similarity(text,h.title)>=threshold||similarity(text,h.text??'')>=threshold)return {kind:h.outcome??'recent',id:h.id,text:h.title};
  return null;
}

// ---------- choosing ----------
/**
 * All proposals that fit right now, best first. ctx: the town's state (see synthesize in civic). history: past
 * proposals [{key, topic, domain, day, outcome}]; open: open proposals with a key. A topic waits `cooldown` days after
 * it was last tabled, and the domains of the last two meetings count against a candidate (variety).
 */
export function candidates(ctx,{history=[],open=[],random=Math.random}={}){
  const out=[],day=ctx.day??0,recentDomains=history.slice(-2).map(h=>h.domain);
  for(const t of TOPICS){
    let relevance=0;try{relevance=t.when(ctx);}catch{relevance=0;}
    if(!(relevance>0))continue;
    let made;try{made=t.make(ctx);}catch{continue;}
    const key=made.key??t.topic;
    if(open.some(p=>p.key===key||p.topic===t.topic))continue;
    const last=history.filter(h=>h.topic===t.topic).at(-1);
    if(last&&day-last.day<t.cooldown*DAY)continue;
    // Decided recently: adopted ones rest 10 days, rejected ones 5 (the town said no - do not ask again tomorrow).
    if(history.some(h=>h.key===key&&day-h.day<(h.outcome==='adopted'?10:5)))continue;
    const score=relevance-(recentDomains.includes(t.domain)?0.25:0)-(recentDomains.at(-1)===t.domain?0.15:0)+random()*0.15;
    out.push({...made,key,topic:t.topic,domain:t.domain,relevance,score});
  }
  return out.sort((a,b)=>b.score-a.score);
}
/** The one proposal for this meeting (or null when nothing fits). */
export const choose=(ctx,opts)=>candidates(ctx,opts)[0]??null;

// ---------- voting ----------
/**
 * How a citizen votes: its values against the topic's appeal, its role, its faith, and its mood (unhappy citizens back
 * change and rest; stressed ones back safety), plus a little of its own unpredictability. Returns {vote, score, why}.
 * citizen: {id, role, values, faith (name or null), morale, stress, wantsChange}.
 */
export function voteOf(proposal,citizen,random=Math.random){
  const t=TOPICS.find(x=>x.topic===proposal.topic);
  const ap=t?.appeal??{values:{},roles:{},faith:{}},v=citizen.values??{},why=[];
  // Values above the middle pull towards their side; a little caution about change (the status quo) to begin with.
  let score=-0.08;
  for(const [k,w] of Object.entries(ap.values??{})){const d=w*((v[k]??0.5)-0.5)*1.6;score+=d;if(Math.abs(d)>0.12)why.push(`${d>0?'values':'dislikes'} ${k.replace(/[A-Z]/g,c=>' '+c.toLowerCase())}`);}
  const r=ap.roles?.[citizen.role];if(r){score+=r;why.push(`${r>0?'good':'bad'} for a ${citizen.role}`);}
  const f=ap.faith??{},fa=citizen.faith?(f[citizen.faith]??f['*']??0):(f.none??0);
  if(fa){score+=fa;why.push(citizen.faith?`fits ${citizen.faith}`:'not a believer');}
  if(citizen.morale!=null&&citizen.morale<40&&['rest_day','festival','raise_wages','park','story_night'].includes(proposal.topic)){score+=0.3;why.push('needs cheering up');}
  if(citizen.stress!=null&&citizen.stress>=55&&proposal.domain==='SECURITY'){score+=0.3;why.push('feels unsafe');}
  if(citizen.irritable){score-=0.25;why.push('in a foul mood');}
  score+=(random()-0.5)*0.3;
  return {vote:score>=0?'yes':'no',score:Math.round(score*100)/100,why:why.slice(0,2).join(', ')||'a hunch'};
}

/** A history entry (kept to the last HISTORY_SIZE). */
export function remember(history,p,outcome,day){
  const out=[...history,{id:p.id,key:p.key,topic:p.topic,domain:p.domain,title:p.title,text:p.text,day,outcome,yes:p.yes,no:p.no}];
  return out.slice(-HISTORY_SIZE);
}
/** Plain wording when the model is not available (or as its starting point). */
export const plainText=p=>`${p.title}: ${p.description}`;
