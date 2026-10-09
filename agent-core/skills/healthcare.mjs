// Healthcare: Rosa the Herbalist is the town's medic. Her remedies (brewing, gathering, the night guard's potions)
// stay in roles/specialists.mjs; this is the clinic and the emergency side:
//
//   triage           who needs care now, worst first: critical wounds (health 4 of 20 or less), starvation (food 3
//                    of 20 or less), then the ordinary hurt (12 or less)
//   medic job        a critical or starving citizen interrupts whatever the medic is doing (a "triage" job above
//                    routines in main's worker): she goes to them - or to their bed in the infirmary - and treats:
//                    a healing remedy for wounds, food from her pack or the warehouse for hunger
//   patient job      a critically wounded citizen stops work and goes to a free infirmary bed (once it is built)
//                    and stays there until treated and back above the hurt line; their project or dig waits in
//                    their state and resumes afterwards
//   records          every admission, treatment and discharge, with the numbers (the ledger and the chronicle)
//
// Pure functions are exported for tests; createHealthcare() runs it in town.

export const CRITICAL=4,HURT=12,STARVING=3;   // health and food, of 20
const FOOD_ORDER=['COOKED_BEEF','COOKED_PORKCHOP','COOKED_MUTTON','COOKED_CHICKEN','COOKED_SALMON','COOKED_COD','BAKED_POTATO','BREAD','CARROT','APPLE','SWEET_BERRIES'];

/** Citizens who need care now, worst first. needsOf(id) -> {hunger} (food points, 20 = full). */
export function triage(agents,{needsOf=()=>({}),exclude=[]}={}){
  const out=[];
  for(const a of agents){
    if(exclude.includes(a.id)||!Number.isFinite(a.health)||a.health<=0)continue;
    const hunger=needsOf(a.id)?.hunger;
    if(a.health<=CRITICAL)out.push({id:a.id,kind:'critical',severity:3+(CRITICAL-a.health)/CRITICAL,health:a.health,hunger});
    else if(Number.isFinite(hunger)&&hunger<=STARVING)out.push({id:a.id,kind:'starving',severity:2+(STARVING-hunger)/STARVING,health:a.health,hunger});
    else if(a.health<=HURT)out.push({id:a.id,kind:'hurt',severity:1+(HURT-a.health)/HURT,health:a.health,hunger});
  }
  return out.sort((x,y)=>y.severity-x.severity);
}
/** What the medic can do for a case with what she carries: {action:'dose', potion} | {action:'feed', item} | {action:'none', reason}. */
export function treatmentFor(kase,{potions={},inventory={}}={}){
  if(kase.kind==='starving'){const item=FOOD_ORDER.find(k=>(inventory[k]??0)>0);return item?{action:'feed',item,count:Math.min(4,inventory[item])}:{action:'none',reason:'no food in her pack'};}
  const potion=(potions.HEALING??0)>0?'HEALING':(potions.SPLASH_HEALING??0)>0?'SPLASH_HEALING':null;
  return potion?{action:'dose',potion}:{action:'none',reason:'no healing remedy brewed'};
}

