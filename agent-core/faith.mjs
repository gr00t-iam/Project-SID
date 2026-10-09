// Religion, culture and hobbies: the pure rules (roles/priest.mjs applies them to the world).
//
//   Faith      Each citizen has a religion {deity_or_faith, devotion, skepticism, converted_at}. The priest preaches
//              the Hearthlight; some citizens hold to the Old Ways, some to nothing. Every listener decides for
//              itself: pull (the priest's charisma and devotion, how well the faith matches its values, unhappiness,
//              trust in the priest, friends who already believe) against resistance (skepticism, devotion to another
//              faith, attachment to its own tradition). A pushy one-on-one attempt that fails raises skepticism.
//   Culture    {heritage, core_values, tradition_adherence}, from role and the citizen's value matrix.
//   Hobbies    [{name, proficiency, leisure_weight, last_practiced}]: pursued in free time, chosen by weight,
//              time since last practiced and mood; practice builds proficiency and morale.

const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
const round=(v,d=3)=>Math.round(v*10**d)/10**d;
const hash=s=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)/4294967295;};

export const FAITHS={
  hearthlight:{id:'hearthlight',name:'the Hearthlight',about:'the hearth-fire that keeps a town together: shared bread, open doors and the harvest',
    values:['community','sociability','tradition'],symbol:'a lantern'},
  old_ways:{id:'old_ways',name:'the Old Ways',about:'the spirits of stone, river and forest, and the customs of the ancestors',
    values:['tradition','selfPreservation','curiosity'],symbol:'a standing stone'},
};
const FAITH_BY_NAME=Object.fromEntries(Object.values(FAITHS).map(f=>[f.name,f]));
export const faithOf=name=>FAITH_BY_NAME[name]??null;

// Heritage by role (where their family's customs come from).
const HERITAGE={farmer:'plains farmsteads',fisher:'lakeshore folk',miner:'hill clans',smith:'hill clans',guardian:'border watch',scout:'forest wanderers',
  herbalist:'forest wanderers',merchant:'river traders',courier:'river traders',crafter:'town guilds',builder:'town guilds',governor:'old town families',
  scribe:'old town families',priest:'hearth temple'};

// Hobbies: what they are, where they are practiced, the plugin effect, and which values draw a citizen to them.
export const HOBBIES={
  reading:{spot:'home',effect:'reading',values:{curiosity:1,tradition:0.3},roles:['scribe','governor','priest']},
  gardening:{spot:'garden',effect:'gardening',values:{community:0.4,craftsmanship:0.4},roles:['herbalist','farmer']},
  music:{spot:'square',effect:'music',values:{sociability:1},roles:['merchant','courier']},
  whittling:{spot:'home',effect:'whittling',values:{craftsmanship:1},roles:['crafter','builder','guardian','smith']},
  angling:{spot:'water',effect:'angling',values:{curiosity:0.4,selfPreservation:0.3},roles:['fisher']},
  stargazing:{spot:'open',effect:'stargazing',values:{curiosity:1},roles:['scout']},
  storytelling:{spot:'square',effect:'music',values:{sociability:0.6,tradition:0.6},roles:['governor','scribe']},
  cooking:{spot:'home',effect:'cooking',values:{community:0.8},roles:['farmer','courier']},
  prayer:{spot:'shrine',effect:'blessing',values:{tradition:0.8},roles:['priest'],faith:true},
};

/** A citizen's starting faith, culture and hobbies (deterministic per id); fields in `given` (agents.json) win. */
export function seedProfile(id,role,values,given={}){
  const v={selfPreservation:0.5,community:0.5,craftsmanship:0.5,curiosity:0.5,sociability:0.5,tradition:0.5,...values},j=k=>(hash(id+k)-0.5)*0.2;
  let religion;
  if(role==='priest')religion={deity_or_faith:FAITHS.hearthlight.name,devotion:0.95,skepticism:0.05,converted_at:null};
  else if(v.tradition+j('t')>0.62)religion={deity_or_faith:FAITHS.old_ways.name,devotion:round(clamp(0.3+0.5*(v.tradition-0.5)+j('d'),0.15,0.85)),skepticism:round(clamp(0.2+0.4*v.curiosity*(1-v.tradition)+j('s'),0.05,0.8)),converted_at:null};
  else religion={deity_or_faith:null,devotion:0,skepticism:round(clamp(0.3+0.5*v.curiosity*(1-v.tradition)+j('s'),0.1,0.9)),converted_at:null};
  const core=Object.entries(v).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>k);
  const culture={heritage:HERITAGE[role]??'townsfolk',core_values:core,tradition_adherence:round(clamp(v.tradition+j('a')))};
  // Two or three hobbies: the role's own, then the best matches for the citizen's values.
  const score=([name,h])=>(h.roles.includes(role)?1:0)+Object.entries(h.values).reduce((s,[k,w])=>s+w*(v[k]??0.5),0)/2+j(name);
  const picked=Object.entries(HOBBIES).filter(([,h])=>!h.faith||role==='priest').sort((a,b)=>score(b)-score(a)).slice(0,2+(hash(id+'n')>0.6?1:0));
  const hobbies=picked.map(([name],i)=>({name,proficiency:round(clamp(0.2+0.4*hash(id+name))),leisure_weight:round(1-i*0.25),last_practiced:0}));
  return {religion:{...religion,...(given.religion??{})},culture:{...culture,...(given.culture??{})},hobbies:given.hobbies??hobbies};
}

