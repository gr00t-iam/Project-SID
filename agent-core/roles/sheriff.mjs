// Sheriff Wade Harlan: keeps the peace. His loop, in priority order:
//
//   escort_to_jail       a detained suspect follows him to the jail and is locked in a cell
//   subdue_suspect       a warrant from the court: walk up to the convicted citizen and take them in hand
//   investigate_conflict a complaint (an INVESTIGATE_DISPUTE quest): walk to the scene, take statements from the
//                        parties and witnesses (each timestamped), then file the findings - the case goes to trial
//   patrol_town          a round of the town's places by day, the square and the jail by night (and any
//                        PATROL_TERRITORY quest posted when monsters are about)
//
// The court, the evidence and the jail itself are in ../skills/justice.mjs.
import {patrolRoute} from '../skills/quests.mjs';

export const AGENT={id:'sheriff',role:'sheriff',name:'Sheriff Wade Harlan',every:3,camp:true,post:[281,98],
  personality:'Steady, fair and dry-humoured. Asks short questions, writes everything down with the time, and never takes sides before the evidence is in.',
  goal:'Keep the peace. Your patrols, investigations, arrests and escorts run on their own: you walk the town, look into complaints (statements with times), serve the court\'s warrants and keep the jail. In your own turns, talk to people, calm quarrels before they become complaints, and report what you found.'};
export const PLUGIN_SETTINGS={'display-names':{sheriff:'Sheriff Wade Harlan'},uniforms:{sheriff:'#3B4A6B'},'starter-items':{sheriff:['IRON_SWORD:1','BREAD:6','TORCH:8']}};
// The places a day patrol walks past (the square, the warehouse, the market, the roads out of town).
const BEAT=[{x:283.5,z:93.5,name:'the square'},{x:278.5,z:113.5,name:'the warehouse'},{x:278.5,z:104.5,name:'the market'},{x:283.5,z:72.5,name:'the north road'},
  {x:300.5,z:96.5,name:'the village street'},{x:262.5,z:96.5,name:'the west lanes'}];

