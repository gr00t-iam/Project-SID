// The life-simulation layer: needs and the daily rhythm, the evening gathering, gossip, grudges and favours, and
// dwellings with private chests. Rules live in skills/needs.mjs, skills/gossip.mjs, skills/property.mjs and
// intel/social.mjs (relationships); this module applies them to the town.
//
//   tick (every 5 s)   loneliness and comfort, schedule_phase per citizen
//   job                DAWN_PREP: breakfast; DUSK_SOCIAL: walk to the tavern (or the square / shrine / market hall
//                      until it stands), keep company, swap stories (rumors), music and toasts
//   onEvent(log)       real events become rumors (thefts, trials, arrests, quarrels, bank audits, conversions,
//                      kindness) and leave grudges/favours (arrests, verdicts, sermons that went too far)
//   property           every citizen's dwelling {dwelling_id, bed_coordinates, private_chest_coordinates}; the builder
//                      puts a chest at the foot of every bed; "stash"/"take_from_chest" respect ownership
import {schedulePhase,needsOf,decaySocialComfort,moodOf,drives} from './skills/needs.mjs';
import {seedRumor,retell,impactOf,pickToTell,learn} from './skills/gossip.mjs';
import {dwellingOf,accessOf} from './skills/property.mjs';
import {traitsFor,joinsGathering} from './skills/traits.mjs';

const HUBS=[{name:'the town square',x:283.5,z:93.5},{name:'the market hall',x:271.5,z:106.5},{name:'the shrine',x:268.5,z:90.5,site:'shrine'}];
const NOT_AT_GATHERINGS=new Set(['guardian','sheriff','visitor']);

