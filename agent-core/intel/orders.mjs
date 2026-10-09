// Module 3: the inter-agent Work Order Board. Citizens (and players) post orders for resources, construction
// or guard duty; others claim the ones they can actually fulfil, deliver, and are paid once the issuer verifies.
// Replaces the old agent quest board: players can still fill resource orders and are rewarded as before.
//   OPEN -> CLAIMED -> DELIVERED -> SETTLING -> VERIFIED   (a claim that runs past its deadline goes back to OPEN;
//   orders nobody takes expire after two in-game days)
//   SETTLING is taken atomically by exactly one payer (beginSettle). A failed payment leaves the order UNPAID (the
//   work stays done, the wage stays owed, payment is retried); a payment whose outcome is unknown (the connection
//   dropped mid-transfer) becomes PAYMENT_UNCERTAIN and is never retried automatically - it could pay twice.
import {randomUUID} from 'node:crypto';
import {json} from './db.mjs';
import {spareOf} from '../plans.mjs';
import {CLAIM_LIMIT} from '../skills/quests.mjs';

export const PRIORITY={LOW:0,MEDIUM:1,HIGH:2,EMERGENCY:3};
// The first three are the original order kinds; the rest are quest categories (skills/quests.mjs).
export const TYPES=['RESOURCE_REQUEST','CONSTRUCTION','GUARD_DUTY','CRAFT_ITEM','PATROL_TERRITORY','INVESTIGATE_DISPUTE','COMMUNITY_SERVICE'];
// Food a hungry citizen asked for can be any of these (bread is the usual request; a baked potato fills the same belly).
export const FOOD=/^(BREAD|COOKED_[A-Z_]+|BAKED_POTATO|APPLE|CARROT|SWEET_BERRIES|MUSHROOM_STEW|PUMPKIN_PIE|GOLDEN_CARROT|MELON_SLICE)$/;
const CLAIM_MS={EMERGENCY:8*60000,HIGH:15*60000,MEDIUM:25*60000,LOW:40*60000};

// What each role can make from ingredients it can get (for claiming orders it does not hold stock for).
export const MAKES={
  crafter:{OAK_PLANKS:{OAK_LOG:1,out:4},SPRUCE_PLANKS:{SPRUCE_LOG:1,out:4},STICK:{OAK_PLANKS:2,out:4},TORCH:{COAL:1,STICK:1,out:4},BREAD:{WHEAT:3,out:1},STONE_BRICKS:{STONE:4,out:4},CHEST:{OAK_PLANKS:8,out:1}},
  smith:{IRON_INGOT:{RAW_IRON:1,out:1,smelt:true},IRON_PICKAXE:{IRON_INGOT:3,STICK:2,out:1},IRON_SWORD:{IRON_INGOT:2,STICK:1,out:1},IRON_AXE:{IRON_INGOT:3,STICK:2,out:1},IRON_HOE:{IRON_INGOT:2,STICK:2,out:1},IRON_SHOVEL:{IRON_INGOT:1,STICK:2,out:1}},
  farmer:{BREAD:{WHEAT:3,out:1}},
  fisher:{COOKED_COD:{COD:1,out:1,smelt:true},COOKED_SALMON:{SALMON:1,out:1,smelt:true}},
  // The chef bakes and cooks for anyone who asks (bread orders used to wait for a farmer with wheat in hand).
  chef:{BREAD:{WHEAT:3,out:1},BAKED_POTATO:{POTATO:1,out:1,smelt:true},COOKED_COD:{COD:1,out:1,smelt:true},COOKED_SALMON:{SALMON:1,out:1,smelt:true},COOKED_BEEF:{BEEF:1,out:1,smelt:true},COOKED_CHICKEN:{CHICKEN:1,out:1,smelt:true}},
};

/**
 * How `agent` could fill an order right now, or null: from its own spare stock, the warehouse, by making it
 * from ingredients (its own plus the warehouse), or (the courier) by collecting it from another citizen.
 */
