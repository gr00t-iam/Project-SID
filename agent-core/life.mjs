// The social and living side of the settlement: people's memories of players, reputation and gossip,
// conversations between agents, visible moods, weather and seasons, road travel, visitors, pets,
// wages and home ownership, jobs that shift with need, elections, crime, annexing land, the mayor,
// and "while you were away" summaries. main.mjs creates one instance and calls into it.
import {seasonOf,dayPhase,moodCategory,EMOTES,reputationTitle,roadGraph,roadRoute,levelOf,relationsOf,adjustAffinity} from './town.mjs';
import {addMemory,overusedPhrases,openerOf,pickTopic,newTalk,recall} from './talk.mjs';
import {CHATTY} from './lm.mjs';
import {MINE} from './roles/miner.mjs';

const VISITORS=[
  {kind:'travelling merchant',names:['Oswin','Tamsin','Ferris','Lark'],items:{DIAMOND:2,ENDER_PEARL:4,NAME_TAG:2,SADDLE:1,GOLDEN_APPLE:2,EXPERIENCE_BOTTLE:8},margin:1.3,
    personality:'Worldly, charming travelling merchant with tall tales from distant lands. Drives a hard but fair bargain.',goal:'Sell your rare wares to players (they can right-click you to trade), swap news with the townsfolk, and move on at dusk.'},
  {kind:'lost traveller',names:['Pim','Edda','Rowan','Nell'],items:{BREAD:2,COMPASS:1,MAP:1},
    personality:'Tired, polite traveller who lost their way. Grateful for kindness, curious about the town.',goal:'Ask the townsfolk for directions and a meal, thank anyone who helps, and set off again at dusk.'},
  {kind:'wandering bard',names:['Lyra','Corwin','Mabel','Finch'],items:{NOTE_BLOCK:2,JUKEBOX:1,MUSIC_DISC_CAT:1},
    personality:'Cheerful wandering bard who turns everything into a song. Loves festivals and gossip.',goal:'Entertain the town with songs and stories, collect gossip for new ballads, and leave at dusk.'},
];
const PET_NAMES=['Clover','Biscuit','Maple','Pebble','Juniper','Nutmeg','Hazel','Barley','Poppy','Sprout','Tansy','Mossy'];
const DECOR={scribe:['CHEST','BOOKSHELF','BOOKSHELF'],crafter:['CHEST','CRAFTING_TABLE','FURNACE'],merchant:['CHEST','BARREL','BARREL'],farmer:['CHEST','HAY_BLOCK','BARREL'],
  miner:['CHEST','FURNACE','BARREL'],builder:['CHEST','CRAFTING_TABLE','BOOKSHELF'],governor:['CHEST','BOOKSHELF','RED_CARPET'],scout:['CHEST','BARREL','RED_CARPET'],guardian:['CHEST','BARREL','ANVIL']};
const NEWS=/became|completed|quest|found|raid|festival|feast|elected|arrived|adopted|named|stole|theft|milestone|broke|annex|wages|finished the|built|mayor/i;
const SQUARE={x:283.5,z:93.5};