export function createSheriff(d){
  const {memory,configs,act,say,log,ledger,getSnapshot,travel,justice,quests,board,now=()=>Date.now()}=d;
  const conf=id=>configs.find(c=>c.id===id);
  const nameOf=id=>conf(id)?.name?.split(' the ')[0]??id;
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const posOf=id=>getSnapshot()?.agents?.find(a=>a.id===id)??null;
  const moving=self=>self.pathing||['moving','loading'].includes(self.navigation?.status);
  const walkTo=(c,self,p)=>travel(c.id,self,{x:p.x,y:Math.round(p.y??self.y),z:p.z}).catch(()=>{});

  // ---------- escort_to_jail ----------
  async function escort(c,s,self){
    const e=s.escort,suspect=posOf(e.suspect);
    if(!justice().warrants().some(w=>w.suspect===e.suspect)){s.escort=null;return;}
    const door=justice().jailDoor(e.suspect);   // a courthouse holding cell or the jail
    // Marched in: close to the door with the suspect close behind, or four minutes on the way.
    if((dist(self,door)<5&&suspect&&dist(suspect,self)<8)||now()-e.since>240000||!suspect){
      const r=await justice().imprison(e.suspect,{by:c.id,how:now()-e.since>240000?'marched in':'escorted'});
      s.escort=null;
      if(r)await say(c.id,`${nameOf(e.suspect)} is in ${r.cell?.stocks?'the stocks':`cell ${r.cell?.cell}`} for ${Math.round(r.sentence_duration_ticks/1200)} minutes.`).catch(()=>{});
      return;
    }
    // The suspect keeps close behind; the sheriff walks on once they have caught up.
    if(suspect&&dist(suspect,self)>3&&!moving(suspect))travel(e.suspect,suspect,{x:self.x,y:Math.round(self.y),z:self.z}).catch(()=>{});
    if(!moving(self)&&(!suspect||dist(suspect,self)<6))await walkTo(c,self,door);
  }
  // ---------- subdue_suspect ----------
  async function serve(c,s,self,w){
    const p=posOf(w.suspect);
    s.arrest??={suspect:w.suspect,since:now(),walks:0};
    if(s.arrest.suspect!==w.suspect)s.arrest={suspect:w.suspect,since:now(),walks:0};
    if(!p){if(now()-s.arrest.since>180000){await justice().imprison(w.suspect,{by:c.id,how:'brought in'});s.arrest=null;}return;}
    if(dist(self,p)>3){
      if(now()-s.arrest.since>180000){await justice().imprison(w.suspect,{by:c.id,how:'brought in'});s.arrest=null;return;}   // could not reach them: the deputies bring them in
      if(!moving(self))await walkTo(c,self,p);return;
    }
    // Within arm's reach: take them in hand.
    justice().detain(w.suspect,c.id);
    act(c.id,{type:'effect',x:p.x,y:p.y,z:p.z,target:'arrest'}).catch(()=>{});
    await say(c.id,`${nameOf(w.suspect)}, by order of the court (${w.conflict_id}): you're coming with me. Quietly, now.`).catch(()=>{});
    ledger(c.id,`arrested ${nameOf(w.suspect)} (${w.conflict_id})`);log('arrested',{by:c.id,suspect:w.suspect,conflict_id:w.conflict_id});
    s.arrest=null;s.escort={suspect:w.suspect,conflict_id:w.conflict_id,since:now()};
  }
  // ---------- investigate_conflict ----------
  async function investigate(c,s,self,k){
    const v=s.investigation??={conflict_id:k.conflict_id,step:'scene',queue:null,walks:0,since:now()};
    if(v.conflict_id!==k.conflict_id)Object.assign(v,{conflict_id:k.conflict_id,step:'scene',queue:null,walks:0,since:now()});
    // Take the quest that goes with it (posted when the complaint came in).
    const q=board().active().find(o=>o.order_type==='INVESTIGATE_DISPUTE'&&(()=>{try{return JSON.parse(o.target_location).conflict_id===k.conflict_id;}catch{return false;}})());
    if(q&&q.status==='OPEN')try{quests().claim(c.id,q.number);}catch{}
    if(v.step==='scene'){
      const scene=k.location??{x:283.5,z:93.5};
      if(dist(self,scene)>4&&v.walks<4){v.walks++;if(!moving(self))await walkTo(c,self,scene);return;}
      v.walks=0;v.step='interviews';v.queue=justice().interviewees(k);
      act(c.id,{type:'effect',x:self.x,y:self.y,z:self.z,target:'reading'}).catch(()=>{});
      await say(c.id,`Looking into ${k.conflict_id}: ${k.reason}. It happened here at ${k.timestamp.slice(11,19)} UTC. I'll hear everyone who was about.`).catch(()=>{});
      return;
    }
    if(v.step==='interviews'){
      const who=v.queue[0];
      if(!who){v.step='file';return;}
      const p=posOf(who);
      if(p&&dist(self,p)>4&&v.walks<5&&!justice().jailed(who)){v.walks++;if(!moving(self))await walkTo(c,self,p);return;}
      v.walks=0;v.queue.shift();
      const st=justice().takeStatement(k,who,c.id);
      await say(c.id,`${nameOf(who)}, where were you at ${k.timestamp.slice(11,16)}?`).catch(()=>{});
      await say(who,st.text).catch(()=>{});
      return;
    }
    if(v.step==='file'){
      const trial=justice().fileFindings(k,c.id);
      if(q){try{quests().progress(c.id,q.number,1);await quests().turnIn(c.id,q.number);}catch(e){log('quest_error',{number:q.number,message:e.message});}}
      await say(c.id,`Findings on ${k.conflict_id} are filed. The court sits at ${trial.scheduled_at.slice(11,16)} UTC.`).catch(()=>{});
      s.investigation=null;
    }
  }
  // ---------- patrol_town ----------
  async function patrol(c,s,self,night){
    const p=s.beat??={leg:0,last:0};
    if(moving(self)||now()-p.last<15000)return;
    p.last=now();
    const route=night?patrolRoute({x:283.5,z:93.5},{points:4,radius:8}):BEAT;
    const next=route[p.leg++%route.length];
    if(p.leg%route.length===0&&now()-(p.lastShift??0)>=600000){p.lastShift=now();d.onShift?.(c.id);}   // a patrol shift: a full beat, paid at most every 10 minutes
    if(Math.random()<0.15&&!night)await say(c.id,`All quiet at ${next.name??'the square'}.`).catch(()=>{});
    await walkTo(c,self,next);
  }
  /** The sheriff's job for this worker tick (null for everyone else). */
  function job(c,s,self,night){
    if((c.role??c.id)!=='sheriff')return null;
    if(s.escort)return ()=>escort(c,s,self);
    const w=justice().warrants().find(x=>!justice().restricted(x.suspect)||s.arrest?.suspect===x.suspect);
    if(w)return ()=>serve(c,s,self,w);
    const k=(s.investigation&&justice().find(s.investigation.conflict_id)?.investigation?.status!=='done'?justice().find(s.investigation.conflict_id):null)??justice().investigations()[0];
    if(k)return ()=>investigate(c,s,self,k);
    // Patrol quests (monsters about) before the usual beat.
    const work=quests().workJob(c,s,self)??quests().maybeTakeWork(c,s);
    if(work)return work;
    return ()=>patrol(c,s,self,night);
  }
  const context=c=>(c.role??c.id)==='sheriff'?{sheriff:{beat:BEAT.map(b=>b.name).join(', '),how:'Patrols, investigations, arrests and escorts happen on their own. "complain" is for citizens; you file findings by investigating.'}}:{};
  return {job,context};
}
