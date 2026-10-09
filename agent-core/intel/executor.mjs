// Micro executor: carries out goal milestones step by step (check_inventory -> query_memory -> navigate ->
// interact) with deterministic sub-routines, and runs work-order contracts (claim -> acquire -> deliver ->
// verify -> pay). Failures go to the reflector (Module 4); three failed reflections fail the milestone,
// which makes the goal re-plan (Module 2).
import {MAKES,fulfilmentPlan,chooseOrder} from './orders.mjs';

// Recipes any citizen can follow with the right ingredients (per craft of `out` items).
export const RECIPES={...Object.assign({},...Object.values(MAKES)),
  OAK_PLANKS:{OAK_LOG:1,out:4},STICK:{OAK_PLANKS:2,out:4},TORCH:{COAL:1,STICK:1,out:4},BREAD:{WHEAT:3,out:1},CHEST:{OAK_PLANKS:8,out:1},
  CRAFTING_TABLE:{OAK_PLANKS:4,out:1},STONE_BRICKS:{STONE:4,out:4},STONE:{COBBLESTONE:1,out:1,smelt:true},GLASS:{SAND:1,out:1,smelt:true},
  COOKED_COD:{COD:1,out:1,smelt:true},COOKED_SALMON:{SALMON:1,out:1,smelt:true},BAKED_POTATO:{POTATO:1,out:1,smelt:true},IRON_INGOT:{RAW_IRON:1,out:1,smelt:true}};
// Which world block to look for when gathering an item.
export function sourceBlock(item){
  if(/_LOG$/.test(item))return {category:'tree',block:item,how:'mine'};
  if(['POPPY','DANDELION','CORNFLOWER','OXEYE_DAISY','AZURE_BLUET','ALLIUM','LILY_OF_THE_VALLEY','RED_TULIP','ORANGE_TULIP','WHITE_TULIP','PINK_TULIP','BLUE_ORCHID','RED_MUSHROOM','BROWN_MUSHROOM','SUGAR_CANE'].includes(item))
    return {category:'plant',block:item,how:'forage'};
  if(item==='SWEET_BERRIES')return {category:'plant',block:'SWEET_BERRY_BUSH',how:'forage'};
  return null;
}
const FUEL=['COAL','CHARCOAL','OAK_PLANKS','SPRUCE_PLANKS','OAK_LOG','SPRUCE_LOG'];
/**
 * Can a citizen be sent there? Physical rules only: inside the world border and the dimension's height limits (from
 * the plugin's snapshot), and within one trip's navigation budget (NAV_BUDGET blocks, default 3000 - a longer journey
 * is planned as stops). Returns null when fine, or the reason.
 */
export function destinationCheck(dest,self,world,{budget=Number(process.env.NAV_BUDGET||3000)}={}){
  if(![dest?.x,dest?.z].every(Number.isFinite))return 'not a real place (no coordinates)';
  const b=world?.border;
  if(b&&Number.isFinite(b.size)){const half=b.size/2;if(Math.abs(dest.x-b.x)>half||Math.abs(dest.z-b.z)>half)return `outside the world border (${Math.round(half)} blocks from ${Math.round(b.x)},${Math.round(b.z)})`;}
  if(Number.isFinite(dest.y)&&world&&Number.isFinite(world.minY)&&(dest.y<world.minY||dest.y>=world.maxY))return `outside the world's height (${world.minY} to ${world.maxY})`;
  if(self&&Math.hypot(dest.x-self.x,dest.z-self.z)>budget)return `farther than one trip can go (${budget} blocks); plan a stop on the way`;
  return null;
}
const nice=k=>String(k).toLowerCase().replace(/_/g,' ');
// The plugin connection dropped while an action was in flight: the money may or may not have moved.
export const UNKNOWN_OUTCOME=/outcome may be unknown|disconnected|timed? ?out|socket|ECONNRESET/i;