export function createLife(d){
  const {configs,memory,act,say,walk,clampMove,log,ledger,conversation,lm,getSnapshot,bridge,players,names,homeOf,homeBuilt,playerByName}=d;
  const town=memory.data.town??={};
  memory.data.people??={};
  town.news??=[];town.elections??=[];town.cases??=[];town.pets??={};town.awaySummary??={};town.mayorWishes??=[];
  town.area??={x:272.5,z:96.5,radius:Number(process.env.ROAM_AREA?.split(',')[2]||44)};
  town.mayor??=process.env.DASHBOARD_PLAYER||[...names.values()][0]||null;
  const tasks=[];
  const cooldown=new Map();
  const intel=()=>d.intel?.();
  // How two citizens get on, on the old -10..10 scale (from the trust matrix).
  const pairScore=(a,b)=>intel()?.social.pairScore(a,b)??0;
  // Conversation memory: each agent's own (said, learned, per-agent and per-player notes) and the town's recent topics.
  town.talk??={topics:[],newsUse:{}};
  const talkOf=id=>{const s=memory.data.agents[id];if(!s)return newTalk();s.talk??=newTalk();return s.talk;};
  const noteSaid=(id,text)=>{const t=talkOf(id);t.said=[...t.said,String(text).slice(0,160)].slice(-16);};
  /** Stock phrases around town right now (plus each speaker's usual opening words), to steer away from. */
  function avoidPhrases(ids){
    const lines=memory.data.conversations.filter(c=>c.kind==='dialogue'||c.kind==='reply').slice(-90).map(c=>c.text);
    const openers=ids.flatMap(id=>talkOf(id).said.slice(-8).map(openerOf)).filter(o=>o.split(' ').length===3);
    return [...new Set([...overusedPhrases(lines),...openers])].slice(0,18);
  }
  const ready=(key,ms)=>{const t=cooldown.get(key)??0;if(Date.now()-t<ms)return false;cooldown.set(key,Date.now());return true;};
  const stateOf=id=>memory.data.agents[id];
  const residents=()=>configs.filter(c=>c.role!=='visitor');
  const nameOf=id=>configs.find(c=>c.id===id)?.name??id;
  const roleOf=c=>c.role??c.id;
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  let lastPhase=null,graph=null,graphRoads=-1;

  // ---------- people: what the town knows about each player ----------
  const person=name=>memory.data.people[name]??={facts:[],reputation:0,lastSeen:0,lastQuit:0};
  function remember(name,fact){
    if(!name||configs.some(c=>c.id===name))return;
    const p=person(name),text=String(fact).slice(0,140);
    if(p.facts.some(f=>f.text===text))return;
    p.facts.push({time:Date.now(),text});p.facts=p.facts.slice(-14);
  }
  function reputation(name,delta,why){
    if(!name||configs.some(c=>c.id===name))return;
    const p=person(name);p.reputation=Math.max(-100,Math.min(100,Math.round((p.reputation+delta)*10)/10));
    if(why)log('reputation',{player:name,delta,why,now:p.reputation});
  }
  function aboutPlayer(name){
    const p=person(name);
    return {name,reputation:p.reputation,standing:reputationTitle(p.reputation),mayor:town.mayor===name,knownFacts:p.facts.slice(-6).map(f=>f.text)};
  }

  // ---------- news and gossip ----------
  function news(by,text){
    if(!NEWS.test(text))return;
    town.news.push({time:Date.now(),by,text:`${nameOf(by)} ${text}`.slice(0,200)});town.news=town.news.slice(-40);
  }

  // ---------- moods ----------
  const raidActive=()=>!!memory.data.town?.raidActive;
  function moodOf(c){
    const s=stateOf(c.id)??{};
    return moodCategory(s.mood,{needs:s.needs,resting:s.resting,raid:raidActive()&&roleOf(c)!=='guardian',festival:town.festival?.held,combat:d.inCombat?.(c.id)});
  }

  // ---------- weather and seasons ----------
  const raining=()=>!!getSnapshot()?.weather?.storm;
  const season=()=>seasonOf(town.day??1);
  const thunder=()=>!!getSnapshot()?.weather?.thunder;
  const RAIN_BREAK_MS=5*60000;
  /**
   * Builders, farmers and the scout take shelter at home from a thunderstorm, and from rain for a while: after
   * 5 minutes of rain they get back to work (people wait out a shower, not a whole rainy day).
   */
  function shelters(c){
    if(!raining()||!['builder','farmer','scout','crafter'].includes(roleOf(c))||!homeBuilt(c.id)){const s=stateOf(c.id);if(s)s.rainSince=null;return false;}
    const s=stateOf(c.id);if(s)s.rainSince??=Date.now();
    return thunder()||Date.now()-(s?.rainSince??Date.now())<RAIN_BREAK_MS;
  }

  // ---------- travel along the roads ----------
  function currentGraph(){
    const done=town.roadsDone??0;
    if(done!==graphRoads){graphRoads=done;graph=roadGraph((d.ROADS??[]).slice(0,done));}
    return graph;
  }
  const RIDERS=new Set(['courier']);
  /** Walk toward dest, following the road network for longer trips. */
  async function travel(id,self,dest){
    const s=stateOf(id);
    if(self.pathing)return;
    // In and out of the mine by the staircase: a straight line from the tunnels to anywhere on the surface runs
    // through solid rock, so first climb to the pithead (and from the surface, go to the pithead before descending).
    const P=MINE.pithead,inMine=p=>p.y<P.y-8&&Math.hypot(p.x-(MINE.hub.x-24),p.z-MINE.hub.z)<60;
    const atPithead=Math.hypot(self.x-(P.x+0.5),self.z-(P.z+0.5))<=3;
    if(inMine(self)!==inMine(dest)&&!atPithead)dest={x:P.x+0.5,y:P.y,z:P.z+0.5};
    // Long trips (beyond the roads or out of town) use the plugin's travel: rolling legs with detours and chunks
    // loaded on the way, to anywhere in the world. A trip already under way is left to run.
    const far=Math.hypot(dest.x-self.x,dest.z-self.z)>48,outOfTown=Math.hypot(dest.x-(town.area?.x??272.5),dest.z-(town.area?.z??96.5))>(town.area?.radius??60);
    // Stuck on the same trip (asked again and again without moving, e.g. no path to the next leg): hand the trip
    // to the plugin's travel, which finds detours leg by leg.
    const t=s.travelTry,same=t&&Math.hypot(t.dx-dest.x,t.dz-dest.z)<2;
    const stuck=same&&Date.now()-t.at>=5000&&Math.hypot(self.x-t.x,self.z-t.z)<=1;
    if(!same||Date.now()-t.at>=5000)s.travelTry={dx:dest.x,dz:dest.z,x:self.x,z:self.z,at:Date.now(),n:stuck?t.n+1:0};
    if(stuck&&s.travelTry.n>=2&&Math.hypot(dest.x-self.x,dest.z-self.z)>6){
      const n=self.navigation;
      if(n&&['moving','loading'].includes(n.status))return;
      return act(id,{type:'travel',x:dest.x,y:dest.y??Math.round(self.y),z:dest.z});
    }
    // The courier rides a horse on trips over 40 blocks (plugin travel mounts him; SIDLocal 2.18.0 riders).
    // Just pulled out of the water: walk round it with the plugin's travel (legs with detours, a ferry if there is a
    // boat) instead of the straight line that led into it (Jasper shuttled between a lake and its shore for half an hour).
    if((s.waterDetourUntil??0)>Date.now()&&Math.hypot(dest.x-self.x,dest.z-self.z)>6){
      const n=self.navigation;
      if(n&&['moving','loading'].includes(n.status)&&Math.hypot((n.x??0)-dest.x,(n.z??0)-dest.z)<3)return;
      return act(id,{type:'travel',x:dest.x,y:dest.y??Math.round(self.y),z:dest.z}).catch(()=>{});
    }
    if(RIDERS.has(id)&&Math.hypot(dest.x-self.x,dest.z-self.z)>40){
      const n=self.navigation;
      if(n&&['moving','loading'].includes(n.status)&&Math.hypot((n.x??0)-dest.x,(n.z??0)-dest.z)<3)return;
      return act(id,{type:'travel',x:dest.x,y:dest.y??Math.round(self.y),z:dest.z}).catch(()=>walk(id,clampMove({type:'pathfind',x:dest.x,y:dest.y,z:dest.z},self)));
    }
    if(far&&(outOfTown||!roadRoute(currentGraph(),self,dest))){
      const n=self.navigation;
      if(n&&['moving','loading'].includes(n.status)&&Math.hypot((n.x??0)-dest.x,(n.z??0)-dest.z)<3)return;
      return act(id,{type:'travel',x:dest.x,y:dest.y??Math.round(self.y),z:dest.z}).catch(()=>walk(id,clampMove({type:'pathfind',x:dest.x,y:dest.y,z:dest.z},self)));
    }
    const route=s.route&&s.route.dest.x===dest.x&&s.route.dest.z===dest.z?s.route:(s.route={dest,points:roadRoute(currentGraph(),self,dest)??[]});
    while(route.points.length&&dist(self,route.points[0])<3)route.points.shift();
    const next=route.points[0];
    if(!next){s.route=null;return walk(id,clampMove({type:'pathfind',x:dest.x,y:dest.y,z:dest.z},self));}
    const ground=await act(id,{type:'survey',x:Math.floor(next.x),y:0,z:Math.floor(next.z),width:1,depth:1}).catch(()=>null);
    const y=Number.isFinite(ground?.heights?.[0])?ground.heights[0]+1:Math.round(self.y);
    return walk(id,clampMove({type:'pathfind',x:next.x,y,z:next.z},self)).catch(()=>{route.points.shift();});
  }

  // ---------- conversations between agents ----------
  function maybeStartDialogue(){
    const snap=getSnapshot();if(!snap||d.lmOnline?.()===false||!ready('dialogue',90000))return;
    const phase=dayPhase(snap.worldTime);if(phase==='night'||tasks.some(t=>t.kind==='dialogue'))return;
    const busy=id=>{const s=stateOf(id);return !s||s.resting||s.talkingUntil>Date.now();};
    const pairs=[];
    for(const a of snap.agents)for(const b of snap.agents)if(a.id<b.id&&dist(a,b)<=5&&!busy(a.id)&&!busy(b.id))pairs.push([a.id,b.id]);
    const fresh=pairs.filter(([a,b])=>ready(`pair:${a}|${b}`,600000));
    if(!fresh.length){cooldown.set('dialogue',Date.now()-60000);return;}
    const [a,b]=fresh[Math.floor(Math.random()*fresh.length)];
    const conflict=(town.conflicts??[]).find(x=>!x.resolved&&((x.a===a&&x.b===b)||(x.a===b&&x.b===a)));
    const role=id=>{const c=configs.find(x=>x.id===id);return {id,role:c?roleOf(c):id};};
    const learned=[a,b].flatMap(id=>talkOf(id).learned.slice(-3).map(l=>({...l,by:nameOf(id)})));
    const topic=conflict?`their disagreement about ${conflict.topic}`:pickTopic({a:role(a),b:role(b),pair:talkOf(a).pairs[b]??{},recentTopics:town.talk.topics,
      news:town.news.slice(-10).map(n=>n.text),newsUse:town.talk.newsUse,learned});
    for(const id of [a,b])stateOf(id).talkingUntil=Date.now()+45000;
    tasks.push({kind:'dialogue',a,b,topic});
  }
  async function runDialogue(task){
    const {a,b,topic}=task,ca=configs.find(c=>c.id===a),cb=configs.find(c=>c.id===b);if(!ca||!cb)return;
    const persona=c=>{const s=stateOf(c.id);return {id:c.id,name:c.name??c.id,role:roleOf(c),personality:s.personality??c.personality,mood:s.mood,feeling:moodOf(c)};};
    const aff=pairScore(a,b),social=intel()?.dialogueContext(a,b)??{};
    // Each speaker brings their memories, how they see the other (trust/reliability) and their recent conversations.
    const withMemory=c=>({...persona(c),memory:recall(talkOf(c.id),c.id===a?b:a),...(social[c.id]??{})});
    const text=await lm.callUtilityTask('npc_dialogue','Write a short, natural conversation between two Minecraft villagers who meet in town: 3 or 4 lines, alternating, each line under 110 characters, in character (moods and personalities matter; friends are warm, rivals are prickly but not cruel). Stay on the topic. How much each trusts the other (seesOther) colours the tone. Let them remember: build on their pastTalks together, pick up any openThread, and share things from learnedRecently in their own words. Make it sound fresh: never reuse wording from their recentlySaid lines, do not use any phrase in avoidPhrases, do not open with a greeting plus the weather, and do not quote coordinates. Each speaker has their own voice and vocabulary. Then note what each of them took away. Return ONLY JSON {"lines":[{"speaker":"<id>","text":"..."}],"summary":"one sentence: what they talked about","learned":{"<id>":"one new thing this speaker learned or now thinks, or empty"},"followUp":"something left open to bring up next time, or empty"}.',
      {a:withMemory(ca),b:withMemory(cb),relationship:aff>=3?'friends':aff<=-3?'rivals':'neighbours',topic,season:season(),weather:raining()?'raining':'clear',avoidPhrases:avoidPhrases([a,b])},{opts:CHATTY});
    let lines=[],parsed={};
    try{const body=text.replace(/<think>[\s\S]*?(<\/think>|$)/g,'').replace(/```(?:json)?/g,'');parsed=JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));lines=parsed.lines;}
    catch{lines=text.split('\n').map(l=>l.match(/^\s*([a-z]+)\s*:\s*(.+)$/i)).filter(Boolean).map(m=>({speaker:m[1].toLowerCase(),text:m[2]}));}
    lines=(lines??[]).filter(l=>l&&typeof l.text==='string').slice(0,4);
    const convo=lines.length?intel()?.archive.start({kind:'npc_dialogue',participants:[a,b]}):null;
    for(const [i,line] of lines.entries()){
      const speaker=[a,b].includes(line.speaker)?line.speaker:i%2?b:a,other=speaker===a?b:a;
      conversation({from:speaker,to:other,kind:'dialogue',text:line.text});noteSaid(speaker,line.text);if(convo)intel().archive.add(convo,speaker,line.text);
      await act(speaker,{type:'chat',x:0,y:0,z:0,text:line.text.slice(0,240)}).catch(()=>{});
      await new Promise(r=>setTimeout(r,3500));
    }
    if(convo)intel().archive.end(convo,'finished');
    if(lines.length){
      // What they remember of it: a note on the conversation for each, what each learned (from the other), an open thread.
      const summary=typeof parsed.summary==='string'&&parsed.summary.trim()?parsed.summary.trim().slice(0,200):`talked about ${topic.replace(/^[a-z ]+: /,'')}`;
      const followUp=typeof parsed.followUp==='string'&&parsed.followUp.trim().length>3?parsed.followUp.trim().slice(0,140):null;
      for(const [me,other] of [[a,b],[b,a]]){
        const t=talkOf(me),p=t.pairs[other]??={notes:[],topics:[]};
        p.notes=addMemory(p.notes,{text:summary,day:town.day},6);p.topics=[...p.topics,topic].slice(-5);p.followUp=followUp;p.last=Date.now();
        const got=parsed.learned?.[me];
        if(typeof got==='string'&&got.trim().length>4)t.learned=addMemory(t.learned,{text:got.trim().slice(0,160),from:nameOf(other),day:town.day},20);
      }
      town.talk.topics=[...town.talk.topics,topic].slice(-20);
      const gossip=topic.match(/^town gossip: (.+)$/);if(gossip)town.talk.newsUse[gossip[1]]=(town.talk.newsUse[gossip[1]]??0)+1;
      const keep=new Set(town.news.map(n=>n.text));for(const k of Object.keys(town.talk.newsUse))if(!keep.has(k))delete town.talk.newsUse[k];
      const conflictTopic=/disagreement/.test(topic);
      intel()?.social.adjustPair(a,b,{trust:conflictTopic?-1.2:2},conflictTopic?'argument':'conversation',topic);
      log('dialogue',{a,b,topic,lines:lines.length});
    }
  }

  // ---------- visitors ----------
  async function visitorArrives(){
    const type=VISITORS[Math.floor(Math.random()*VISITORS.length)],name=type.names[Math.floor(Math.random()*type.names.length)];
    const config={id:'visitor',role:'visitor',name:`${name} the ${type.kind.split(' ').pop()}`,every:2,personality:type.personality,goal:type.goal,visitorKind:type.kind};
    configs.push(config);delete memory.data.agents.visitor;memory.agent(config);
    try{await bridge.request('session',{agent:'visitor'});}catch(error){configs.splice(configs.indexOf(config),1);log('visitor_error',{message:error.message});return;}
    for(const [item,n] of Object.entries(type.items))await act('visitor',{type:'grant',x:0,y:0,z:0,target:item,count:n}).catch(()=>{});
    if(type.margin)await act('visitor',{type:'mood',x:0,y:0,z:0,count:type.margin}).catch(()=>{});
    town.visitor={name:config.name,kind:type.kind,arrived:Date.now(),day:town.day};
    ledger('visitor',`${config.name}, a ${type.kind}, arrived in town`);
    await act('visitor',{type:'sound',x:0,y:0,z:0,target:'block.note_block.bell',count:2}).catch(()=>{});
    const greeter=residents().find(c=>roleOf(c)==='governor')??residents()[0];
    await say(greeter.id,`Welcome to our town, ${config.name}! Make yourself at home.`);
  }
  async function visitorLeaves(){
    const config=configs.find(c=>c.id==='visitor');if(!config){town.visitor=null;return;}
    await say('visitor',`Farewell, friends! I'll sing of this town on the road.`).catch(()=>{});
    await act('visitor',{type:'dismiss',x:0,y:0,z:0}).catch(()=>{});
    configs.splice(configs.indexOf(config),1);
    ledger('scribe',`${config.name} left town`);town.visitor=null;
  }

  // ---------- pets ----------
  async function adoptPets(){
    const want=[['guardian','WOLF','Rex'],['scout','CAT','Pip']];
    for(const [role,kind,name] of want){
      const c=residents().find(x=>roleOf(x)===role);if(!c||town.pets[`${c.id}:${kind}`])continue;
      const r=await act(c.id,{type:'adopt',x:0,y:0,z:0,target:kind,text:name}).catch(e=>({error:e.message}));
      if(r?.error&&!/Already/.test(r.error))continue;
      town.pets[`${c.id}:${kind}`]={name,uuid:r?.uuid,since:Date.now()};
      if(r?.uuid){ledger(c.id,`adopted a ${kind==='WOLF'?'dog':'cat'} named ${name}`);await say(c.id,kind==='WOLF'?`Meet ${name}, my new partner on patrol!`:`This is ${name}. Every town needs a cat.`);}
    }
  }
  async function feedCats(c,self){
    const cats=await act(c.id,{type:'find',x:0,y:0,z:0,target:'CAT',count:20}).catch(()=>[]);
    const cat=cats?.[0];if(!cat)return;
    if(dist(self,cat)>3){await walk(c.id,clampMove({type:'pathfind',x:cat.x,y:Math.round(cat.y),z:cat.z},self)).catch(()=>{});return;}
    await act(c.id,{type:'pet',x:0,y:0,z:0,target:cat.uuid}).catch(()=>{});
    await act(c.id,{type:'sound',x:0,y:0,z:0,target:'entity.cat.purreow'}).catch(()=>{});
    stateOf(c.id).fedCats=town.day;log('fed_cats',{agent:c.id});
  }
  async function onBred(data){
    const farmer=residents().find(c=>roleOf(c)==='farmer');if(!farmer)return;
    const name=PET_NAMES[Math.floor(Math.random()*PET_NAMES.length)];
    const r=await act(farmer.id,{type:'name',x:0,y:0,z:0,target:data.entity.uuid,text:name}).catch(()=>null);
    if(r){const kind=String(data.entity.type).toLowerCase();ledger(farmer.id,`named a new baby ${kind} ${name}`);await say(farmer.id,`Welcome to the world, little ${name}!`);}
  }

  // ---------- wages, spending, homes ----------
  async function payWages(){
    if(d.economy?.())return;   // the Banker's payroll pays for work done (skills/economy.mjs)
    let paid=0;
    for(const c of residents()){
      const n=Math.max(0,Math.round((1+Math.floor(levelOf(stateOf(c.id)?.xp??0)/2))*(town.policy?.wageMultiplier??1)));if(!n)continue;
      if(await act(c.id,{type:'wage',x:0,y:0,z:0,to:c.id,target:'EMERALD',count:n}).then(()=>true).catch(()=>false))paid+=n;
    }
    if(paid){ledger('governor',`paid ${paid} emeralds in wages from the treasury`);log('wages',{paid});}
  }
  /** Buying: anything taken from the warehouse for personal use costs emeralds, which go back to the treasury. */
  async function spend(id,emeralds,what){
    // With a bank the price goes from the citizen's account to the town (the coins stay in the vault and come back
    // round as town pay); only without an account balance is cash from the pocket used.
    if(d.bank?.()&&(d.bank().state.accounts[id]?.balance??0)>=emeralds)
      return d.bank().transfer(id,'~town',emeralds,{memo:`bought ${String(what).toLowerCase().replace(/_/g,' ')}`,kind:'purchase'}).then(()=>{log('purchase',{agent:id,what,emeralds,via:'bank'});return true;}).catch(()=>false);
    const s=getSnapshot()?.agents.find(a=>a.id===id),have=s?.inventory?.EMERALD??0;
    if(have<emeralds)return false;
    return act(id,{type:'pay',x:0,y:0,z:0,target:'EMERALD',count:emeralds}).then(()=>{log('purchase',{agent:id,what,emeralds});return true;}).catch(()=>false);
  }
  async function decorateHome(c,s,self){
    const lot=homeOf(c.id);if(!lot)return;
    const items=DECOR[roleOf(c)]??['CHEST','BARREL'];const n=s.decor??0;if(n>=items.length)return;
    const item=items[n];
    if(!s.decorItem){
      if(!(await spend(c.id,2,item)))return;
      const got=await act(c.id,{type:'wage',x:0,y:0,z:0,to:c.id,target:item,count:1}).then(()=>true).catch(()=>false);
      if(!got){await act(c.id,{type:'wage',x:0,y:0,z:0,to:c.id,target:'EMERALD',count:2}).catch(()=>{});s.decorDay=town.day;return;}
      s.decorItem=item;
    }
    const inside=lot.spot??{x:lot.cx,z:lot.cz};
    if(dist(self,inside)>2){await travel(c.id,self,{...inside,y:(d.homeFloor?.(c.id))??Math.round(self.y)});return;}
    const spots=[[1,3],[3,1],[3,3],[1,1],[2,3],[3,2]].map(([i,k])=>({x:lot.x+i,z:lot.z+k}));
    for(const spot of spots){
      const y=Math.floor(self.y);
      if(await act(c.id,{type:'place',x:spot.x,y,z:spot.z,target:s.decorItem}).then(()=>true).catch(()=>false)){
        ledger(c.id,`decorated their home with a ${s.decorItem.toLowerCase().replace(/_/g,' ')}`);s.decor=n+1;s.decorItem=null;s.decorDay=town.day;return;
      }
    }
    s.decorDay=town.day;   // no free spot today; try again another day
  }

  // ---------- jobs that change with need ----------
  function assignHelpers(){
    const stock=town.stock?.items??{};
    for(const c of residents())delete stateOf(c.id)?.helping;
    const helper=residents().find(c=>roleOf(c)==='scout')??residents().find(c=>roleOf(c)==='miner');
    if(!helper)return;
    const wood=(stock.OAK_LOG??0)+(stock.SPRUCE_LOG??0)+(stock.OAK_PLANKS??0)/4+(stock.SPRUCE_PLANKS??0)/4;
    const job=(stock.BREAD??0)<16&&(stock.WHEAT??0)<24?{kind:'harvest',why:'bread is running low'}:wood<48?{kind:'lumber',why:'wood is running low'}:null;
    if(!job)return;
    stateOf(helper.id).helping={...job,day:town.day};
    ledger(helper.id,`is helping with the ${job.kind==='harvest'?'harvest':'woodcutting'} today because ${job.why}`);
    say(helper.id,job.kind==='harvest'?`The bread is running low, so I'll help in the fields today!`:`We're short of wood, so I'll fetch some logs today.`);
  }
  async function helpJob(c,s,self){
    const h=s.helping;
    if(h.kind==='harvest'){
      const farmer=residents().find(x=>roleOf(x)==='farmer'),farm=farmer&&stateOf(farmer.id)?.farm;if(!farm){delete s.helping;return;}
      if((self.inventory?.WHEAT_SEEDS??0)<4){await act(c.id,{type:'wage',x:0,y:0,z:0,to:c.id,target:'WHEAT_SEEDS',count:16}).catch(()=>{});}
      if(dist(self,farm)>3){await travel(c.id,self,{x:farm.x,y:Math.round(self.y),z:farm.z});return;}
      if(!ready(`help-tend:${c.id}`,20000))return;
      const r=await act(c.id,{type:'tend',x:Math.floor(farm.x),y:Math.floor(self.y),z:Math.floor(farm.z),width:farm.width,depth:farm.depth,target:'WHEAT_SEEDS'}).catch(()=>null);
      if(r?.harvested)log('helped_harvest',{agent:c.id,harvested:r.harvested});
      return;
    }
    if(h.kind==='lumber'){
      const found=await act(c.id,{type:'find',x:0,y:0,z:0,target:'OAK_LOG',count:24}).catch(()=>[]);
      // Only real trees (leaves around the top of the trunk); logs in buildings are never cut.
      town.notTrees??={};
      let log0=null;
      for(const l of (found??[]).filter(l=>!town.notTrees[`${l.x},${l.z}`]).slice(0,3)){
        const top=Math.max(...found.filter(o=>o.x===l.x&&o.z===l.z).map(o=>o.y));
        const crown=await act(c.id,{type:'scan',x:l.x-2,y:top-1,z:l.z-2,width:5,height:5,depth:5}).catch(()=>null);
        if(crown?.cells?.some(cell=>/_LEAVES$/.test(cell[3]))){log0=l;break;}
        town.notTrees[`${l.x},${l.z}`]=Date.now();
      }
      const logs=log0?found.filter(l=>Math.hypot(l.x-log0.x,l.z-log0.z)<=2&&!town.notTrees[`${l.x},${l.z}`]):[];
      if(!log0){
        // None in sight: go to the nearest trees anyone remembers seeing.
        const mem=intel()?.spatial.query(c.id,'wood',1,120,{from:self,category:'tree'})[0];
        if(!mem){delete s.helping;return;}
        if(Math.hypot(self.x-mem.x,self.z-mem.z)>6){await travel(c.id,self,{x:mem.x+1.5,y:mem.y,z:mem.z+0.5});return;}
        intel().spatial.markStale(mem.memory_id);return;
      }
      if(Math.hypot(self.x-log0.x,self.z-log0.z)>6){await walk(c.id,clampMove({type:'pathfind',x:log0.x+1.5,y:Math.round(self.y),z:log0.z+0.5},self)).catch(()=>{});return;}
      await act(c.id,{type:'equip',x:0,y:0,z:0,target:'IRON_AXE'}).catch(()=>{});
      for(const l of logs.filter(l=>Math.hypot(self.x-l.x,self.z-l.z)<=8).slice(0,4))await act(c.id,{type:'mine',x:l.x,y:l.y,z:l.z}).catch(()=>{});
    }
  }

  // ---------- elections ----------
  function startElection(){
    const governor=residents().find(c=>roleOf(c)==='governor');
    const score=c=>(intel()?.social.relationsOf(c.id).friends.length??0)*2+levelOf(stateOf(c.id)?.xp??0);
    const candidates=[...new Set([town.governor??governor?.id,...residents().filter(c=>!['guardian'].includes(roleOf(c))).sort((a,b)=>score(b)-score(a)).slice(0,2).map(c=>c.id)])].filter(Boolean).slice(0,3);
    if(candidates.length<2)return;
    town.election={day:town.day,candidates,endorsements:{},votes:{},held:false};
    ledger('governor',`election day! Candidates for governor: ${candidates.map(nameOf).join(', ')}`);
    for(const id of candidates)tasks.push({kind:'campaign',id});
  }
  function concludeElection(){
    const e=town.election;if(!e||e.held)return;
    const tally=Object.fromEntries(e.candidates.map(c=>[c,0]));
    for(const c of residents()){
      if(e.candidates.includes(c.id)){e.votes[c.id]=c.id;tally[c.id]++;continue;}
      const pick=e.candidates.map(k=>[k,pairScore(c.id,k)+Math.random()]).sort((a,b)=>b[1]-a[1])[0][0];
      e.votes[c.id]=pick;tally[pick]++;
    }
    for(const [player,cand] of Object.entries(e.endorsements))tally[cand]=(tally[cand]??0)+3;
    const winner=Object.entries(tally).sort((a,b)=>b[1]-a[1])[0][0];
    e.held=true;e.tally=tally;e.winner=winner;town.governor=winner;
    town.elections.push({day:e.day,winner,tally});town.elections=town.elections.slice(-10);
    ledger('scribe',`${nameOf(winner)} was elected governor (${Object.entries(tally).map(([k,v])=>`${nameOf(k)} ${v}`).join(', ')})`);
    say(winner,`Thank you all! I'll serve the town as best I can.`);
    act(winner,{type:'sound',x:0,y:0,z:0,target:'ui.toast.challenge_complete',count:2}).catch(()=>{});
  }

  // ---------- crime ----------
  // One-time (2026-10-05): the trust each staged theft cost the judge is given back (they were not his doing).
  if(!town.judgeTrustV1){town.judgeTrustV1=true;setTimeout(()=>{const n=Math.min(10,(town.cases??[]).filter(k=>k.thief==='judge').length);
    if(n)for(const other of residents())if(other.id!=='judge')intel()?.social.adjust(other.id,'judge',{trust:8*n,reliability:10*n},'cleared','the thefts pinned on the judge were not his');
    log('judge_trust_restored',{cases:n});},45000).unref?.();}
  async function maybeTheft(){
    if(process.env.CRIME==='off'||Math.random()>0.08)return;
    // Never an official (judge, sheriff, guard, governor, banker, clerk - those who keep the law and the goods), never
    // the same citizen twice within 3 days; the likeliest is one whose values care least for community and tradition,
    // with chance in it. (It used to be simply the least-liked citizen: the judge - disliked for his rulings and the
    // rumours about them - was made the thief ten times running.)
    const OFFICIAL=new Set(['guardian','governor','sheriff','judge','banker','clerk']);
    const recent=new Set((town.cases??[]).filter(k=>town.day-(k.day??0)<3).map(k=>k.thief));
    const suspects=residents().filter(c=>!OFFICIAL.has(roleOf(c))&&c.id!==town.governor&&!recent.has(c.id)&&!d.justice?.()?.restricted(c.id));
    const weight=c=>{const v=d.valuesOf?.(c.id)??{};return Math.max(0.05,(1-(v.community??0.5))*(1-(v.tradition??0.5)))*(0.5+Math.random());};
    const thief=suspects.map(c=>[c,weight(c)]).sort((a,b)=>b[1]-a[1])[0]?.[0];
    if(!thief)return;
    const n=3+Math.floor(Math.random()*4);
    if(!await act(thief.id,{type:'wage',x:0,y:0,z:0,to:thief.id,target:'EMERALD',count:n}).then(()=>true).catch(()=>false))return;
    const kase={id:String(town.cases.length+1),day:town.day,thief:thief.id,amount:n,status:'unsolved'};town.cases.push(kase);
    log('theft',{thief:thief.id,amount:n});   // secret until it is investigated
    // With a court: the treasury's keeper (the governor) complains at once; the sheriff investigates, the court tries it.
    const justice=d.justice?.(),keeper=configs.find(c=>c.id===town.governor)??residents().find(c=>roleOf(c)==='governor');
    if(justice&&keeper&&keeper.id!==thief.id){
      const at=d.warehouseSpot?.()??null;
      const k=justice.openConflict({a:keeper.id,b:thief.id,kind:'theft',reason:`${n} emeralds missing from the treasury`,location:at,truth:{culprit:thief.id},extra:{amount:n,scene:'warehouse',case_id:kase.id}});
      justice.complain(keeper.id,thief.id,`${n} emeralds are missing from the treasury`,{kind:'theft'});
      kase.status='reported';kase.conflict_id=k.conflict_id;
    }
  }
  async function investigate(){
    const open=town.cases.find(c=>c.status==='unsolved');if(!open||d.justice?.())return;
    open.status='investigated';
    const guardian=residents().find(c=>roleOf(c)==='guardian');
    if(guardian)tasks.push({kind:'investigate',id:guardian.id,case:open.id});
    const governor=configs.find(c=>c.id===town.governor)??residents().find(c=>roleOf(c)==='governor');
    if(governor)tasks.push({kind:'ruling',id:governor.id,case:open.id});
  }

  // ---------- annexing land ----------
  function proposeAnnex(){
    const charter=memory.data.charter,governor=configs.find(c=>c.id===town.governor)??residents().find(c=>roleOf(c)==='governor');
    if(!governor||charter.proposals.some(p=>p.annex)||town.area.radius>=100)return;
    const radius=Math.min(112,town.area.radius+16);
    const p={id:String(charter.next++),by:governor.id,text:`Annex land: grow the town from ${town.area.radius} to ${radius} blocks around spawn (needs the mayor's approval)`,annex:{radius},requiresPlayer:true,votes:{[governor.id]:'yes'},time:Date.now()};
    charter.proposals.push(p);ledger(governor.id,`proposed #${p.id}: ${p.text}`);
  }
  async function annex(p){
    const r=await act(residents()[0].id,{type:'expand',x:0,y:0,z:0,count:p.annex.radius+4}).catch(e=>({error:e.message}));
    if(r?.error){log('annex_error',{message:r.error});return;}
    town.area.radius=p.annex.radius;d.onAreaChanged?.(town.area);
    ledger('governor',`annexed new land: the town now reaches ${p.annex.radius} blocks from spawn (${r.newChunks} new chunks kept loaded)`);
  }

  // ---------- phase changes ----------
  async function onPhase(phase,prev){
    if(phase==='dawn'&&prev==='night'){
      assignHelpers();
      if((town.day??1)%7===0&&town.election?.day!==town.day)startElection();
      if(town.visitor&&town.visitor.day<town.day)await visitorLeaves();
      else if(!town.visitor&&Math.random()<Number(process.env.VISITOR_CHANCE??0.35))await visitorArrives();
      await investigate();
      if((town.day??1)%7===3&&Object.values(memory.data.village?.built??{}).filter(Boolean).length>=9&&(town.roadsDone??0)>=(d.ROADS?.length??10))proposeAnnex();
    }
    if(phase==='evening'){
      await payWages();
      if(town.election&&town.election.day===town.day)concludeElection();
      if(town.visitor&&configs.some(c=>c.id==='visitor'&&c.visitorKind==='wandering bard'))act('visitor',{type:'sound',x:0,y:0,z:0,target:'music_disc.cat',count:2}).catch(()=>{});
    }
    if(phase==='night'&&prev==='evening')await maybeTheft();
  }

  return {
    tasks,travel,remember,reputation,aboutPlayer,news,moodOf,raining,season,shelters,
    emote:c=>EMOTES[moodOf(c)]??'',
    /** Mood effects: happy agents never slow down; grumpy merchants haggle harder. */
    happy:c=>moodOf(c)==='happy',
    async tick(){
      const snap=getSnapshot();if(!snap)return;
      const phase=dayPhase(snap.worldTime);
      if(lastPhase&&phase!==lastPhase)await onPhase(phase,lastPhase).catch(e=>log('life_error',{where:'phase',message:e.message}));
      lastPhase=phase;
      memory.data.town.raidActive=d.raidActive?.()??false;
      maybeStartDialogue();
      // Reflect on player conversations that have gone quiet (or grown long).
      if(ready('talk-reflect',20000))for(const c of configs){const t=talkOf(c.id);for(const [player,p] of Object.entries(t.players))if(p.pending?.length&&(p.pending.length>=6||Date.now()-p.last>120000)&&!tasks.some(x=>x.kind==='reflectTalk'&&x.id===c.id&&x.player===player)){tasks.push({kind:'reflectTalk',id:c.id,player,exchanges:p.pending});p.pending=[];}}
      if(ready('pets',300000))adoptPets().catch(()=>{});
      // Grumpy merchants haggle harder; the mood shows in the trade window's margin.
      const merchant=residents().find(c=>roleOf(c)==='merchant');
      if(merchant&&ready('merchant-mood',60000)){const m=moodOf(merchant);act(merchant.id,{type:'mood',x:0,y:0,z:0,count:m==='grumpy'?1.35:m==='happy'?1.05:0}).catch(()=>{});}
    },
    /** Jobs from the living world, checked before routine work. */
    job(c,s,self,night){
      if(s.talkingUntil>Date.now())return async()=>{};   // standing still while chatting
      if(moodOf(c)==='scared'&&raidActive()){
        const g=getSnapshot()?.agents.find(a=>residents().find(x=>x.id===a.id&&roleOf(x)==='guardian'));
        if(g&&dist(self,g)>4)return ()=>walk(c.id,clampMove({type:'pathfind',x:g.x+1.5,y:Math.round(g.y),z:g.z+1.5},self)).catch(()=>{});
      }
      if(night)return null;
      if(shelters(c)&&(s.project||s.farm||roleOf(c)==='scout'))return 'shelter';
      if(s.helping&&s.helping.day===town.day)return ()=>helpJob(c,s,self);
      if(roleOf(c)==='scout'&&s.fedCats!==town.day&&ready(`cats:${c.id}`,120000))return ()=>feedCats(c,self);
      if(homeBuilt(c.id)&&!s.project&&!s.dig&&(s.decorDay??0)<town.day-1&&(self.inventory?.EMERALD??0)>=2&&ready(`decor:${c.id}`,60000))return ()=>decorateHome(c,s,self);
      return null;
    },
    async onPlayer(data){
      const p=person(data.name);
      if(data.kind==='quit'){p.lastQuit=Date.now();return;}
      p.lastSeen=Date.now();
      if(p.lastQuit&&Date.now()-p.lastQuit>10*60000)tasks.unshift({kind:'away',player:data.name,since:p.lastQuit});
      else tasks.unshift({kind:'greet',player:data.name});
    },
    onVandalism(data){
      // The mayor manages the town: deliberate edits are neither crimes nor repair requests.
      if(data.player && String(data.player).toLowerCase()===String(town.mayor??'').toLowerCase()){
        log('town_edit',{player:data.player,block:data.block,authorized:true});
        return;
      }
      reputation(data.player,-8,'broke a building');remember(data.player,`broke a ${data.block.type.toLowerCase().replace(/_/g,' ')} the townsfolk built`);
      (town.repairs??=[]).push({x:data.block.x,y:data.block.y,z:data.block.z,block:data.block.type});town.repairs=town.repairs.slice(-64);
      const snap=getSnapshot(),near=snap?.agents.filter(a=>a.id!=='visitor').sort((a,b)=>Math.hypot(a.x-data.block.x,a.z-data.block.z)-Math.hypot(b.x-data.block.x,b.z-data.block.z))[0];
      if(near&&ready(`vandal:${data.player}`,60000))say(near.id,`Hey ${data.player}! We built that. Please don't break the town's buildings.`);
      news('guardian',`reported that ${data.player} broke part of the town`);
    },
    onBred,
    onTrade(data){
      if(data.kind==='received'&&data.from){reputation(data.from,2,'gift');remember(data.from,`gave ${nameOf(data.agent)} ${data.count} ${String(data.item).toLowerCase().replace(/_/g,' ')}`);}
      if(data.kind==='traded'&&data.player){reputation(data.player,1,'trade');remember(data.player,`traded with ${nameOf(data.agent)}`);}
      if(data.kind==='reward'&&data.to){reputation(data.to,5,'quest');remember(data.to,`completed a quest for ${nameOf(data.agent)}`);}
    },
    onPlayerChat(player,text,agent){
      if(/\b(i (like|love|want|wish|need|prefer|hope)|let'?s build|please build|can you build|we should)\b/i.test(text))remember(player,`said: "${text.slice(0,110)}"`);
      if(town.meeting&&town.meeting.day===town.day&&player===town.mayor){town.mayorWishes.push({day:town.day,text:text.slice(0,160)});town.mayorWishes=town.mayorWishes.slice(-6);}
    },
    /** What an agent remembers when answering a player: past talks with them, what it learned, what it said lately. */
    recallFor(agent,player){return {...recall(talkOf(agent),player,true),avoidPhrases:avoidPhrases([agent])};},
    /** A player exchange: remembered as it happens, reflected on (summarised, learned from) once the chat goes quiet. */
    noteExchange(agent,player,heard,said){
      noteSaid(agent,said);
      const p=talkOf(agent).players[player]??={notes:[]};
      (p.pending??=[]).push({heard:String(heard).slice(0,200),said:String(said).slice(0,200)});p.pending=p.pending.slice(-10);p.last=Date.now();
    },
    onReply(agent,player,reply){
      if(/\b(i will|i'll|i promise|count on me)\b/i.test(reply)){const s=stateOf(agent);s.promises=[...(s.promises??[]),{to:player,text:reply.slice(0,140),day:town.day}].slice(-5);}
    },
    onProposalAdopted(p){if(p.annex)annex(p);},
    endorse(player,candidate){
      const e=town.election;if(!e||e.held||e.day!==town.day)throw Error('There is no election today');
      const id=configs.find(c=>c.id===candidate||(c.name??'').toLowerCase().startsWith(candidate.toLowerCase()))?.id;
      if(!id||!e.candidates.includes(id))throw Error(`Candidates are ${e.candidates.map(nameOf).join(', ')}`);
      e.endorsements[player]=id;ledger(id,`was endorsed by ${player}`);return nameOf(id);
    },
    /** Extra planning and reply context. */
    context(c,s){
      const players=[...new Set([...names.values(),...Object.keys(memory.data.people)])].slice(0,4);
      return {season:season(),weather:raining()?'raining':'clear',moodNow:moodOf(c),mayor:town.mayor,mayorWishes:town.mayorWishes.slice(-3).map(w=>w.text),
        promises:(s.promises??[]).filter(p=>(town.day??1)-p.day<=2),townNews:town.news.slice(-4).map(n=>n.text),
        aboutPlayers:players.map(aboutPlayer),helping:s.helping?.day===town.day?s.helping:undefined,
        visitor:town.visitor?{name:town.visitor.name,kind:town.visitor.kind}:undefined,
        election:town.election&&town.election.day===town.day?{candidates:town.election.candidates.map(nameOf)}:undefined,
        governorNow:town.governor?nameOf(town.governor):undefined,
        conversationMemory:{learnedRecently:talkOf(c.id).learned.slice(-5).map(l=>`${l.text} (from ${l.from})`),
          openThreads:[...Object.entries(talkOf(c.id).pairs),...Object.entries(talkOf(c.id).players)].filter(([,p])=>p.followUp).slice(-4).map(([who,p])=>`with ${who}: ${p.followUp}`)}};
    },
    /** Dashboard: what an agent has learned and remembers of its conversations. */
    talkView(id){
      const t=talkOf(id);
      const threads=[...Object.entries(t.pairs).map(([k,p])=>({with:nameOf(k),...p})),...Object.entries(t.players).map(([k,p])=>({with:k,...p}))]
        .filter(p=>p.notes?.length).sort((x,y)=>(y.last??0)-(x.last??0)).slice(0,5).map(p=>({with:p.with,note:p.notes.at(-1).text,followUp:p.followUp??null}));
      return {learned:t.learned.slice(-6).reverse().map(l=>({text:l.text,from:l.from,day:l.day})),threads};
    },
    replyStyle(c){const m=moodOf(c);return m==='grumpy'?'You are grumpy right now: keep it short and a little curt, but not rude.':m==='happy'?'You are in a great mood: warm and chatty.':m==='scared'?'You are frightened: nervous and brief.':'';},
    async runTask(task){
      const persona=id=>{const c=configs.find(x=>x.id===id),s=stateOf(id)??{};return {name:c?.name??id,role:c&&roleOf(c),personality:s.personality??c?.personality,mood:s.mood};};
      if(task.kind==='dialogue')return runDialogue(task);
      if(task.kind==='reflectTalk'){
        const t=talkOf(task.id),p=t.players[task.player]??={notes:[]};
        const text=await lm.callUtilityTask('chat_log_json_parsing','You are the memory of a Minecraft villager. Read its recent chat with a player and note what it will remember. Return ONLY JSON {"summary":"one sentence: what they talked about","aboutPlayer":"one fact or preference about the player worth remembering, or empty","learned":"one thing the villager learned or now thinks, or empty","followUp":"a promise, question or plan left open, or empty"}.',
          {villager:persona(task.id),player:task.player,exchanges:task.exchanges,alreadyRemembered:p.notes.slice(-4).map(n=>n.text)});
        let r={};try{const body=text.replace(/<think>[\s\S]*?(<\/think>|$)/g,'').replace(/```(?:json)?/g,'');r=JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));}catch{return;}
        const str=v=>typeof v==='string'&&v.trim().length>4?v.trim().slice(0,180):null;
        if(str(r.summary))p.notes=addMemory(p.notes,{text:str(r.summary),day:town.day},8);
        if(str(r.learned))t.learned=addMemory(t.learned,{text:str(r.learned),from:task.player,day:town.day},20);
        if(str(r.aboutPlayer))remember(task.player,`${nameOf(task.id)} learned: ${str(r.aboutPlayer)}`);
        p.followUp=str(r.followUp);
        log('talk_remembered',{agent:task.id,player:task.player,summary:str(r.summary)});
        return;
      }
      if(task.kind==='greet'||task.kind==='away'){
        const snap=getSnapshot(),p=playerByName(task.player);
        const scribe=residents().find(c=>roleOf(c)==='scribe');
        // The scribe tells the news; otherwise whoever stands closest to the player says hello.
        const nearest=p&&snap?snap.agents.filter(a=>a.id!=='visitor').sort((a,b)=>dist(a,p)-dist(b,p))[0]:null;
        const greeter=task.kind==='away'?scribe:(nearest?configs.find(c=>c.id===nearest.id):scribe);
        if(!greeter)return;
        if(task.kind==='away'){
          const since=memory.data.ledger.filter(l=>l.time>task.since).map(l=>`${nameOf(l.by)}: ${l.text}`).slice(-40);
          const text=(await lm.callUtilityTask('status_summaries','You are the town scribe. Tell a returning player what happened while they were away, in 3-4 short friendly sentences (under 420 characters). Mention the most important events by name. Plain text only.',
            {player:task.player,awayFor:`${Math.round((Date.now()-task.since)/60000)} minutes`,events:since,about:aboutPlayer(task.player)})).replace(/\s+/g,' ').trim().slice(0,440);
          town.awaySummary[task.player]={since:task.since,time:Date.now(),text};
          conversation({from:greeter.id,to:task.player,kind:'reply',text});
          for(const chunk of text.match(/.{1,230}(\s|$)/g)??[text])await act(greeter.id,{type:'whisper',x:0,y:0,z:0,to:task.player,text:chunk.trim()}).catch(()=>{});
          await say(greeter.id,`Welcome back, ${task.player}!`);
          return;
        }
        const text=await lm.speak({...persona(greeter.id),occasion:`${task.player} just arrived in town`,about:aboutPlayer(task.player),
          instruction:'Greet them by name in one short line, referring to something you know about them if anything (their builds, gifts or promises).'},'town_speech');
        await say(greeter.id,text);return;
      }
      if(task.kind==='campaign'){
        const text=await lm.speak({...persona(task.id),occasion:'election day: campaign speech for governor',town:{news:town.news.slice(-4).map(n=>n.text),season:season()},instruction:'Give a one-line campaign promise.'},'town_speech');
        await say(task.id,text);return;
      }
      if(task.kind==='investigate'){
        const c=town.cases.find(x=>x.id===task.case);if(!c)return;
        const text=await lm.speak({...persona(task.id),occasion:'morning meeting: emeralds are missing from the treasury',clue:`${c.amount} emeralds are gone; ${nameOf(c.thief)} was seen near the warehouse late at night`,instruction:'Report the theft and name the suspect, calmly.'},'town_speech');
        await say(task.id,text);ledger(task.id,`investigated the theft of ${c.amount} emeralds and named ${nameOf(c.thief)} as the suspect`);return;
      }
      if(task.kind==='ruling'){
        const c=town.cases.find(x=>x.id===task.case);if(!c)return;
        const returned=await act(c.thief,{type:'pay',x:0,y:0,z:0,target:'EMERALD',count:c.amount}).then(()=>true).catch(()=>false);
        const fine=await act(c.thief,{type:'pay',x:0,y:0,z:0,target:'EMERALD',count:1}).then(()=>1).catch(()=>0);
        for(const other of residents())if(other.id!==c.thief)intel()?.social.adjust(other.id,c.thief,{trust:-8,reliability:-10},'theft',`stole ${c.amount} emeralds`);
        c.status=returned?'solved':'unrecovered';c.fine=fine;
        const text=await lm.speak({...persona(task.id),occasion:'ruling on a theft at the morning meeting',case:{thief:nameOf(c.thief),amount:c.amount,returned,fine},instruction:'Announce a fair ruling in one or two short sentences: what must be repaid and that trust must be earned back.'},'town_speech');
        await say(task.id,text);ledger(task.id,`ruled on the theft: ${nameOf(c.thief)} ${returned?'returned':'could not return'} ${c.amount} emeralds${fine?' and paid a fine':''}`);
        const t=await lm.speak({...persona(c.thief),occasion:'caught stealing from the treasury',instruction:'Apologise sincerely in one short line.'},'town_speech');await say(c.thief,t);
      }
    },
    view(){
      const players=Object.entries(memory.data.people).map(([name,p])=>({name,reputation:p.reputation,standing:reputationTitle(p.reputation),facts:p.facts.slice(-6).reverse(),lastSeen:p.lastSeen,away:town.awaySummary[name]??null}));
      return {season:season(),raining:raining(),mayor:town.mayor,area:town.area,visitor:town.visitor,election:town.election,elections:town.elections.slice(-5).reverse(),
        governor:town.governor?nameOf(town.governor):null,cases:town.cases.filter(c=>c.status!=='unsolved').slice(-5).reverse().map(c=>({...c,thief:nameOf(c.thief)})),
        pets:Object.entries(town.pets).map(([k,v])=>({owner:nameOf(k.split(':')[0]),kind:k.split(':')[1].toLowerCase(),name:v.name})),
        news:town.news.slice(-10).reverse(),people:players,mayorWishes:town.mayorWishes.slice(-5).reverse()};
    },
  };
}
