// Sister Maren the Priest, and the town's faith, culture and hobbies in daily life (rules in ../faith.mjs).
//
//   dawn       a sermon at the shrine (or the square until the shrine stands); every citizen in earshot decides
//              for itself whether it is moved (sermon in faith.mjs)
//   day        blesses festivals and meetings; visits the citizen most open to the faith for a quiet talk
//              (at most one attempt per person every 30 minutes; a failed, pushy attempt makes them warier)
//   every 5th day   a Hearthlight festival at the square (the town's festival system; attendees grow closer)
//   free time  any citizen with nothing to do may take up one of its hobbies at a fitting spot (leisureJob)
// Visible in the world through the plugin's effect action (particles) and local chat.
import {FAITHS,faithOf,HOBBIES,seedProfile,conversionChance,sermon,persuade,chooseHobby,practice,fade,census} from '../faith.mjs';
import {dayPhase} from '../town.mjs';

export const AGENT={id:'priest',role:'priest',name:'Sister Maren',every:2,camp:true,post:[283,90],charisma:0.8,
  personality:'Serene, warm and persuasive. Speaks of the hearth-fire, shared bread and open doors; listens more than she talks and never mocks another belief.',
  goal:'Tend the Hearthlight. Your sermons, blessings and visits run on their own: you preach at dawn, bless gatherings and talk with anyone troubled. In your own turns, comfort people, celebrate the harvest and good deeds, invite people to the next sermon and respect those who choose otherwise.'};
export const PLUGIN_SETTINGS={'display-names':{priest:'Sister Maren'},uniforms:{priest:'#F5E6C8'},'starter-items':{priest:['BREAD:6','LANTERN:2','CANDLE:4']}};
const HEARING=12;
const SPOTS={square:{x:283.5,z:93.5},water:{x:276.5,z:83.5},open:{x:268.5,z:96.5}};