export function createHealthcare(d){
  const {memory,configs,act,say=async()=>{},log=()=>{},ledger=()=>{},getSnapshot=()=>null,travel,now=()=>Date.now()}=d;
  const town=memory.data.town??={};
  const H=town.health??={records:[],admitted:{},stats:{treated:0,fed:0,admitted:0,discharged:0}};
  const conf=id=>configs.find(c=>c.id===id);
  const nameOf=id=>d.nameOf?.(id)??conf(id)?.name?.split(' the ')[0]??id;
  const medic=()=>configs.find(c=>c.role==='herbalist')??null;
  const posOf=id=>getSnapshot()?.agents?.find(a=>a.id===id)??null;
  const moving=self=>self.pathing||['moving','loading'].includes(self.navigation?.status);
  const flat=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const said=new Map(),ready=(k,ms)=>{const t=said.get(k)??0;if(now()-t<ms)return false;said.set(k,now());return true;};
  const room=()=>d.infirmaryLayout?.()??null;
  function record(kind,patient,extra={}){
    const r={time:new Date(now()).toISOString(),kind,patient,name:nameOf(patient),...extra};
    H.records=[r,...H.records].slice(0,60);log(`health_${kind}`,{patient,...extra});return r;
  }
  /** Current cases (the medic herself is treated by her own remedies, not here). */
  const cases=()=>triage((getSnapshot()?.agents??[]).filter(a=>conf(a.id)&&conf(a.id).role!=='visitor'),{needsOf:id=>memory.data.agents[id]?.needs,exclude:[medic()?.id].filter(Boolean)});
  /** A free bed for a patient (their own if already admitted). */
  function bedFor(id){
    const r=room();if(!r)return null;
    if(H.admitted[id])return r.beds.find(b=>b.bed===H.admitted[id].bed)??null;
    const taken=new Set(Object.values(H.admitted).map(a=>a.bed));return r.beds.find(b=>!taken.has(b.bed))??null;
  }

  /** The medic's triage job: a critical or starving case interrupts her day (null when there is none). */
  function medicJob(c,s,self){
    if(c.role!=='herbalist')return null;
    // Her calls are the wounded: critical first, then the hurt when she has a remedy for them. The starving are fed by
    // the courier's rounds and the warehouse (her rounds had become mostly food runs).
    const remedy=((self.potions?.HEALING??0)+(self.potions?.SPLASH_HEALING??0))>0;
    const all=cases(),urgent=all.find(k=>k.kind==='critical')??(remedy?all.find(k=>k.kind==='hurt'):null)??(d.feedsStarving?.()===false?all.find(k=>k.kind==='starving'):null);
    if(!urgent)return null;
    return async()=>{
      const p=posOf(urgent.id);if(!p)return;
      const where=H.admitted[urgent.id]&&bedFor(urgent.id)?bedFor(urgent.id):p;
      if(flat(self,where)>3){if(!moving(self))await travel(c.id,self,{x:where.x+1,y:Math.round(where.y??self.y),z:where.z}).catch(()=>{});
        if(ready(`triage-say:${urgent.id}`,120000))say(c.id,urgent.kind==='critical'?`${nameOf(urgent.id)} is badly hurt - I'm coming!`:urgent.kind==='hurt'?`${nameOf(urgent.id)}, hold on - I'm coming to dress those wounds.`:`${nameOf(urgent.id)} is starving. I'm bringing food.`).catch(()=>{});
        return;}
      let t=treatmentFor(urgent,{potions:self.potions??{},inventory:self.inventory??{}});
      // No food on her: the warehouse pantry first.
      if(t.action==='none'&&urgent.kind==='starving'&&d.fetchFood){const got=await d.fetchFood(c.id,self).catch(()=>null);if(got)t={action:'feed',item:got.item,count:Math.min(4,got.count)};}
      if(t.action==='dose'){
        const r=await act(c.id,{type:'dose',x:0,y:0,z:0,target:t.potion,to:urgent.id}).catch(e=>({error:e.message}));
        if(r?.error){log('health_treatment_failed',{patient:urgent.id,why:r.error});return;}
        H.stats.treated++;record('treated',urgent.id,{by:c.id,condition:urgent.kind,health:urgent.health,remedy:t.potion,at:H.admitted[urgent.id]?'the infirmary':'the scene'});
        ledger(c.id,`treated ${nameOf(urgent.id)} (${urgent.kind}, health ${Math.round(urgent.health)}/20) with a ${t.potion.toLowerCase().replace(/_/g,' ')} remedy${H.admitted[urgent.id]?' at the infirmary':''}`);
        await say(c.id,`Hold still, ${nameOf(urgent.id)}. This will close those wounds.`).catch(()=>{});
      }else if(t.action==='feed'){
        const r=await act(c.id,{type:'wage',x:0,y:0,z:0,to:urgent.id,target:t.item,count:t.count}).catch(e=>({error:e.message}));
        if(r?.error){log('health_treatment_failed',{patient:urgent.id,why:r.error});return;}
        H.stats.fed++;record('fed',urgent.id,{by:c.id,condition:'starving',hunger:urgent.hunger,food:`${t.count} ${t.item.toLowerCase().replace(/_/g,' ')}`});
        ledger(c.id,`brought ${t.count} ${t.item.toLowerCase().replace(/_/g,' ')} to ${nameOf(urgent.id)}, who was starving`);
        await say(c.id,`Eat this, ${nameOf(urgent.id)}, slowly now.`).catch(()=>{});
      }else if(ready(`triage-none:${urgent.id}`,300000)){
        log('health_untreated',{patient:urgent.id,condition:urgent.kind,why:t.reason});
        await say(c.id,`${nameOf(urgent.id)} needs help and I have ${t.reason.replace(/^no /,'no ')} - I'll brew what I can.`).catch(()=>{});
      }
    };
  }
  /** The patient's job: critically wounded -> to a free infirmary bed, and stay until treated (null otherwise). */
  function patientJob(c,s,self){
    if(c.role==='herbalist'||!Number.isFinite(self.health))return null;
    const adm=H.admitted[c.id];
    // Discharged once back above the hurt line (or after 5 minutes: the bed is wanted).
    if(adm&&(self.health>HURT||now()-adm.since>300000)){
      delete H.admitted[c.id];H.stats.discharged++;record('discharged',c.id,{health:self.health,stayed:Math.round((now()-adm.since)/1000)});
      ledger(medic()?.id??c.id,`${nameOf(c.id)} left the infirmary (health ${Math.round(self.health)}/20)`);return null;
    }
    if(!adm&&self.health>CRITICAL)return null;
    const bed=bedFor(c.id);if(!bed||!medic())return null;   // no infirmary yet: the medic comes to them where they are
    if(!adm){H.admitted[c.id]={bed:bed.bed,since:now(),health:self.health};H.stats.admitted++;record('admitted',c.id,{bed:bed.bed,health:self.health});
      say(c.id,`I'm hurt badly. I'm going to the infirmary.`).catch(()=>{});}
    return async()=>{if(flat(self,bed)>1.5&&!moving(self))await travel(c.id,self,{x:bed.x,y:bed.y,z:bed.z}).catch(()=>{});};
  }
  return {
    /** The medic's triage or a patient's stay, as a job that interrupts routines (or null). */
    job(c,s,self){return medicJob(c,s,self)??patientJob(c,s,self);},
    cases,
    context(c){
      if(c.role==='herbalist'){const k=cases();return {clinic:{cases:k.slice(0,4).map(x=>`${nameOf(x.id)}: ${x.kind}`),admitted:Object.keys(H.admitted).map(nameOf),infirmary:!!room()}};}
      return H.admitted[c.id]?{health:'You are in the infirmary until your wounds are treated.'}:{};
    },
    view:()=>({cases:cases().map(k=>({...k,name:nameOf(k.id)})),admitted:Object.entries(H.admitted).map(([id,a])=>({id,name:nameOf(id),...a})),stats:H.stats,records:H.records.slice(0,12),infirmaryBuilt:!!room()}),
    state:H,
  };
}