/**
 * Chance (0-1) that `citizen` turns to `faith` after hearing `priest`. Independent per citizen.
 * ctx: {morale 0-100, trust 0-100 (in the priest), believers 0-1 (share of friends nearby who believe), pushy}.
 */
export function conversionChance(priest,citizen,faith,{morale=60,trust=50,believers=0,pushy=false,persuadability=1}={}){
  const r=citizen.religion,c=citizen.culture;
  if(r.deity_or_faith===faith.name)return 0;
  const match=faith.values.filter(x=>c.core_values.includes(x)).length/faith.values.length;
  const unhappy=clamp((60-morale)/60);
  const pull=0.2*(priest.charisma??0.7)+0.1*(priest.religion?.devotion??0.9)+0.25*match+0.2*unhappy+0.15*clamp(trust/100)+0.1*clamp(believers)-(pushy?0.08:0);
  const other=r.deity_or_faith&&r.deity_or_faith!==faith.name;
  // Leaving another faith costs more than finding one: devotion to it and the step itself both hold a citizen back.
  const resist=0.5*r.skepticism+(other?0.55*r.devotion+0.1:0)+0.15*c.tradition_adherence*(other?1:0.3);
  // A hungry, exhausted or miserable citizen is in no mood for sermons (skills/needs.mjs moodOf).
  return round(clamp(persuadability/(1+Math.exp(-6*(pull-resist-0.35))),0.01,0.9));
}
/** Applies a conversion. */
export function convert(profile,faith,now){profile.religion={deity_or_faith:faith.name,devotion:0.35,skepticism:round(profile.religion.skepticism*0.7),converted_at:now};return profile;}

/**
 * A sermon: every listener decides on its own. listeners: [{id, profile, morale, trust, believers}].
 * Believers grow more devout; others may convert (at about a third of the one-on-one chance: a sermon is general).
 * Returns [{id, outcome: 'devoted'|'converted'|'unmoved', chance}] and mutates the profiles.
 */
export function sermon(priest,listeners,faith,{random=Math.random,now=Date.now()}={}){
  return listeners.map(l=>{
    if(l.profile.religion.deity_or_faith===faith.name){l.profile.religion.devotion=round(clamp(l.profile.religion.devotion+0.05*(1-l.profile.religion.devotion)));return {id:l.id,outcome:'devoted',chance:1};}
    const chance=round(conversionChance(priest,l.profile,faith,l)*0.35);
    if(random()<chance){convert(l.profile,faith,now);return {id:l.id,outcome:'converted',chance};}
    return {id:l.id,outcome:'unmoved',chance};
  });
}
/** One-on-one persuasion: the full chance; a failed, pushy attempt raises skepticism (and costs a little trust). */
export function persuade(priest,target,faith,ctx={},{random=Math.random,now=Date.now()}={}){
  const chance=conversionChance(priest,target.profile??target,faith,{...ctx,pushy:ctx.pushy??true});
  const p=target.profile??target;
  if(random()<chance){convert(p,faith,now);return {outcome:'converted',chance};}
  p.religion.skepticism=round(clamp(p.religion.skepticism+0.05));
  return {outcome:'resisted',chance};
}
/** Devotion fades a little each day without worship; a believer with no devotion left and doubts lapses. */
export function fade(profile,days=1){
  const r=profile.religion;if(!r.deity_or_faith||days<=0)return profile;
  r.devotion=round(clamp(r.devotion-0.01*days));
  if(r.devotion<0.05&&r.skepticism>0.6){r.deity_or_faith=null;r.devotion=0;}
  return profile;
}

/**
 * Which hobby to pursue now (or null): the one with the highest pull, from its weight, how long since it was
 * practiced (hours) and the citizen's mood (low morale makes leisure more appealing). Outdoor hobbies wait for
 * dry weather; stargazing is for the evening.
 */
export function chooseHobby(hobbies,{morale=60,now=Date.now(),raining=false,phase='day'}={}){
  let best=null;
  for(const h of hobbies??[]){
    const kind=HOBBIES[h.name];if(!kind)continue;
    if(raining&&['garden','square','open','water'].includes(kind.spot))continue;
    if(h.name==='stargazing'&&!['dusk','evening','night'].includes(phase))continue;
    const hours=h.last_practiced?(now-h.last_practiced)/3600000:24;
    const pull=h.leisure_weight*Math.min(1,hours/2)*(1+clamp((60-morale)/60));
    if(hours<0.5)continue;
    if(!best||pull>best.pull)best={hobby:h,pull};
  }
  return best&&best.pull>=0.25?best.hobby:null;
}
/** Practicing: proficiency grows (faster at first); returns the morale it gives. */
export function practice(hobby,now=Date.now()){
  hobby.proficiency=round(clamp(hobby.proficiency+0.04*(1-hobby.proficiency)));hobby.last_practiced=now;
  return round(3+4*hobby.proficiency,1);
}
/** Census: believers per faith. */
export function census(profiles){
  const out={};for(const p of profiles){const k=p?.religion?.deity_or_faith??'no faith';out[k]=(out[k]??0)+1;}return out;
}