export function createPriest(d){
  const {memory,configs,act,say,log,ledger,getSnapshot,travel,lm,cognition=()=>null,intel=()=>null,civic=()=>null,homeOf=()=>null,homeBuilt=()=>false,now=()=>Date.now(),random=Math.random}=d;
  const town=memory.data.town??={};
  const faith=town.faith??={log:[],lastSermonDay:null,lastFestivalDay:null,lastFade:null,attempts:{}};
  const stateOf=id=>memory.data.agents[id];
  const conf=id=>configs.find(c=>c.id===id);
  const nameOf=id=>conf(id)?.name?.split(' the ')[0]??id;
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const HEARTH=FAITHS.hearthlight;
  const record=(kind,text,data={})=>{faith.log=[{time:now(),day:town.day,kind,text,...data},...faith.log].slice(0,40);log('faith',{kind,text,...data});};
  const effect=(id,kind,at)=>act(id,{type:'effect',x:at?.x??0,y:at?.y??0,z:at?.z??0,target:kind}).catch(()=>{});

  /** The citizen's faith, culture and hobbies (seeded once; fields in agents.json override). */
  function profileOf(id){
    const s=stateOf(id),c=conf(id);if(!s||!c)return null;
    return s.faith??=seedProfile(id,c.role??id,cognition()?.valuesOf?.(id)??{},{religion:c.religion,culture:c.culture,hobbies:c.hobbies});
  }
  const priestInfo=()=>({charisma:conf('priest')?.charisma??0.8,religion:profileOf('priest')?.religion});
  const moraleOf=id=>cognition()?.affectOf?.(id)?.morale??60;
  const trustIn=(id,other)=>intel()?.social?.view(id,other)?.trust_score??50;
  const shrine=()=>{const st=civic()?.sites?.shrine;return st&&town.built?.shrine?{x:st.x+2.5,z:st.z+2.5}:SPOTS.square;};
  const citizensNear=(pos,r=HEARING,except='priest')=>(getSnapshot()?.agents??[]).filter(a=>a.id!==except&&conf(a.id)&&conf(a.id).role!=='visitor'&&dist(a,pos)<=r);
  const moraleUp=(id,amount)=>{const a=cognition()?.affectOf?.(id);if(a)a.morale=Math.min(100,Math.round((a.morale+amount)*10)/10);};

  async function sermonText(){
    const fallback=['The hearth-fire burns for all of us: share your bread, keep your door open, and no one here goes cold.',
      'We raise walls together and we eat together. That is the whole of the Hearthlight, friends.',
      'Look after the one beside you today. The warmth you give comes back to the town.'][town.day%3];
    try{
      const t=await lm.callUtilityTask('town_speech','You are Sister Maren, a gentle village priest of the Hearthlight (reverence for the hearth-fire, shared bread, open doors and the harvest). Write a short dawn sermon of one or two sentences (under 220 characters) for the townsfolk, drawing on the news given. Warm, never preachy about other beliefs. Reply with the words only.',
        {day:town.day,season:town.season,news:(town.news??[]).slice(-3).map(n=>n.text),pantry:town.stock?.items?'healthy':undefined});
      return String(t).replace(/[\r\n]+/g,' ').replace(/^["“]|["”]$/g,'').trim().slice(0,230)||fallback;
    }catch{return fallback;}
  }
  /** The dawn sermon: everyone within earshot decides for itself. */
  async function preach(c,self){
    const place=shrine();
    if(dist(self,place)>4){if(!self.pathing)await travel(c.id,self,{x:place.x,y:Math.round(self.y),z:place.z}).catch(()=>{});return 'walking';}
    const heard=citizensNear(self);
    faith.lastSermonDay=town.day;
    await say(c.id,await sermonText());effect(c.id,'sermon',self);
    if(!heard.length){record('sermon','Sister Maren preached to an empty square');return 'no one came';}
    const believers=heard.filter(a=>profileOf(a.id)?.religion.deity_or_faith===HEARTH.name).length/heard.length;
    const listeners=heard.map(a=>({id:a.id,profile:profileOf(a.id),morale:moraleOf(a.id),trust:trustIn(a.id,'priest'),believers}));
    const results=sermon(priestInfo(),listeners,HEARTH,{random,now:now()});
    for(const r of results){
      if(r.outcome==='converted'){effect(r.id,'conversion',getSnapshot()?.agents.find(a=>a.id===r.id));moraleUp(r.id,6);
        cognition()?.remember?.(r.id,{text:`Found the Hearthlight at Sister Maren's sermon`,who:['priest'],tags:['faith'],emotion:0.7,novelty:0.6,social:0.6,valence:1});
        intel()?.social?.adjustPair(r.id,'priest',{trust:3},'faith_shared','converted at a sermon');}
      else moraleUp(r.id,r.outcome==='devoted'?3:1);
    }
    const conv=results.filter(r=>r.outcome==='converted').map(r=>nameOf(r.id));
    record('sermon',`Sister Maren preached to ${heard.length}${conv.length?`; ${conv.join(', ')} found the Hearthlight`:''}`,{listeners:heard.length,converted:conv.length});
    if(conv.length)ledger('priest',`${conv.join(', ')} joined the Hearthlight after the dawn sermon`);
    return {listeners:heard.length,converted:conv};
  }
  /** Who is most open to the faith right now (not a believer, not asked in the last 30 minutes). */
  function mostOpen(self){
    const candidates=citizensNear(self,60).filter(a=>profileOf(a.id)?.religion.deity_or_faith!==HEARTH.name&&now()-(faith.attempts[a.id]??0)>30*60000);
    return candidates.map(a=>({a,p:conversionChance(priestInfo(),profileOf(a.id),HEARTH,{morale:moraleOf(a.id),trust:trustIn(a.id,'priest'),pushy:false})}))
      .sort((x,y)=>y.p-x.p)[0]??null;
  }
  /** A one-on-one talk about the faith. */
  async function visit(c,self,targetId){
    const t=getSnapshot()?.agents.find(a=>a.id===targetId);if(!t)return 'not here';
    if(dist(self,t)>3){if(!self.pathing)await travel(c.id,self,{x:t.x+1.5,y:Math.round(t.y),z:t.z+1.5}).catch(()=>{});return 'walking';}
    faith.attempts[targetId]=now();
    const p=profileOf(targetId),hobby=p.hobbies?.[0]?.name;
    await say(c.id,`${nameOf(targetId)}, the Hearthlight asks nothing but a warm hearth and a shared table${hobby?` - and there is room for your ${hobby} in it`:''}. Will you come to the dawn sermon?`);
    const r=persuade(priestInfo(),{profile:p},HEARTH,{morale:moraleOf(targetId),trust:trustIn(targetId,'priest'),persuadability:d.persuadability?.(targetId)??1},{random,now:now()});
    if(r.outcome==='converted'){
      effect(targetId,'conversion',t);moraleUp(targetId,5);
      await say(targetId,'You know... I think I will. Thank you, Sister.').catch(()=>{});
      intel()?.social?.adjustPair(targetId,'priest',{trust:3},'faith_shared','talked about the Hearthlight');
      cognition()?.remember?.(targetId,{text:'Sister Maren talked me into the Hearthlight',who:['priest'],tags:['faith'],emotion:0.6,social:0.7,valence:1});
      record('conversion',`${nameOf(targetId)} joined the Hearthlight after talking with Sister Maren`,{target:targetId,chance:r.chance});ledger('priest',`${nameOf(targetId)} joined the Hearthlight`);
    }else{
      intel()?.social?.adjust(targetId,'priest',{trust:-1},'faith_pressed','turned down the Hearthlight');
      record('resisted',`${nameOf(targetId)} politely declined the Hearthlight`,{target:targetId,chance:r.chance});
    }
    return r;
  }
  /** Blessing a gathering: believers there grow more devout, everyone feels a little better. */
  async function bless(c,self,place,what){
    if(dist(self,place)>5){if(!self.pathing)await travel(c.id,self,{x:place.x,y:Math.round(self.y),z:place.z}).catch(()=>{});return 'walking';}
    const here=citizensNear(self,10);faith.lastBlessing=`${town.day}:${what}`;
    effect(c.id,'blessing',self);await say(c.id,`May the hearth-fire warm this ${what} and everyone in it.`);
    for(const a of here){const r=profileOf(a.id)?.religion;if(r?.deity_or_faith===HEARTH.name)r.devotion=Math.min(1,Math.round((r.devotion+0.03)*1000)/1000);moraleUp(a.id,2);}
    record('blessing',`Sister Maren blessed the ${what} (${here.length} there)`);return 'blessed';
  }
  /** Every fifth day a Hearthlight festival: the town's festival system does the gathering. */
  function maybeFestival(){
    if(!civic()?.scheduleFestival||(town.day??0)%5!==0||faith.lastFestivalDay===town.day)return;
    faith.lastFestivalDay=town.day;civic().scheduleFestival('Hearthlight festival','the hearth-fire and the harvest',null);
    record('festival',`A Hearthlight festival is planned for day ${town.day}`);
  }
  /** Once a town day: devotion fades a little without worship; lapsed believers drift away. */
  function dailyFade(){
    if(faith.lastFade===town.day)return;faith.lastFade=town.day;
    for(const c of configs){const p=profileOf(c.id);if(p&&c.id!=='priest')fade(p,1);}
  }

  /** The priest's work for this worker tick (null for everyone else). */
  function job(c,s,self,night){
    if(c.id!=='priest')return null;
    if(!town.requestedShrine&&civic()?.requestBuild){town.requestedShrine=true;civic().requestBuild('shrine','Sister Maren').catch(()=>{});}
    dailyFade();maybeFestival();
    // Night: a vigil at her post by the square (she has no house on the village street, like the other camp roles).
    if(night){const post={x:(conf('priest')?.post?.[0]??283)+0.5,z:(conf('priest')?.post?.[1]??90)+0.5};
      return async()=>{if(dist(self,post)>3&&!self.pathing)await travel(c.id,self,{x:post.x,y:Math.round(self.y),z:post.z}).catch(()=>{});};}
    const phase=dayPhase(getSnapshot()?.worldTime);
    if(faith.lastSermonDay!==town.day&&['dawn','morning','day'].includes(phase))return async()=>{faith.busy='preaching';await preach(c,self);faith.busy=null;};
    if(town.festival?.held&&faith.lastBlessing!==`${town.day}:festival`)return ()=>bless(c,self,town.festival.place,'festival');
    if(town.meeting&&faith.lastBlessing!==`${town.day}:meeting`)return ()=>bless(c,self,SPOTS.square,'meeting');
    if(now()-(faith.lastVisit??0)>180000){const o=mostOpen(self);if(o){faith.lastVisit=now();faith.visiting=o.a.id;}}
    if(faith.visiting&&now()-(faith.lastVisit??0)<120000)return async()=>{const r=await visit(c,self,faith.visiting);if(r!=='walking')faith.visiting=null;};
    return null;
  }

  // ---------------------------------------------------------------- hobbies in free time
  function spotFor(id,self,kind){
    const h=homeOf(id);
    if(kind==='home')return h&&homeBuilt(id)?{x:h.cx,z:h.cz}:self;
    if(kind==='garden'){const plot=(town.farmPlots??[])[0];return plot?{x:plot.x1-1.5,z:(plot.z1+plot.z2)/2}:(h?{x:h.cx+3,z:h.cz}:self);}
    if(kind==='shrine')return shrine();
    return SPOTS[kind]??self;
  }
  /** A hobby for a free citizen in its leisure time, or null. */
  function leisureJob(c,s,self,{night=false,raining=false}={}){
    if(c.role==='guardian'||night)return null;
    const p=profileOf(c.id);if(!p)return null;
    const busy=s.leisure;
    if(busy&&now()<busy.until){const h=p.hobbies.find(x=>x.name===busy.hobby);const at=busy.at;
      return async()=>{if(dist(self,at)>3){if(!self.pathing)await travel(c.id,self,{x:at.x,y:Math.round(self.y),z:at.z}).catch(()=>{});return;}
        if(!busy.done){busy.done=true;effect(c.id,HOBBIES[busy.hobby]?.effect??'hobby',self);const gain=practice(h,now());moraleUp(c.id,gain);
          log('hobby',{agent:c.id,hobby:busy.hobby,proficiency:h.proficiency});
          if(random()<0.3)cognition()?.remember?.(c.id,{text:`Spent a while ${busy.hobby==='music'?'playing music':busy.hobby}`,tags:['hobby'],emotion:0.3,novelty:0.1});}};}
    if(busy)s.leisure=null;
    const phase=dayPhase(getSnapshot()?.worldTime);
    const h=chooseHobby(p.hobbies,{morale:moraleOf(c.id),now:now(),raining,phase});if(!h)return null;
    const at=spotFor(c.id,self,HOBBIES[h.name]?.spot);
    s.leisure={hobby:h.name,at:{x:at.x,z:at.z},until:now()+90000,done:false};
    return async()=>{if(!self.pathing)await travel(c.id,self,{x:at.x,y:Math.round(self.y),z:at.z}).catch(()=>{});};
  }

  // ---------------------------------------------------------------- actions from plans (preach, attempt_conversion, ...)
  async function action(id,a,self){
    if(a.type==='preach'){if(id!=='priest')throw Error('Only Sister Maren preaches; you can invite people to her sermon in chat');return preach(conf(id),self);}
    if(a.type==='attempt_conversion'){
      if(!a.to||!conf(a.to))throw Error('attempt_conversion needs the citizen id in to');
      if(id!=='priest'){const mine=profileOf(id)?.religion;if(mine?.deity_or_faith!==HEARTH.name)throw Error('Only believers share the Hearthlight');}
      if(now()-(faith.attempts[a.to]??0)<30*60000)throw Error(`${nameOf(a.to)} was asked recently; give them time`);
      return visit(conf(id),self,a.to);
    }
    if(a.type==='practice_hobby'){
      const p=profileOf(id),h=(p?.hobbies??[]).find(x=>!a.target||x.name===String(a.target).toLowerCase())??p?.hobbies?.[0];
      if(!h)throw Error('No hobby to practice');effect(id,HOBBIES[h.name]?.effect??'hobby',self);const gain=practice(h,now());moraleUp(id,gain);return {hobby:h.name,proficiency:h.proficiency};
    }
    if(a.type==='cultural_festival'){
      if(!['priest','governor'].includes(id))throw Error('Festivals are called by Sister Maren or the governor');
      if(!civic()?.scheduleFestival)throw Error('No festival system');
      civic().scheduleFestival(id==='priest'?'Hearthlight festival':'harvest festival',a.text||'the town together',null);return 'festival planned';
    }
    throw Error('Unknown faith action');
  }

  // ---------------------------------------------------------------- views
  function context(c){
    const p=profileOf(c.id);if(!p)return {};
    const r=p.religion,f=faithOf(r.deity_or_faith);
    return {faithAndCulture:{faith:r.deity_or_faith?`${r.deity_or_faith} (devotion ${Math.round(r.devotion*100)}%)`:'none',...(f?{faithIs:f.about}:{}),
      heritage:p.culture.heritage,hobbies:p.hobbies.map(h=>`${h.name} (${Math.round(h.proficiency*100)}%)`),
      townFaith:census(configs.map(x=>profileOf(x.id)).filter(Boolean)),
      ...(c.id==='priest'?{nextSermon:faith.lastSermonDay===town.day?'tomorrow at dawn':'today',recent:faith.log.slice(0,3).map(e=>e.text)}:{})}};
  }
  const agentView=id=>{const p=profileOf(id);return p?{faith:{religion:p.religion,culture:p.culture,hobbies:p.hobbies}}:{};};
  function view(){
    return {census:census(configs.map(c=>profileOf(c.id)).filter(Boolean)),log:faith.log.slice(0,15),lastSermonDay:faith.lastSermonDay,faiths:Object.values(FAITHS).map(f=>({name:f.name,about:f.about}))};
  }
  async function command(data,args,tell){
    const c=census(configs.map(x=>profileOf(x.id)).filter(Boolean));
    await tell(`Faith in town: ${Object.entries(c).map(([k,n])=>`${k} ${n}`).join(', ')}. Sister Maren preaches at dawn${town.built?.shrine?' at the shrine':' at the square'}.`);return true;
  }
  return {job,leisureJob,action,context,agentView,view,command,commands:['faith'],profileOf,preach,visit,bless};
}
