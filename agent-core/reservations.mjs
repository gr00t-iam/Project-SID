// Material reservations for construction phases, with suppliers, couriers and kept or broken promises.
//
//   open(key, {builder, project, phase, need})  the builder asks for the materials of the NEXT phase (a request the
//                                               suppliers learn of; nobody reads the builder's queue directly)
//   refresh(key, stock, have)                   reserves what the warehouse holds for this request (other requests'
//                                               reservations are not touched) and returns what is still short
//   promise(key, {who, role, item, count, dueMs})  a supplier (crafter, miner) or courier commits to bring something
//   delivered(key, item, n, by)                 a confirmed delivery (the give was acknowledged): promises kept
//   expire()                                    promises past their due time are broken (an event for social memory)
//   availableFor(id, item, stock)               what someone may take from the warehouse without eating into
//                                               another builder's reservation
// State lives in memory (town.reservations), so it survives restarts.

// Raw materials only digging supplies (the miner's excavation), as opposed to what the crafter fells or crafts.
export const MINED=new Set(['COBBLESTONE','COBBLED_DEEPSLATE','CLAY_BALL','SAND','GRAVEL','COAL','RAW_IRON','RAW_COPPER','FLINT','STONE_DIRECT']);

export function createReservations(state,{now=()=>Date.now(),log=()=>{},onPromise=()=>{}}={}){
  state.list??={};
  const L=()=>state.list;
  function open(key,{builder,project,phase,need}){
    const r=L()[key]??={key,builder,project,phase,need:{},reserved:{},delivered:{},promises:[],created:now()};
    r.builder=builder;r.project=project;
    if(r.phase!==phase){r.phase=phase;r.reserved={};}   // a new phase: reserve afresh
    r.need=Object.fromEntries(Object.entries(need).filter(([,n])=>n>0));r.updated=now();
    return r;
  }
  const reservedByOthers=(item,key)=>Object.values(L()).filter(r=>r.key!==key).reduce((s,r)=>s+(r.reserved[item]??0),0);
  /** Reserves warehouse stock for this request; returns {reserved, short:{item:n}} (short = need - carried - reserved). */
  function refresh(key,stock={},have={}){
    const r=L()[key];if(!r)return {reserved:{},short:{}};
    const short={};
    for(const [item,n] of Object.entries(r.need)){
      const want=Math.max(0,n-(have[item]??0));
      const free=Math.max(0,(stock[item]??0)-reservedByOthers(item,key));
      r.reserved[item]=Math.min(want,free);
      if(want>r.reserved[item])short[item]=want-r.reserved[item];
    }
    for(const item of Object.keys(r.reserved))if(!(item in r.need))delete r.reserved[item];
    r.short=short;return {reserved:{...r.reserved},short};
  }
  /** Warehouse stock someone may take: everything except what is reserved for other people's requests. */
  function availableFor(id,item,stock={}){
    const others=Object.values(L()).filter(r=>r.builder!==id&&!r.couriers?.includes(id)).reduce((s,r)=>s+(r.reserved[item]??0),0);
    return Math.max(0,(stock[item]??0)-others);
  }
  function promise(key,{who,role,item,count,dueMs=900000}){
    const r=L()[key];if(!r)return null;
    let p=r.promises.find(x=>x.who===who&&x.item===item&&x.state==='open');
    if(p){p.count=Math.max(p.count,count);return p;}
    p={who,role,item,count,made:now(),due:now()+dueMs,state:'open',got:0};r.promises.push(p);
    if(role==='courier')(r.couriers??=[]).includes(who)||r.couriers.push(who);
    log('supply_promised',{key,who,role,item,count,dueInMin:Math.round(dueMs/60000)});
    return p;
  }
  /** A confirmed delivery to the builder (or into the warehouse for this request). Settles promises it fulfils. */
  function delivered(key,item,n,by){
    const r=L()[key];if(!r||n<1)return [];
    r.delivered[item]=(r.delivered[item]??0)+n;
    r.reserved[item]=Math.max(0,(r.reserved[item]??0)-n);
    const events=[];
    for(const p of r.promises.filter(x=>x.state==='open'&&x.item===item&&(x.who===by||x.role==='supplier'))){
      p.got+=n;if(p.got>=p.count){p.state=now()<=p.due?'kept':'late';p.closed=now();events.push({...p,key,builder:r.builder});onPromise(r.builder,p);}
    }
    log('delivery_confirmed',{key,item,count:n,by});
    return events;
  }
  /** Promises past due are broken. Returns them (each also reported through onPromise). */
  function expire(){
    const out=[];
    for(const r of Object.values(L()))for(const p of r.promises.filter(x=>x.state==='open'&&x.due<now())){p.state='broken';p.closed=now();out.push({...p,key:r.key,builder:r.builder});onPromise(r.builder,p);}
    return out;
  }
  const assigned=key=>{const r=L()[key];if(!r)return {};const a={};
    for(const p of r.promises.filter(x=>x.state==='open')){if(p.role==='courier')a.courier=p.who;else if(p.role==='miner'){a.miner=p.who;a.minerSite=p.site;}else a.supplier=p.who;}
    return a;};
  function close(key){delete L()[key];}
  /** Open requests as the suppliers see them (what was asked, what is still short). */
  const requests=()=>Object.values(L()).filter(r=>Object.keys(r.short??{}).length).map(r=>({key:r.key,builder:r.builder,project:r.project,phase:r.phase,short:{...r.short}}));
  const view=()=>Object.values(L()).map(r=>({key:r.key,project:r.project,phase:r.phase,builder:r.builder,need:r.need,reserved:r.reserved,short:r.short,delivered:r.delivered,
    promises:r.promises.slice(-8).map(p=>({who:p.who,role:p.role,item:p.item,count:p.count,state:p.state}))}));
  return {open,refresh,availableFor,promise,delivered,expire,assigned,close,requests,view,get:key=>L()[key]};
}