export function createLifeSim(d){
  const {memory,configs,act,say,log,ledger,getSnapshot,travel,now=()=>Date.now(),random=Math.random}=d;
  const town=memory.data.town??={};
  const L=town.lifesim??={rumorSeq:1,breakfast:{},furnished:{},chests:{},lastTell:0,gatherings:[]};
  const conf=id=>configs.find(c=>c.id===id);
  const roleOf=id=>{const c=conf(id);return c?c.role??c.id:id;};
  const nameOf=id=>d.nameOf?.(id)??conf(id)?.name?.split(' the ')[0]??id;
  const stateOf=id=>memory.data.agents[id];
  const citizens=()=>configs.filter(c=>(c.role??c.id)!=='visitor');
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const snapAgents=()=>getSnapshot()?.agents??[];
  const social=()=>d.social?.();
  const moving=self=>self.pathing||['moving','loading'].includes(self.navigation?.status);
  let lastTick=now();
  /** Stable traits (skills/traits.mjs), derived once and kept. */
  const traitsOf=id=>{const s=stateOf(id);if(!s)return null;return s.traits??=traitsFor(id,d.valuesOf?.(id)??{},s.personality??conf(id)?.personality??'');};
  // Limited knowledge: what a citizen knows of the warehouse is what it saw there itself, or what someone told it.
  const knowWarehouse=(id,items,source)=>{const s=stateOf(id);if(s)(s.knowledge??={}).warehouse={items:{...items},at:now(),source};};
  function knownStock(id){
    const k=stateOf(id)?.knowledge?.warehouse;if(!k)return {known:false,note:'You have not seen the warehouse lately; go and look, or ask someone who has.'};
    const mins=Math.round((now()-k.at)/60000),top=Object.fromEntries(Object.entries(k.items).sort((a,b)=>b[1]-a[1]).slice(0,30));
    return {known:true,items:top,asOf:`${mins} min ago`,source:k.source==='seen'?'seen yourself':`told by ${nameOf(k.source.replace(/^told:/,''))}`};
  }
  function shareKnowledge(from,to){
    const a=stateOf(from)?.knowledge?.warehouse,b=stateOf(to)?.knowledge?.warehouse;
    if(a&&(!b||a.at>b.at+60000)){const s=stateOf(to);(s.knowledge??={}).warehouse={items:{...a.items},at:a.at,source:`told:${from}`};return true;}
    return false;
  }

  // ---------- needs and the schedule ----------
  function tick(){
    const t=now(),dt=Math.min(60,(t-lastTick)/1000);if(dt<5)return;lastTick=t;
    const snap=getSnapshot();if(!snap)return;
    const phase=schedulePhase(snap.worldTime),raining=!!(snap.weather?.storm||snap.weather?.rain);
    for(const c of citizens()){
      const s=stateOf(c.id),self=snap.agents.find(a=>a.id===c.id);if(!s||!self)continue;
      s.schedule_phase=phase;traitsOf(c.id);
      const w=d.warehouseSpot?.();if(w&&Math.hypot(self.x-w.x,self.z-w.z)<=8&&Math.abs(self.y-(w.y??self.y))<4)knowWarehouse(c.id,d.stock?.()??{},'seen');
      const company=snap.agents.filter(a=>a.id!==c.id&&conf(a.id)&&dist(a,self)<=6&&Math.abs(a.y-self.y)<4).length;
      const lot=d.homeOf?.(c.id),atHome=!!lot&&self.x>=lot.x&&self.x<lot.x+5&&self.z>=lot.z&&self.z<lot.z+5;
      const sc=decaySocialComfort(s.needs??{},dt,{company,socializing:t-(s.socializing??0)<60000,raining,sheltered:atHome||!!d.sheltered?.(c.id)||self.y<56,
        hurt:Math.max(0,1-(self.health??20)/20),atHome,ownBed:!!d.homeBuilt?.(c.id),resting:!!s.resting});
      s.needs={...(s.needs??{hunger:20,energy:100}),...sc};
    }
  }
  const needs=id=>needsOf(stateOf(id)?.needs);
  const moodFor=id=>{const a=d.affectOf?.(id);return moodOf(needs(id),{morale:a?.morale,stress:a?.stress});};

  // ---------- DAWN_PREP and DUSK_SOCIAL ----------
  function hub(){
    const tavern=d.tavernSpot?.();if(tavern)return {name:'the tavern',...tavern};
    const open=HUBS.filter(h=>!h.site||town.built?.[h.site]);
    return open[(town.day??0)%open.length];
  }
  function job(c,s,self,night){
    if(roleOf(c.id)==='visitor'||d.restricted?.(c.id))return null;
    const phase=schedulePhase(getSnapshot()?.worldTime);
    if(phase==='DAWN_PREP'&&L.breakfast[c.id]!==town.day&&needs(c.id).hunger>=0.25&&!s.project&&!s.dig){
      L.breakfast[c.id]=town.day;
      return async()=>{await d.eatJob?.(c,s,self);log('breakfast',{agent:c.id,hunger:needs(c.id).hunger});};
    }
    if(phase!=='DUSK_SOCIAL'||NOT_AT_GATHERINGS.has(roleOf(c.id))||town.alert||town.festival?.day===town.day&&!town.festival?.held)return null;
    if(self.y<56||needs(c.id).hunger>=0.8||d.inCombat?.(c.id))return null;
    if(!joinsGathering(traitsOf(c.id),town.day,c.id))return null;   // not everyone goes every night
    const h=hub(),i=citizens().findIndex(x=>x.id===c.id),angle=2*Math.PI*i/Math.max(1,citizens().length);
    const spot={x:h.x+Math.cos(angle)*3.5,z:h.z+Math.sin(angle)*3.5};
    return async()=>{
      if(dist(self,spot)>2.5){if(!moving(self))await travel(c.id,self,{x:spot.x,y:Math.round(self.y),z:spot.z}).catch(()=>{});return;}
      const first=now()-(s.socializing??0)>300000;s.socializing=now();
      if(first)gathered(c.id,h);
      await mingle(c,self,h);
    };
  }
  function gathered(id,h){
    const g=L.gatherings[0];
    if(!g||g.day!==town.day){L.gatherings=[{day:town.day,place:h.name,people:[id],rumors:0},...L.gatherings].slice(0,10);log('gathering',{day:town.day,place:h.name});}
    else if(!g.people.includes(id))g.people.push(id);
  }
  /** At the gathering: every so often someone tells the person beside them a story; now and then a song or a toast. */
  async function mingle(c,self,h){
    const s=stateOf(c.id);if(now()-(s.lastMingle??0)<45000)return;s.lastMingle=now();
    const near=snapAgents().filter(a=>a.id!==c.id&&conf(a.id)&&!NOT_AT_GATHERINGS.has(roleOf(a.id))&&dist(a,self)<=7);
    if(!near.length)return;
    const other=near[Math.floor(random()*near.length)];
    d.befriend?.(c.id,other.id,0.3);
    if(shareKnowledge(c.id,other.id))log('knowledge_shared',{from:c.id,to:other.id,about:'warehouse'});
    const food=Object.keys(self.inventory??{}).find(k=>/^(BREAD|COOKED_[A-Z_]+|BAKED_POTATO|APPLE)$/.test(k)&&self.inventory[k]>1);
    if(food&&needs(other.id).hunger>=0.4&&random()<(traitsOf(c.id)?.generosity??0.5)*0.6){
      const ok=await act(c.id,{type:'give',x:0,y:0,z:0,target:food,count:1,to:other.id}).then(()=>true).catch(()=>false);
      if(ok){social()?.mark?.(other.id,c.id,'favor',`shared ${String(food).toLowerCase().replace(/_/g,' ')} at the gathering`,0.15);log('food_shared',{from:c.id,to:other.id,item:food});return;}
    }
    const told=exchange(c.id,other.id,{aloud:now()-L.lastTell>90000});
    if(!told&&random()<0.25)act(c.id,{type:'effect',x:self.x,y:self.y,z:self.z,target:random()<0.5?'music':'festival'}).catch(()=>{});
  }

  // ---------- gossip ----------
  const rumorsOf=id=>stateOf(id)?.rumors??[];
  function hear(id,rumor){const s=stateOf(id);if(s)s.rumors=learn(s.rumors,rumor);}
  /** A real event becomes a true rumor in the heads of those who saw it. */
  function seed(event_type,{subject,origin,vars={},witnesses=[]}){
    if(!subject||!origin||!conf(origin))return null;
    const r=seedRumor({id:`R-${String(L.rumorSeq++).padStart(4,'0')}`,origin,subject,event_type,vars:{s:nameOf(subject),...vars},time:now()});
    for(const w of new Set([origin,...witnesses]))if(conf(w)&&w!==subject)hear(w,r);
    log('rumor_started',{id:r.id,event_type,subject,origin,details:r.details});
    return r;
  }
  /** teller tells listener the juiciest story the listener has not heard. Returns the listener's copy, or null. */
  function exchange(teller,listener,{aloud=false}={}){
    const r=pickToTell(rumorsOf(teller),rumorsOf(listener),{except:[listener]});if(!r)return null;
    const rel=social()?.relationship?.(teller,r.subject_id);
    const bias=Math.max(0,-(rel?.affinity??0));
    const reliability=(social()?.view?.(listener,teller)?.reliability_score??50)/100;
    const copy=retell(r,{teller,bias,tellerReliability:reliability,random,time:now()});
    hear(listener,copy);
    // Believing it: how the listener sees the subject changes, more if they trust the teller.
    const trustInTeller=(social()?.view?.(listener,teller)?.trust_score??50)/100;
    const impact=impactOf(copy,{trustInTeller});
    if(impact&&copy.subject_id!==listener)social()?.adjust?.(listener,copy.subject_id,{trust:impact*12,reliability:impact*6},'rumor',copy.details);
    if(L.gatherings[0]?.day===town.day)L.gatherings[0].rumors++;
    log('rumor_spread',{id:copy.id,from:teller,to:listener,level:copy.level,veracity:copy.veracity,details:copy.details,distorted:copy.level>r.level});
    if(aloud){L.lastTell=now();say(teller,`${nameOf(listener)}, did you hear? ${copy.details[0].toUpperCase()+copy.details.slice(1)}${copy.details.endsWith('!')?'':'.'}`).catch(()=>{});}
    return copy;
  }
  /** The log stream: real events seed rumors and leave grudges or favours. */
  function onEvent(type,x){
    try{
      const s=social();
      if(type==='conflict'&&x.conflict_id){
        const c=d.conflict?.(x.conflict_id);const witnesses=(c?.evidence??[]).filter(e=>e.kind==='sighting').map(e=>e.by);
        if(x.kind==='theft')return;   // a theft is secret until the court hears it
        seed('quarrel',{subject:x.party_a,origin:witnesses[0]??x.party_b,witnesses,vars:{o:nameOf(x.party_b),r:x.reason}});
      }
      if(type==='trial_held'&&x.fault&&x.fault!=='both'){
        const c=d.conflict?.(x.conflict_id);if(!c)return;
        const event=c.kind==='theft'?'theft':'verdict';
        seed(event,{subject:x.fault,origin:x.magistrate,witnesses:[c.party_a,c.party_b].filter(p=>p!==x.fault),vars:{r:c.reason,n:c.amount??'some'}});
        const other=x.fault===c.party_a?c.party_b:c.party_a;
        s?.mark?.(x.fault,other,'grudge',`took me to court (${x.conflict_id})`,0.4);
        if(conf(other))s?.mark?.(other,x.fault,'grudge',`wronged me (${x.conflict_id})`,0.3);
        s?.mark?.(x.fault,x.magistrate,'grudge',`ruled against me (${x.conflict_id})`,0.2);
        if(conf(other))s?.mark?.(other,x.magistrate,'favor',`gave me justice (${x.conflict_id})`,0.25);
      }
      if(type==='arrested'){seed('arrest',{subject:x.suspect,origin:x.by,vars:{r:d.conflict?.(x.conflict_id)?.reason??'a crime'}});s?.mark?.(x.suspect,x.by,'grudge','arrested me',0.5);}
      if(type==='jailed'&&x.how==='bailiff')seed('arrest',{subject:x.jailed_citizen_id,origin:d.magistrate?.()??x.jailed_citizen_id,vars:{r:x.reason}});
      if(type==='bank_audit'&&!x.ok){const b=configs.find(c=>roleOf(c.id)==='banker');if(b)seed('bank_error',{subject:b.id,origin:configs.find(c=>roleOf(c.id)==='scribe')?.id??b.id});}
      if(type==='faith'&&x.kind==='conversion'&&x.target){seed('conversion',{subject:x.target,origin:'priest',vars:{r:'Hearthlight'}});s?.mark?.(x.target,'priest','favor','showed me the Hearthlight',0.3);}
      if(type==='faith'&&x.kind==='resisted'&&x.target&&random()<0.5)s?.mark?.(x.target,'priest','grudge','kept pressing the Hearthlight on me',0.15);
      if(type==='favor'&&x.source&&x.target&&/food|shared|delivered/.test(x.reason??'')&&random()<0.3)seed('kindness',{subject:x.target,origin:x.source,vars:{o:nameOf(x.source),r:'what they needed'}});
      if(type==='dialogue'&&x.a&&x.b){exchange(x.a,x.b);exchange(x.b,x.a);shareKnowledge(x.a,x.b);shareKnowledge(x.b,x.a);}
      if(type==='complaint_filed'&&x.by&&x.against)s?.mark?.(x.by,x.against,'grudge',`gave me reason to complain (${x.conflict_id})`,0.3);
    }catch(error){log('lifesim_error',{where:type,message:error.message});}
  }

  /** A vote on someone's proposal: the proposer remembers who backed it and who voted it down (and talk of it spreads). */
  function onVote(proposer,voter,vote,p){
    const s=social();if(!s||!conf(proposer)||!conf(voter))return;
    if(vote==='yes')s.remember(proposer,voter,'favor',`backed my proposal #${p.id}`,0.1);
    else{s.mark(proposer,voter,'grudge',`voted against my proposal #${p.id}`,0.15);if(random()<0.3)seed('vote',{subject:voter,origin:proposer,vars:{r:String(p.title??p.text??'proposal').slice(0,50)}});}
  }
  // ---------- dwellings and private chests ----------
  function dwelling(id){
    const lot=d.homeOf?.(id),c=conf(id);
    const dw=dwellingOf(id,lot,{floorY:L.chests[id]?.y??null,post:c?.post});
    return {...dw,built:!!d.homeBuilt?.(id),chest:L.chests[id]??null};
  }
  /** Built homes without a private chest: find the bed's height, then ask the builder for a chest at its foot. */
  async function furnish(){
    for(const c of citizens()){
      if(!d.homeBuilt?.(c.id)||L.chests[c.id]?.registered)continue;
      const dw=dwellingOf(c.id,d.homeOf?.(c.id));if(!dw.private_chest_coordinates)continue;
      const f=L.furnished[c.id]??={tries:0};if(f.tries>=4||now()-(f.at??0)<300000)continue;f.at=now();f.tries++;
      // The owner looks (the builder's own actions queue behind its building work); never wait more than 20 s.
      const ask=a=>Promise.race([act(c.id,a),new Promise((_,no)=>setTimeout(()=>no(Error('no answer')),20000))]);
      const scan=await ask({type:'scan',x:dw.bed_coordinates.x,y:58,z:dw.bed_coordinates.z,width:1,height:16,depth:1}).catch(()=>null);
      const bed=(scan?.cells??[]).find(cell=>cell.some(v=>typeof v==='string'&&/_BED$/.test(v)));if(!bed){log('furnish_skipped',{home:c.id,why:'no bed found'});continue;}
      const y=bed[1],at={...dw.private_chest_coordinates,y};
      const here=await ask({type:'property',x:at.x,y:at.y,z:at.z,text:'contents'}).then(()=>true).catch(()=>false);
      if(here){await ask({type:'property',x:at.x,y:at.y,z:at.z,text:'register'}).catch(()=>{});L.chests[c.id]={...at,registered:true};log('private_chest',{owner:c.id,...at});continue;}
      town.repairs??=[];if(!town.repairs.some(b=>b.x===at.x&&b.y===at.y&&b.z===at.z))town.repairs.push({x:at.x,y:at.y,z:at.z,block:'CHEST'});
      L.chests[c.id]={...at,registered:false};log('furnish_requested',{home:c.id,...at});
    }
  }
  /** stash / take_from_chest: the owner freely; the sheriff with a warrant (a search); anyone else commits a theft. */
  async function chestAction(id,action,self){
    const owner=action.type==='stash'?id:(action.to||id),ch=L.chests[owner];
    if(!ch?.registered)throw Error(owner===id?'You have no private chest yet (it comes with your house)':`${nameOf(owner)} has no private chest`);
    if(Math.hypot(self.x-(ch.x+0.5),self.z-(ch.z+0.5))>4||Math.abs(self.y-ch.y)>3)throw Error(`Walk to the chest first (${ch.x},${ch.y},${ch.z})`);
    const item=String(action.target).toUpperCase(),n=action.count||1;
    const access=accessOf(id,owner,{role:roleOf(id),warrantFor:d.warrantsFor?.()??[]});
    const r=await act(id,{type:action.type==='stash'?'deposit':'withdraw',x:ch.x,y:ch.y,z:ch.z,target:item,count:n});
    if(access==='search')ledger(id,`searched ${nameOf(owner)}'s chest under a court warrant`);
    if(access==='theft'){
      const k=d.justice?.()?.openConflict({a:owner,b:id,kind:'theft',reason:`${n} ${item.toLowerCase().replace(/_/g,' ')} taken from ${nameOf(owner)}'s chest`,location:ch,truth:{culprit:id},extra:{amount:0,scene:`${nameOf(owner)}'s house`}});
      if(k)d.justice?.()?.complain(owner,id,`someone took ${item.toLowerCase().replace(/_/g,' ')} from my chest`,{kind:'theft'});
      log('chest_theft',{thief:id,owner,item,count:n,conflict_id:k?.conflict_id});
    }
    return {...r,access};
  }

  // ---------- views ----------
  function context(c){
    const m=moodFor(c.id),s=stateOf(c.id),dw=dwelling(c.id);
    return {currentState:m.text,needs:needs(c.id),schedule_phase:s?.schedule_phase,urges:drives(needs(c.id)),
      rumorsYouHeard:rumorsOf(c.id).slice(0,3).map(r=>`${r.details} (from ${nameOf(r.heard_from)})`),
      dwelling:{id:dw.dwelling_id,kind:dw.kind,built:dw.built,bed:dw.bed_coordinates,chest:dw.chest?{x:dw.chest.x,y:dw.chest.y,z:dw.chest.z}:null}};
  }
  const view=()=>({
    citizens:citizens().map(c=>({id:c.id,name:nameOf(c.id),phase:stateOf(c.id)?.schedule_phase,needs:needs(c.id),mood:moodFor(c.id).text.replace('CURRENT STATE: ',''),rumors:rumorsOf(c.id).length,dwelling:dwelling(c.id)})),
    gatherings:L.gatherings.slice(0,5),hub:hub()?.name,
    rumors:Object.values(Object.fromEntries(citizens().flatMap(c=>rumorsOf(c.id)).map(r=>[r.id+':'+r.level,r]))).sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,15),
  });
  return {tick,job,needs,moodFor,onVote,traitsOf,knownStock,shareKnowledge,persuadability:id=>moodFor(id).persuadability,onEvent,seed,exchange,dwelling,furnish,chestAction,context,view,rumorsOf,hub,state:L};
}