export function createExecutor(d){
  const {act,say,travel,getSnapshot,spatial,board,goals,reflector,social,log,ledger,nameOf,roleOf,perform,questReward}=d;
  const civic=()=>d.civic();
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const inv=self=>self.inventory??{};
  const stock=()=>civic()?.stockItems()??{};
  const lastRun=new Map();
  const throttle=(key,ms)=>{const t=lastRun.get(key)??0;if(Date.now()-t<ms)return false;lastRun.set(key,Date.now());return true;};
  async function reach(id,self,dest,near=3){
    if(dist(self,dest)<=near)return true;
    if(!self.pathing){
      // Inside a building: its floor (a survey there finds the roof); elsewhere the surveyed ground.
      const fy=civic()?.floorAt?.(dest.x,dest.z);
      const g=fy!=null?null:await act(id,{type:'survey',x:Math.floor(dest.x),y:0,z:Math.floor(dest.z),width:1,depth:1}).catch(()=>null);
      const y=fy??(Number.isFinite(g?.heights?.[0])?g.heights[0]+1:Math.round(dest.y??self.y));
      await travel(id,self,{x:Math.floor(dest.x)+0.5,y,z:Math.floor(dest.z)+0.5}).catch(e=>{throw Object.assign(Error(e.message),{action:{type:'pathfind',x:dest.x,y,z:dest.z}});});
    }
    return false;
  }
  // ---------- milestone sub-routines: return 'done', 'working' or throw (with .action for reflection) ----------
  async function withdrawTo(id,self,item,n){
    if(!(await civic().goToWarehouse(id,self)))return 0;
    return civic().withdraw(id,item,n);
  }
  /** GATHER: inventory -> warehouse -> remembered sources -> making it -> a work order. */
  async function gather(id,self,m,st){
    const item=m.spec.item,need=m.spec.quantity-(inv(self)[item]??0);
    st.step='check_inventory';if(need<=0)return 'done';
    // Producers make it themselves: the farmer harvests her fields, the fisher's own loop catches fish.
    const role=roleOf(id);
    if(role==='farmer'&&['WHEAT','CARROT','POTATO','BEETROOT'].includes(item)){
      const farm=d.stateOf?.(id)?.farm;
      if(!farm){st.step='start_farm';await perform(id,{type:'farm',x:272,y:Math.round(self.y),z:93,target:'',text:'',to:'',blocks:[],count:1,spec:{crop:item==='WHEAT'?'WHEAT_SEEDS':item==='BEETROOT'?'BEETROOT_SEEDS':item,width:6,depth:6}});return 'working';}
      st.step='harvest';
      if(!(await reach(id,self,farm,3)))return 'working';
      if(!throttle(`harvest:${id}`,20000))return 'waiting';
      await act(id,{type:'tend',x:Math.floor(farm.x),y:Math.floor(self.y),z:Math.floor(farm.z),width:farm.width??6,depth:farm.depth??6,target:farm.crop??'WHEAT_SEEDS'}).catch(()=>{});
      return 'waiting';   // crops take time; check back
    }
    if(role==='fisher'&&/^(COOKED_)?(COD|SALMON)$/.test(item)){st.step='fishing';return 'waiting';}
    if(st.orderId){
      st.step='wait_for_delivery';
      const o=board.get(st.orderId);
      if(!o||['VERIFIED','DELIVERED'].includes(o.status)){st.orderId=null;return 'working';}
      if(Date.now()-st.orderSince>30*60000)throw Object.assign(Error(`Nobody delivered ${nice(item)} (order #${o.number})`),{action:{type:'wait',target:item}});
      return 'waiting';
    }
    if((stock()[item]??0)>0&&!st.warehouseEmpty){
      st.step='navigate:warehouse';
      const got=await withdrawTo(id,self,item,need);
      if(got===0&&(await civic().goToWarehouse(id,self)))st.warehouseEmpty=true;
      return 'working';
    }
    const src=sourceBlock(item);
    if(src){
      st.step='query_memory';st.tried??=[];
      const mem=spatial.query(id,item,6,90,{from:self,category:src.category}).find(r=>!st.tried.includes(r.memory_id));
      if(mem){
        st.step=`navigate:${mem.x},${mem.z}`;
        if(!(await reach(id,self,mem,4)))return 'working';
        st.step='interact';
        const found=await act(id,{type:'find',x:0,y:0,z:0,target:src.block,count:8}).catch(()=>[]);
        const near=(found??[]).filter(b=>Math.hypot(b.x-self.x,b.z-self.z)<=6).slice(0,6);
        if(!near.length){spatial.markStale(mem.memory_id);st.tried.push(mem.memory_id);return 'working';}
        if(src.how==='mine')await act(id,{type:'equip',x:0,y:0,z:0,target:Object.keys(inv(self)).find(k=>k.endsWith('_AXE'))??'NONE'}).catch(()=>{});
        for(const b of near)await act(id,{type:src.how,x:b.x,y:b.y,z:b.z}).catch(()=>{});
        spatial.record({observed_by:id,x:mem.x,y:mem.y,z:mem.z,category:src.category,item:mem.item});
        return 'working';
      }
    }
    const recipe=RECIPES[item];
    if(recipe&&!st.cannotMake){
      st.step='make';
      const r=await make(id,self,item,need,recipe,st);
      if(r!=='cannot')return r;
      st.cannotMake=true;
    }
    // Nothing else works: ask the town (delivered to this agent).
    st.step='request';
    const o=board.post({issuer:id,item,quantity:need,reward:questReward(item,need),priority:'MEDIUM',note:`for: ${m.title}`,goalId:m.parent_id,targetLocation:'agent'});
    if(o){st.orderId=o.order_id;st.orderSince=Date.now();ledger(id,`posted work order #${o.number}: ${need} ${nice(item)} (${m.title})`);}
    return 'waiting';
  }
  /** Craft or smelt `need` of `item` from inventory plus the warehouse; 'cannot' when ingredients are short. */
  async function make(id,self,item,need,recipe,st){
    const times=Math.min(16,Math.ceil(need/recipe.out)),ins=Object.entries(recipe).filter(([k])=>!['out','smelt'].includes(k));
    const s=stock();
    if(!ins.every(([k,n])=>(inv(self)[k]??0)+(s[k]??0)>=n*times))return 'cannot';
    const short=ins.filter(([k,n])=>(inv(self)[k]??0)<n*times);
    if(short.length){for(const [k,n] of short)await withdrawTo(id,self,k,n*times-(inv(self)[k]??0));return 'working';}
    if(recipe.smelt&&!FUEL.some(f=>(inv(self)[f]??0)>=Math.ceil(times/8))){const f=FUEL.find(f=>(s[f]??0)>0);if(!f)return 'cannot';await withdrawTo(id,self,f,Math.max(2,Math.ceil(times/4)));return 'working';}
    const r=await act(id,recipe.smelt?{type:'smelt',x:0,y:0,z:0,target:ins[0][0],count:times}:{type:'craft',x:0,y:0,z:0,target:item,count:times});
    log('micro_step',{agent:id,step:recipe.smelt?'smelt':'craft',item,times,result:r?.times??r?.count});
    return 'working';
  }
  const ROUTINES={
    GATHER:gather,
    async CRAFT(id,self,m,st){
      if((inv(self)[m.spec.item]??0)>=m.spec.quantity)return 'done';
      const recipe=RECIPES[m.spec.item];
      if(!recipe){st.step='craft';await act(id,{type:'craft',x:0,y:0,z:0,target:m.spec.item,count:Math.min(16,m.spec.quantity)});return 'working';}
      st.step='make';
      const r=await make(id,self,m.spec.item,m.spec.quantity-(inv(self)[m.spec.item]??0),recipe,st);
      if(r==='cannot'){
        // Gather the first missing ingredient, then craft.
        const [k,n]=Object.entries(recipe).find(([k,n])=>!['out','smelt'].includes(k)&&(inv(self)[k]??0)<n*Math.ceil(m.spec.quantity/recipe.out))??[];
        if(!k)throw Object.assign(Error(`Missing ingredients for ${m.spec.item}`),{action:{type:'craft',target:m.spec.item}});
        st.sub??={};return gather(id,self,{...m,spec:{item:k,quantity:n*Math.ceil(m.spec.quantity/recipe.out)}},st.sub);
      }
      return r;
    },
    async SMELT(id,self,m,st){
      const recipe=Object.entries(RECIPES).find(([,r])=>r.smelt&&r[m.spec.item])?.[0];
      if(!recipe)throw Object.assign(Error(`That cannot be smelted: ${m.spec.item}`),{action:{type:'smelt',target:m.spec.item}});
      st.target??=(inv(self)[recipe]??0)+m.spec.quantity;
      if((inv(self)[recipe]??0)>=st.target)return 'done';
      return ROUTINES.CRAFT(id,self,{...m,spec:{item:recipe,quantity:st.target}},st);
    },
    async DELIVER(id,self,m,st){
      const {item,quantity}=m.spec,to=m.spec.to??'warehouse';
      if((inv(self)[item]??0)<quantity&&!st.handed){st.sub??={};const r=await gather(id,self,m,st.sub);if(r!=='done')return r;}
      if(to==='warehouse'){
        st.step='navigate:warehouse';if(!(await civic().goToWarehouse(id,self)))return 'working';
        st.step='interact';const n=await civic().deposit(id,item,Math.min(quantity,inv(self)[item]??0));
        if(!n)throw Object.assign(Error(`You have no ${item}`),{action:{type:'deposit',target:item}});
        ledger(id,`delivered ${n} ${nice(item)} to the warehouse (${m.title})`);return 'done';
      }
      // A citizen by id or by name ("Sir Aldric", "Aldric").
      const low=String(to).toLowerCase(),t=getSnapshot()?.agents.find(a=>a.id===to||nameOf(a.id).toLowerCase()===low||low.includes(nameOf(a.id).toLowerCase()));if(!t)throw Object.assign(Error(`Unknown or offline recipient ${to}`),{action:{type:'give',to}});
      st.step=`navigate:${to}`;if(!(await reach(id,self,t,3)))return 'working';
      st.step='interact';await act(id,{type:'give',x:0,y:0,z:0,target:item,count:Math.min(64,quantity),to:t.id});st.handed=true;
      ledger(id,`handed ${quantity} ${nice(item)} to ${to}`);return 'done';
    },
    async REQUEST(id,self,m,st){return gather(id,self,{...m,spec:{...m.spec}},Object.assign(st,{warehouseEmpty:true,cannotMake:true,tried:['*']}));},
    async GOTO(id,self,m,st){
      // Physical rules only (world border, height, one trip's navigation budget), no fixed distance from town.
      const why=destinationCheck(m.spec,self,getSnapshot()?.world);
      if(why)throw Object.assign(Error(`Cannot go to ${m.spec.x},${m.spec.z}: ${why}`),{action:{type:'pathfind',x:m.spec.x,z:m.spec.z}});
      st.step='navigate';return (await reach(id,self,{x:m.spec.x,z:m.spec.z},3))?'done':'working';},
    async FARM(id,self,m,st){
      if(roleOf(id)!=='farmer')return 'done';
      const x=m.spec.x??272,z=m.spec.z??93;
      await perform(id,{type:'farm',x,y:Math.round(self.y),z,target:'',text:'',to:'',blocks:[],count:1,spec:{crop:m.spec.crop.endsWith('_SEEDS')||['CARROT','POTATO'].includes(m.spec.crop)?m.spec.crop:`${m.spec.crop}_SEEDS`,width:6,depth:6}});
      return 'done';
    },
    async BUILD(id,self,m,st){
      const r=civic().buildSite(id,m.spec.site);
      if(r==='built')return 'done';if(r==='unknown')throw Object.assign(Error(`No such site: ${m.spec.site}`),{action:{type:'blueprint',target:m.spec.site}});
      st.step=`building ${m.spec.site}`;return 'waiting';
    },
    async SAY(id,self,m){await say(id,m.spec.text);return 'done';},
    async WAIT(id,self,m,st){st.until??=Date.now()+m.spec.minutes*60000;st.step='wait';return Date.now()>=st.until?'done':'waiting';},
  };
  /** The job for an agent's current milestone, or null (no goal, or a milestone that is waiting). */
  function goalJob(c,s,self){
    const cur=goals.current(c.id);if(!cur)return null;
    const {goal,milestone:m}=cur;
    if(goal.status==='PENDING'||!m){
      if(!m&&goal.status==='IN_PROGRESS'){goals.finishIfDone(goal.goal_id);return null;}
      if(throttle(`plan:${goal.goal_id}`,60000))return ()=>goals.plan(goal.goal_id,d.planContext(c,self));
      return null;
    }
    const st=m.spec.state??{};
    if(st.retryAt&&Date.now()<st.retryAt)return null;
    // A milestone waiting on a delivery or a build only checks in every 20 s and leaves the agent to its usual work.
    if(m.status==='PAUSED'&&!throttle(`paused:${m.goal_id}`,20000))return null;
    if(!throttle(`step:${c.id}`,1500))return null;
    return async()=>{
      const routine=ROUTINES[m.spec.type];
      if(m.status==='PENDING'){goals.setStatus(m.goal_id,'IN_PROGRESS');log('milestone_started',{agent:c.id,goal:goal.title,milestone:m.title});}
      try{
        const r=await routine(c.id,self,m,st);
        goals.setStatus(m.goal_id,r==='waiting'?'PAUSED':r==='done'?'COMPLETED':'IN_PROGRESS');
        if(r==='done'){reflector.clear(m.goal_id);log('milestone_done',{agent:c.id,goal:goal.title,milestone:m.title});goals.finishIfDone(goal.goal_id)&&ledger(c.id,`completed the goal: ${goal.title}`);}
        goals.setSpec(m.goal_id,{...m.spec,state:st});
      }catch(error){
        goals.setSpec(m.goal_id,{...m.spec,state:st});
        const r=await reflector.reflect({agent:c.id,persona:{name:nameOf(c.id),role:roleOf(c.id)},subject:m.goal_id,action:error.action??{type:m.spec.type.toLowerCase(),target:m.spec.item??''},
          error:error.message,location:self,goal:`${goal.title} -> ${m.title}`});
        if(r.giveUp){await goals.failMilestone(m.goal_id,error.message,d.planContext(c,self));return;}
        if(r.strategy==='alternate_action'&&r.action){await perform(c.id,{x:0,y:0,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{},...r.action}).catch(e=>log('corrective_failed',{agent:c.id,message:e.message}));}
        else if(r.strategy==='skip'){st.warehouseEmpty=true;st.cannotMake=true;st.tried=[...(st.tried??[]),'*skip'];}
        else if(r.strategy==='request_help'){st.warehouseEmpty=true;st.cannotMake=true;st.tried=['*'];}
        else if(r.strategy==='replan'){await goals.failMilestone(m.goal_id,error.message,d.planContext(c,self));return;}
        st.retryAt=Date.now()+(r.strategy==='wait'?60000:5000);goals.setSpec(m.goal_id,{...m.spec,state:st});
      }
    };
  }

  // ---------- work-order contracts ----------
  const view=()=>{const snap=getSnapshot();return (snap?.agents??[]).map(a=>({...a,role:roleOf(a.id)}));};
  /**
   * Pays the contractor (the part not paid up front) from the treasury and updates trust both ways.
   * Exactly one caller settles an order (board.beginSettle); the order is VERIFIED only once the money moved. A failed
   * payment leaves it UNPAID (retried by retryUnpaid); an unknown outcome leaves it PAYMENT_UNCERTAIN (never retried).
   * Returns true when the contractor is paid (now or before).
   */
  async function settle(order,contractor,isPlayer=false){
    const o=board.beginSettle(order.order_id);
    if(!o)return board.get(order.order_id)?.status==='VERIFIED';   // another path is settling or has settled it
    const due=Math.max(0,o.reward_emeralds-o.upfront_paid),first=!board.flagged(o,'fulfilled');
    let error=null;
    // Citizens are paid inside the bank (it always clears when the issuer or the town can cover it); players, and
    // anything the bank cannot cover, from the warehouse treasury.
    const banked=due>0&&d.payFromBank?await d.payFromBank(o.issuer_name,contractor,due,`order #${o.number}`,{player:isPlayer}).catch(()=>null):null;
    if(due>0&&!banked)await act(o.issuer_name,isPlayer?{type:'reward',x:0,y:0,z:0,to:contractor,target:'EMERALD',count:due}:{type:'wage',x:0,y:0,z:0,to:contractor,target:'EMERALD',count:due})
      .catch(e=>{error=e.message||'payment failed';});
    // The work is done either way: the issuer's trust in the contractor counts once.
    if(first){board.note(o.order_id,{flag:'fulfilled'});social.apply(o.issuer_name,contractor,'order_fulfilled',`order #${o.number}`);}
    if(!error){
      board.verify(o.order_id,{paid:true});
      social.apply(contractor,o.issuer_name,'paid_on_time',`order #${o.number}`);
      ledger(o.issuer_name,`order #${o.number} fulfilled by ${nameOf(contractor)}${due?` (${due} emeralds paid)`:''}`);
      return true;
    }
    const uncertain=UNKNOWN_OUTCOME.test(error);
    board.markUnpaid(o.order_id,{due,contractor,reason:error,uncertain});
    if(first){social.apply(contractor,o.issuer_name,'payment_missed',`order #${o.number}`);
      ledger(o.issuer_name,`order #${o.number} fulfilled by ${nameOf(contractor)} - ${due} emeralds still owed (${uncertain?'payment outcome unknown, held for the audit':'will retry'})`);}
    return false;
  }
  /** Retries failed payments (never uncertain ones) every 5 minutes; called from the order sweep. */
  async function retryUnpaid(){
    board.staleSettling();
    for(const o of board.unpaid()){if(o.contractor_name)await settle(o,o.contractor_name,!d.isAgent?.(o.contractor_name));}
  }
  /** Consider claiming an order (every 20 s per agent); busy agents only answer urgent ones. */
  function maybeClaim(c,s,self,busy){
    if(!throttle(`claim:${c.id}`,20000))return null;
    const agents=view(),me={...self,id:c.id,role:roleOf(c.id)};
    // An order this citizen just turned down (the issuer could not pay the advance) is set aside for 30 minutes.
    const set=s.declined??={};for(const k of Object.keys(set))if(set[k]<Date.now())delete set[k];
    const pick=chooseOrder(board.open().filter(o=>!set[o.order_id]),me,{stock:stock(),agents,terms:(a,b)=>social.terms(a,b),busy});
    if(!pick)return null;
    return async()=>{
      // Claim first (only one contractor can), then the advance: losing the race never leaks an up-front payment.
      let upfront=pick.terms.upfront>0&&pick.order.reward_emeralds>0?Math.ceil(pick.order.reward_emeralds*pick.terms.upfront):0;
      let o=board.claim(pick.order.order_id,c.id,{upfront:0,source:pick.plan.source});if(!o)return;
      const advance=()=>d.payFromBank?d.payFromBank(pick.order.issuer_name,c.id,upfront,`advance on order #${o.number}`).then(r=>r?true:Promise.reject()):Promise.reject();
      if(upfront&&!(await advance().catch(()=>act(pick.order.issuer_name,{type:'wage',x:0,y:0,z:0,to:c.id,target:'EMERALD',count:upfront}).then(()=>true)).catch(()=>false))){
        board.release(o.order_id,'the issuer could not pay the advance');
        log('order_declined',{contractor:c.id,number:pick.order.number,reason:'no upfront payment'});set[pick.order.order_id]=Date.now()+1800000;return;
      }
      if(upfront)o=board.recordUpfront(o.order_id,upfront);   // counted only once the advance really moved
      s.contract={order_id:o.order_id,plan:pick.plan,phase:'acquire',since:Date.now()};
      const what=['RESOURCE_REQUEST','CRAFT_ITEM'].includes(o.order_type)?`${o.quantity-o.delivered} ${nice(pick.plan.item??o.target_item)}${pick.plan.item&&pick.plan.item!==o.target_item?` (instead of ${nice(o.target_item)})`:''}`:o.order_type==='GUARD_DUTY'?'guard duty':'the construction';
      await say(c.id,`I'll take order #${o.number}: ${what} for ${nameOf(o.issuer_name)}.${upfront?` Half up front, given how things went before.`:''}`).catch(()=>{});
      ledger(c.id,`claimed work order #${o.number} (${what}) from ${nameOf(o.issuer_name)} - ${pick.terms.reason}`);
    };
  }
  /** The job for an agent's active contract, or null. */
  function contractJob(c,s,self){
    const k=s.contract;if(!k)return null;
    const o=board.get(k.order_id);
    if(!o||o.status!=='CLAIMED'||o.contractor_name!==c.id){s.contract=null;return null;}
    if(['duty','build'].includes(k.plan.source))return null;   // guard duty and construction run in their own loops
    if(k.retryAt&&Date.now()<k.retryAt)return null;
    if(!throttle(`contract:${c.id}`,1500))return null;
    return async()=>{
      const item=k.plan.item??o.target_item,need=o.quantity-o.delivered;
      try{
        if(k.phase==='acquire'){
          if((inv(self)[item]??0)>=need){k.phase='deliver';return;}
          if(k.plan.source==='warehouse'){await withdrawTo(c.id,self,item,need);return;}
          if(k.plan.source==='make'){const r=await make(c.id,self,item,need,MAKES[roleOf(c.id)]?.[item]??RECIPES[item],k);if(r==='cannot')throw Error(`Missing ingredients for ${item}`);return;}
          if(k.plan.source==='collect'){
            const h=getSnapshot()?.agents.find(a=>a.id===k.plan.from);if(!h)throw Error(`Unknown or offline recipient ${k.plan.from}`);
            if(!(await reach(c.id,self,h,3)))return;
            await act(k.plan.from,{type:'give',x:0,y:0,z:0,target:item,count:Math.min(64,k.plan.count),to:c.id});
            social.apply(c.id,k.plan.from,'food_shared',`handed over ${item} for order #${o.number}`);return;
          }
          if(k.plan.source==='inventory'&&(inv(self)[item]??0)<need)throw Error(`You have no ${item}`);
          k.phase='deliver';return;
        }
        // Deliver: to the warehouse (the issuer fetches from there) or into the issuer's hands.
        const n=Math.min(need,inv(self)[item]??0);if(!n)throw Error(`You have no ${item}`);
        const issuer=getSnapshot()?.agents.find(a=>a.id===o.issuer_name);
        const toWarehouse=o.target_location!=='agent'||!issuer||issuer.y<58||dist(self,issuer)>90;
        if(toWarehouse){
          if(!(await civic().goToWarehouse(c.id,self)))return;
          const got=await civic().deposit(c.id,item,n,c.id);if(!got)throw Error('That chest is full');
          if(o.target_location==='agent')civic().leavePickup(o.issuer_name,item,got);
          board.progress(o.order_id,got,c.id);
        }else{
          if(!(await reach(c.id,self,issuer,3)))return;
          await act(c.id,{type:'give',x:0,y:0,z:0,target:item,count:Math.min(64,n),to:o.issuer_name});
          board.progress(o.order_id,Math.min(64,n),c.id);
        }
        const done=board.get(o.order_id);
        if(done.status==='DELIVERED'){await settle(done,c.id);s.contract=null;await say(c.id,`Order #${o.number} delivered to ${nameOf(o.issuer_name)}.`).catch(()=>{});}
      }catch(error){
        const r=await reflector.reflect({agent:c.id,persona:{name:nameOf(c.id),role:roleOf(c.id)},subject:`order:${o.order_id}`,action:{type:k.phase==='acquire'?'withdraw':'give',target:item,to:o.issuer_name},
          error:error.message,location:self,goal:`work order #${o.number}: ${need} ${item} for ${o.issuer_name}`});
        // Before giving up, look for another way (another supplier, the warehouse, making it).
        if(k.phase==='acquire'&&!k.replanned){
          const again=fulfilmentPlan(o,{...self,id:c.id,role:roleOf(c.id)},{stock:stock(),agents:view().filter(a=>a.id!==k.plan.from)});
          if(again){k.plan=again;k.replanned=true;log('contract_replanned',{agent:c.id,number:o.number,source:again.source});return;}
        }
        if(r.giveUp||['skip','replan','request_help'].includes(r.strategy)){
          board.release(o.order_id,`contractor gave up: ${error.message}`);social.apply(o.issuer_name,c.id,'order_withdrawn',`handed back order #${o.number}: ${error.message}`);
          s.contract=null;reflector.clear(`order:${o.order_id}`);
        }else k.retryAt=Date.now()+30000;
      }
    };
  }
  /** A player hands the issuer items for an open order: counts toward it and pays the player on completion. */
  async function deliverFromPlayer(issuer,player,item,count){
    const o=board.list({status:'OPEN'}).concat(board.list({status:'CLAIMED'})).find(x=>x.issuer_name===issuer&&x.target_item===item);if(!o)return false;
    const p=board.progress(o.order_id,count,player);
    if(p.status!=='DELIVERED'){await say(issuer,`Thanks ${player}! ${p.quantity-p.delivered} more ${nice(item)} to finish order #${p.number}.`).catch(()=>{});return true;}
    const paid=await settle(p,player,true);
    await say(issuer,paid?`Order #${p.number} complete! ${p.reward_emeralds} emeralds from the treasury for you, ${player}.`:`Order #${p.number} complete, thank you ${player}! The treasury can't pay yet; I'll owe you.`).catch(()=>{});
    return true;
  }
  return {goalJob,contractJob,maybeClaim,settle,retryUnpaid,deliverFromPlayer,ROUTINES};
}