/**
 * The builder's request for a construction phase, as one step (used by civic.mjs and the tests alike): reserve what the
 * warehouse holds, and for what is short promise the crafter (anything with a recipe or wood to fell) and the miner (dug
 * materials, directly or as inputs); a courier promise covers carrying the reserved goods to the site.
 * deps: {supplySteps, recipeFor} from materials.mjs. roles: {crafter, miner, courier} ids (or undefined).
 * Returns {reserved, missing (promised, on its way), unsupplied (nobody can make or dig it), assigned, waiting}.
 */
export function requestPhase(res,{key,builder,project,phase,need,stock={},have={},roles={},dueMs=600000},{supplySteps,recipeFor}){
  res.open(key,{builder,project,phase,need});
  const {reserved,short}=res.refresh(key,stock,have);
  const missing={},unsupplied={};
  for(const [item,n] of Object.entries(short)){
    const plan=supplySteps(item,n,{...stock});
    const dug=Object.entries(plan.short).filter(([k])=>MINED.has(k)),nobody=Object.keys(plan.short).filter(k=>!MINED.has(k));
    if(nobody.length){unsupplied[item]=n;continue;}
    const crafted=!!recipeFor(item)||Object.keys(plan.gather).length>0;
    if(crafted&&roles.crafter)res.promise(key,{who:roles.crafter,role:'supplier',item,count:n,dueMs:dueMs*2});
    for(const [raw,k] of dug)if(roles.miner)res.promise(key,{who:roles.miner,role:'miner',item:raw,count:k,dueMs:dueMs*3});
    if((crafted&&roles.crafter)||(dug.length&&roles.miner))missing[item]=n;else unsupplied[item]=n;
  }
  const toBring=Object.entries(reserved).filter(([,n])=>n>0);
  if(toBring.length&&roles.courier)res.promise(key,{who:roles.courier,role:'courier',item:'*reserved',count:1,dueMs});
  const assigned={...res.assigned(key),...(toBring.length&&roles.courier?{courier:roles.courier}:{})};
  return {reserved,missing,unsupplied,assigned,waiting:Object.keys(missing).length+Object.keys(unsupplied).length>0||toBring.length>0};
}