export function fulfilmentPlan(order,agent,{stock={},agents=[]}={}){
  const need=order.quantity-order.delivered;if(need<=0)return null;
  if(order.order_type==='GUARD_DUTY')return agent.role==='guardian'?{source:'duty'}:null;
  if(agent.role==='guardian')return null;   // the guard keeps to guard duty
  if(order.order_type==='CONSTRUCTION')return agent.role==='builder'?{source:'build'}:null;
  // Patrols, community service and investigations are taken by the quest engine and the sheriff, not as deliveries.
  if(['PATROL_TERRITORY','INVESTIGATE_DISPUTE','COMMUNITY_SERVICE'].includes(order.order_type))return null;
  if(['sheriff','visitor'].includes(agent.role))return null;
  const item=order.target_item;if(!item)return null;
  if(spareOf(agent,item)>=need)return {source:'inventory',count:need};
  // A craft quest means making it (or handing over one already made), not fetching it.
  if(order.order_type==='CRAFT_ITEM'){
    const recipe=MAKES[agent.role]?.[item];if(!recipe)return null;
    const times=Math.ceil(need/recipe.out),inputs=Object.entries(recipe).filter(([k])=>!['out','smelt'].includes(k));
    return inputs.every(([k,n])=>(agent.inventory?.[k]??0)+(stock[k]??0)>=n*times)?{source:'make',count:need,times,inputs:Object.fromEntries(inputs.map(([k,n])=>[k,n*times])),smelt:!!recipe.smelt}:null;
  }
  // Fetching from the warehouse only helps someone who is not waiting on the warehouse itself.
  if(order.target_location==='agent'&&(stock[item]??0)>=need)return {source:'warehouse',count:need};
  const recipe=MAKES[agent.role]?.[item];
  if(recipe){
    const times=Math.ceil(need/recipe.out),inputs=Object.entries(recipe).filter(([k])=>!['out','smelt'].includes(k));
    if(inputs.every(([k,n])=>(agent.inventory?.[k]??0)+(stock[k]??0)>=n*times))return {source:'make',count:need,times,inputs:Object.fromEntries(inputs.map(([k,n])=>[k,n*times])),smelt:!!recipe.smelt};
  }
  // Food for a hungry citizen: other food carried or in the warehouse does just as well.
  if(FOOD.test(item)){
    const spare=Object.keys(agent.inventory??{}).find(k=>k!==item&&FOOD.test(k)&&spareOf(agent,k)>=need);
    if(spare)return {source:'inventory',count:need,item:spare};
    const kept=Object.keys(stock).find(k=>FOOD.test(k)&&(stock[k]??0)>=need);
    if(kept&&order.target_location==='agent'&&['courier','chef','farmer','merchant'].includes(agent.role))return {source:'warehouse',count:need,item:kept};
  }
  if(agent.role==='courier'){
    const holder=agents.filter(a=>a.id!==agent.id&&a.id!==order.issuer_name&&a.y>=58).map(a=>({a,n:spareOf(a,item)})).filter(x=>x.n>=Math.min(need,8)).sort((x,y)=>y.n-x.n)[0];
    if(holder)return {source:'collect',from:holder.a.id,count:Math.min(need,holder.n,64)};
  }
  return null;
}
/**
 * Picks the order `agent` should take: feasible, not its own, allowed by how it sees the issuer, and best by
 * priority, then distance to the issuer. `busy` agents only look at HIGH and EMERGENCY orders.
 */
export function chooseOrder(orders,agent,{stock,agents,terms=()=>({accept:true,upfront:0}),busy=false,now=Date.now()}={}){
  const pos=id=>agents.find(a=>a.id===id);
  let best=null;
  for(const o of orders){
    if(o.status!=='OPEN'||o.issuer_name===agent.id)continue;
    if(busy&&PRIORITY[o.priority]<PRIORITY.HIGH)continue;
    // A named contractor gets two minutes to answer first.
    const pref=json(o.history_json,[]).find(h=>h.preferred)?.preferred;
    if(pref&&pref!==agent.id&&now-o.created<120000)continue;
    const plan=fulfilmentPlan(o,agent,{stock,agents});if(!plan)continue;
    const t=terms(agent.id,o.issuer_name);if(!t.accept)continue;
    const issuer=pos(o.issuer_name),d=issuer?Math.hypot(issuer.x-agent.x,issuer.z-agent.z):30;
    const score=PRIORITY[o.priority]*100-d+(pref===agent.id?50:0)+(plan.source==='inventory'?20:0);
    if(!best||score>best.score)best={order:o,plan,terms:t,score};
  }
  return best;
}

