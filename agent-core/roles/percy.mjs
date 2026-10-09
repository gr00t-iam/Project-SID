import {addEvidence} from '../skills/justice.mjs';

export const AGENT={id:'percy',role:'tavern_regular',name:'Percy Wobblefoot',displayName:'Percy "Tipsy" Wobblefoot',nickname:'Tipsy',aliases:['tipsy','wobblefoot'],every:3,camp:true,post:[323,119],
 personality:'Percy, nicknamed Tipsy, is a lovable, boastful tavern regular with a crooked grin, exaggerated seafaring stories and terrible off-key singing. Sober, he is helpful and kind; after drinking he becomes clumsy, loud and argumentative. He never attacks people or damages property, accepts responsibility, and apologizes after sobering up.',
 goal:'Bring personality to village life. Answer to Percy or Tipsy. Share improbable stories, help neighbors while sober, and respect the sheriff and court. Your role helper manages occasional witnessed public disturbances, custody and sober cooldowns; never invent an arrest, sentence, victim or completed task in conversation.'};
export const PLUGIN_SETTINGS={'display-names':{percy:'Percy "Tipsy" Wobblefoot'},uniforms:{percy:'#8B6A46'},'starter-items':{percy:['BREAD:6','APPLE:4']}};

/** Persisted real-world clock; incidents require a real nearby citizen and the completed jail. */
export function createPercy(d){
 const now=d.now??Date.now,random=d.random??Math.random;
 const between=(a,b)=>a+Math.floor(random()*(b-a));
 function observeCustody(config,state){if(config.id==='percy'&&d.justice().restricted('percy')){const s=state.tipsy??={};s.wasInCustody=true;s.phase='jailed';}}
 function job(config,state,self,night){
  if(config.id!=='percy')return null;
  const s=state.tipsy??={phase:'sober',nextEpisode:now()+between(180000,600000),incidents:0};
  const j=d.justice();
  if(j.restricted('percy')){s.wasInCustody=true;s.phase='jailed';return null;}
  if(s.wasInCustody)return async()=>{s.wasInCustody=false;s.phase='sober';s.caseId=null;s.nextEpisode=now()+between(1200000,2700000);await d.say('percy',"I'm sorry for the racket, neighbors. I'll lend a sober hand before telling another sea story.");d.log('percy_sober',{cooldownUntil:s.nextEpisode});await d.memory.save?.();};
  if(night)return null;
  if(s.caseId){const c=j.find?.(s.caseId)??j.state.conflicts?.find(c=>c.conflict_id===s.caseId);if(c&&c.status!=='RESOLVED')return null;s.caseId=null;s.phase='sober';s.nextEpisode=now()+between(1200000,2700000);}
  const spot=d.tavernSpot();
  if(!spot||d.jailSite()?.layoutVersion!==2)return null;
  if(s.phase==='sober'&&now()<s.nextEpisode)return null; // ordinary community work during sober time
  return async()=>{
   if(Math.hypot(self.x-spot.x,self.z-spot.z)>4){await d.travel('percy',self,{...spot,y:spot.y??Math.round(self.y)});return;}
   if(s.phase==='sober'){s.phase='drinking';s.disturbanceAt=now()+between(90000,240000);await d.say('percy','Just one more tale! Did I ever tell you how I outsailed a squid?');await d.memory.save?.();return;}
   if(now()<s.disturbanceAt)return;
   const snap=d.getSnapshot(),me=snap?.agents?.find(a=>a.id==='percy');
   if(!me)return;
   const witness=snap.agents.find(a=>a.id!=='percy'&&d.configs.some(c=>c.id===a.id&&c.role!=='visitor')&&!j.restricted(a.id)&&Math.hypot(a.x-me.x,a.z-me.z)<=10);
   if(!witness){s.disturbanceAt=now()+30000;return;}
   const text='Tipsy was drunk in public, singing loudly and arguing with me at the tavern.';
   const c=j.complain(witness.id,'percy',text,{kind:'public_disturbance'});
   if(!c)return;
   c.kind='public_disturbance';c.truth={...c.truth,instigator:'percy'};
   addEvidence(c,{kind:'provocation',by:witness.id,about:'percy',time:now(),location:me,text:'I was nearby when Percy started the loud drunken argument.'});
   s.caseId=c.conflict_id;s.phase='disorderly';s.incidents++;
   await d.say('percy',"All right, that was me making the racket. No need to blame my neighbors!");
   d.log('percy_disturbance',{conflict_id:c.conflict_id,witness:witness.id,location:{x:me.x,y:me.y,z:me.z}});
   await d.memory.save?.();
  };
 }
 return {job,observeCustody};
}