export function createBoard(db,{now=()=>Date.now(),log=()=>{}}={}){
  const next=()=>(db.get('SELECT max(number) n FROM work_orders')?.n??0)+1;
  const hist=(o,entry)=>JSON.stringify([...json(o?.history_json,[]),{time:now(),...entry}].slice(-20));
  const get=id=>db.get('SELECT * FROM work_orders WHERE order_id=? OR number=?',String(id),Number(id)||-1);
  /** Posts an order (or tops up the issuer's own open order for the same item). Returns the order. */
  function post({issuer,type='RESOURCE_REQUEST',item=null,quantity=1,location=null,reward=0,priority='MEDIUM',note='',preferred=null,goalId=null,targetLocation}){
    if(!TYPES.includes(type))throw Error(`Order type must be ${TYPES.join(', ')}`);
    if(!(priority in PRIORITY))priority='MEDIUM';
    const loc=targetLocation??location??(type==='RESOURCE_REQUEST'?'warehouse':null);
    if(item){
      const same=db.get("SELECT * FROM work_orders WHERE issuer_name=? AND order_type=? AND target_item=? AND status IN ('OPEN','CLAIMED') ORDER BY created DESC LIMIT 1",issuer,type,item);
      if(same){
        const q=Math.min(128,Math.max(same.quantity,same.delivered+quantity));
        const p=PRIORITY[priority]>PRIORITY[same.priority]?priority:same.priority;
        db.run('UPDATE work_orders SET quantity=?,priority=?,updated=? WHERE order_id=?',q,p,now(),same.order_id);
        return {...get(same.order_id),merged:true};
      }
    }
    if(db.get("SELECT count(*) n FROM work_orders WHERE status='OPEN'").n>=24)return null;
    const id=randomUUID(),t=now();
    db.run(`INSERT INTO work_orders(order_id,number,issuer_name,order_type,target_item,quantity,target_location,reward_emeralds,priority,status,note,goal_id,created,updated,history_json)
      VALUES(?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?)`,id,next(),issuer,type,item,Math.max(1,Math.min(128,Math.round(quantity))),typeof loc==='string'?loc:JSON.stringify(loc),
      Math.max(0,Math.round(reward)),priority,String(note).slice(0,160),goalId,t,t,hist(null,{event:'posted',by:issuer,...(preferred?{preferred}:{})}));
    const o=get(id);log('order_posted',{number:o.number,issuer,type,item,quantity:o.quantity,priority});
    return o;
  }
  function claim(id,contractor,{upfront=0,source=null}={}){
    const o=get(id);if(!o||o.status!=='OPEN')return null;
    const t=now();
    db.run("UPDATE work_orders SET status='CLAIMED',contractor_name=?,claimed_at=?,deadline=?,upfront_paid=?,updated=?,history_json=? WHERE order_id=?",
      contractor,t,t+(CLAIM_LIMIT[o.order_type]??CLAIM_MS[o.priority]??CLAIM_MS.MEDIUM),upfront,t,hist(o,{event:'claimed',by:contractor,source,upfront}),o.order_id);
    log('order_claimed',{number:o.number,contractor,issuer:o.issuer_name,item:o.target_item});
    return get(o.order_id);
  }
  /** Counts delivered items; the order becomes DELIVERED when complete. */
  function progress(id,n,by){
    const o=get(id);if(!o)return null;
    const delivered=Math.min(o.quantity,o.delivered+n),status=delivered>=o.quantity?'DELIVERED':o.status;
    db.run('UPDATE work_orders SET delivered=?,status=?,contractor_name=coalesce(contractor_name,?),updated=?,history_json=? WHERE order_id=?',delivered,status,by,now(),hist(o,{event:'delivered',by,count:n}),o.order_id);
    return get(o.order_id);
  }
  function verify(id,{paid}={}){
    const o=get(id);if(!o)return null;
    db.run("UPDATE work_orders SET status='VERIFIED',updated=?,history_json=? WHERE order_id=?",now(),hist(o,{event:'verified',paid}),o.order_id);
    log('order_verified',{number:o.number,contractor:o.contractor_name,issuer:o.issuer_name,paid});
    return get(o.order_id);
  }
  /** The contractor gave up or ran out of time: back to OPEN for someone else. */
  function release(id,reason){
    const o=get(id);if(!o||o.status!=='CLAIMED')return null;
    db.run("UPDATE work_orders SET status='OPEN',contractor_name=NULL,claimed_at=NULL,deadline=NULL,updated=?,history_json=? WHERE order_id=?",now(),hist(o,{event:'released',by:o.contractor_name,reason}),o.order_id);
    log('order_released',{number:o.number,contractor:o.contractor_name,reason});
    return o;
  }
  /**
   * Takes the right to pay this order: exactly one caller wins (a single UPDATE guarded by the current status), so
   * two paths finishing the same order at once can never both pay. Returns the order, or null when it is already
   * being settled or is settled.
   */
  function beginSettle(id){
    const o=get(id);if(!o)return null;
    const r=db.run("UPDATE work_orders SET status='SETTLING',updated=?,history_json=? WHERE order_id=? AND status IN ('OPEN','CLAIMED','DELIVERED','UNPAID')",
      now(),hist(o,{event:'settling'}),o.order_id);
    return r.changes===1?get(o.order_id):null;
  }
  /** The payment failed: the work stays done and the wage stays owed (UNPAID, retried), or PAYMENT_UNCERTAIN. */
  function markUnpaid(id,{due,contractor,reason,uncertain=false}){
    const o=get(id);if(!o)return null;
    db.run('UPDATE work_orders SET status=?,contractor_name=coalesce(contractor_name,?),updated=?,history_json=? WHERE order_id=?',uncertain?'PAYMENT_UNCERTAIN':'UNPAID',contractor,now(),
      hist(o,{event:uncertain?'payment_uncertain':'payment_failed',due,reason:String(reason??'').slice(0,120)}),o.order_id);
    log(uncertain?'order_payment_uncertain':'order_unpaid',{number:o.number,contractor,due,reason});
    return get(o.order_id);
  }
  /** The advance a contractor received, recorded after it was paid (settle pays the rest). */
  function recordUpfront(id,n){const o=get(id);if(!o)return null;db.run('UPDATE work_orders SET upfront_paid=?,updated=?,history_json=? WHERE order_id=?',n,now(),hist(o,{event:'advance_paid',count:n}),o.order_id);return get(o.order_id);}
  /** UNPAID orders whose last attempt is older than `ms` (for the retry sweep). */
  const unpaid=(ms=300000)=>db.all("SELECT * FROM work_orders WHERE status='UNPAID' AND updated<?",now()-ms);
  /** A crash between taking SETTLING and finishing leaves it stuck: after 10 minutes it needs a human look (uncertain). */
  function staleSettling(ms=600000){
    for(const o of db.all("SELECT * FROM work_orders WHERE status='SETTLING' AND updated<?",now()-ms))markUnpaid(o.order_id,{due:o.reward_emeralds-o.upfront_paid,contractor:o.contractor_name,reason:'interrupted while paying',uncertain:true});
  }
  function cancel(id,reason){const o=get(id);if(!o)return;db.run("UPDATE work_orders SET status='CANCELLED',updated=?,history_json=? WHERE order_id=?",now(),hist(o,{event:'cancelled',reason}),o.order_id);}
  /** Claims past their deadline (returned to the board) and open orders older than two in-game days. */
  function sweep(){
    const t=now(),overdue=db.all("SELECT * FROM work_orders WHERE status='CLAIMED' AND deadline<?",t);
    for(const o of overdue)release(o.order_id,'deadline passed');
    db.run("UPDATE work_orders SET status='EXPIRED',updated=? WHERE status='OPEN' AND created<?",t,t-70*60000*2);
    return overdue;
  }
  const list=({status,limit=100}={})=>status?db.all('SELECT * FROM work_orders WHERE status=? ORDER BY created DESC LIMIT ?',status,limit)
    :db.all('SELECT * FROM work_orders ORDER BY CASE status WHEN \'OPEN\' THEN 0 WHEN \'CLAIMED\' THEN 1 WHEN \'DELIVERED\' THEN 2 ELSE 3 END, created DESC LIMIT ?',limit);
  const open=()=>db.all("SELECT * FROM work_orders WHERE status='OPEN' ORDER BY created");
  const active=()=>db.all("SELECT * FROM work_orders WHERE status IN ('OPEN','CLAIMED','DELIVERED') ORDER BY created");
  const claimedBy=who=>db.get("SELECT * FROM work_orders WHERE contractor_name=? AND status='CLAIMED' ORDER BY claimed_at DESC LIMIT 1",who);
  /** One-time import of the old quest board's open quests. */
  function migrateQuests(quests){
    if(db.meta('quests_migrated'))return 0;let n=0;
    for(const q of quests??[])if(q.status==='open'){post({issuer:q.by,item:q.item,quantity:Math.max(1,q.count-(q.delivered??0)),reward:q.reward?.count??1,note:q.note??'',priority:'MEDIUM'});n++;}
    db.meta('quests_migrated',new Date(now()).toISOString());return n;
  }
  /** Adds a note to an order's history (e.g. flags already applied). */
  function note(id,entry){const o=get(id);if(o)db.run('UPDATE work_orders SET history_json=?,updated=? WHERE order_id=?',hist(o,entry),now(),o.order_id);}
  const preferredOf=o=>json(o?.history_json,[]).find(h=>h.preferred)?.preferred??null;
  const flagged=(o,flag)=>json(o?.history_json,[]).some(h=>h.flag===flag);
  return {post,claim,progress,verify,release,cancel,sweep,beginSettle,markUnpaid,unpaid,staleSettling,recordUpfront,get,list,open,active,claimedBy,migrateQuests,note,preferredOf,flagged};
}
