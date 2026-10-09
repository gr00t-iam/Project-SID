// The warehouse clerk: Jasper keeps the warehouse in order - his whole job (Finneas the Banker is free for the bank).
// The chests, categories and moves are in ../skills/warehouse.mjs.
//
//   INDEX_WAREHOUSE     every 10 minutes (and at the start): re-read every chest, give new chests a category, post the
//                       day's inventory summary and any low-stock alert to the town ledger (the chronicle)
//   INSPECT_DROP_BOX    the courier's loads go into the input drop box; he takes them out and files them
//   SORT_CONTAINERS     an item in the wrong category's chest goes to its own (with a word about it)
//   CONSOLIDATE_STACKS  an item spread over several chests is gathered into the one holding most
//   SERVE_COUNTER       first of all: a citizen at the counter asked for goods - he fetches them and hands them over
//   IDLE                nothing to do: at his post in the warehouse
// Resting (the rest mandate) and the night are handled by the worker as for everyone else.

import {surplusOf,loadOf,unstackableSurplus} from '../skills/supply.mjs';
import {categoryOf} from '../skills/warehouse.mjs';
export const AGENT={id:'clerk',role:'clerk',name:'Jasper the Warehouse Clerk',every:4,camp:true,post:[286,107],
  personality:'Meticulous and hyper-organized; deeply proud of clean, sorted chests and full stacks. Mildly exasperated when goods turn up in the wrong chest ("Who put raw beef in the cobble chest again?!"), but always helpful: he knows where every material is.',
  goal:'Keep the town warehouse in order. Your sorting runs on its own: you file the drop box, move misfiled goods, merge stacks and post the inventory summary and low-stock alerts. In your own turns, tell people where to find what they need (the wall chests by category) and remind them gently to put things back in the right place.'};
export const PLUGIN_SETTINGS={'display-names':{clerk:'Jasper the Warehouse Clerk'},uniforms:{clerk:'#A1887F'},'starter-items':{clerk:['BREAD:6','PAPER:8']}};
export const STATES=['IDLE','SERVE_COUNTER','INDEX_WAREHOUSE','INSPECT_DROP_BOX','SORT_CONTAINERS','CONSOLIDATE_STACKS','CLEAR_OUT','REST_MANDATE'];
const STATE_OF={to_market:'CLEAR_OUT',drop_box:'INSPECT_DROP_BOX',misfiled:'SORT_CONTAINERS',consolidate:'CONSOLIDATE_STACKS',retire:'EMPTY_FLOOR_CHESTS'};
const EDIBLE=/^(BREAD|BAKED_POTATO|COOKED_[A-Z_]+|APPLE|CARROT|COOKIE|PUMPKIN_PIE|SWEET_BERRIES|MUSHROOM_STEW|BEETROOT_SOUP|MELON_SLICE)$/;
const words=k=>String(k).toLowerCase().replace(/_/g,' ');
const catWords=c=>({WEAPONS:'weapons',BUILDING_BLOCKS:'building',ORES_AND_METALS:'ore',FOOD_AND_AGRICULTURE:'food',TOOLS_AND_EQUIPMENT:'tool',REDSTONE_AND_COMPONENTS:'redstone',MISC_AND_VALUABLES:'valuables',INPUT_DROP_BOX:'drop',OVERFLOW:'overflow'}[c]??'other');

export function createClerk(d){
  const {memory,act,say=async()=>{},log=()=>{},ledger=()=>{},now=()=>Date.now(),random=Math.random}=d;
  const civic=()=>d.civic();
  const town=memory.data.town??={};
  const W=town.clerk??={state:'IDLE',moves:0,filed:0,merged:0,lastIndex:0,lastSummaryDay:null,lastAlert:{}};
  // Jasper takes over from Finneas (who clerked before him): a load Finneas had in hand is not in Jasper's pack.
  if(!W.jasperV1){W.jasperV1=true;W.load=null;W.state='IDLE';W.stuck={};}
  // Empty chests can now be given to one item (skills/warehouse.mjs): what was set aside as "no room" gets another go.
  if(!W.dedicateV2){W.dedicateV2=true;W.stuck={};}
  const said=new Map(),ready=(k,ms)=>{const t=said.get(k)??0;if(now()-t<ms)return false;said.set(k,now());return true;};
  const set=(state,extra={})=>{if(W.state!==state){log('clerk_state',{from:W.state,to:state,...extra});W.state=state;}};

  /** SERVE_COUNTER: the oldest open request at the counter - fetch it from the chests and hand it over. */
  async function serve(c,self,req){
    req.taken=true;set('SERVE_COUNTER',{who:req.who,item:req.item});
    const got=await civic().withdraw(c.id,req.item,req.count,{onBehalf:req.who});
    const who=d.posOf?.(req.who),name=d.nameOf?.(req.who)??req.who;
    if(!got){req.status='done';req.given=0;log('counter_served',{who:req.who,item:req.item,asked:req.count,given:0});
      const atMarket=(civic().shopStock?.('merchant')?.[req.item]??0)>0||(civic().shopStock?.('chef')?.[req.item]??0)>0;
      if(ready(`none:${req.item}`,120000))await say(c.id,atMarket?`Sorry, ${name}, we're out of ${words(req.item)} - try Marlo's market or Antoine's bakery.`:`Sorry, ${name}, we're out of ${words(req.item)}, and the shops have none either - ask whoever makes it.`).catch(()=>{});return;}
    // Hand it over across the counter (the plugin gives within 4 blocks, 64 at a time).
    let given=0;
    for(let tries=0;tries<3&&given<got;tries++){
      const p=d.posOf?.(req.who);if(!p||req.status!=='open')break;
      const me=d.posOf?.(c.id)??self;
      const gap=Math.hypot(me.x-p.x,me.z-p.z);if(gap>12)break;   // not at the counter: he does not go looking for them
      if(gap>3)await d.walkTo?.(c.id,{x:p.x,y:Math.round(p.y),z:p.z}).catch(()=>{});
      while(given<got){
        const k=Math.min(64,got-given);
        if(!await act(c.id,{type:'give',x:0,y:0,z:0,target:req.item,count:k,to:req.who}).then(()=>true).catch(()=>false))break;given+=k;
      }
    }
    req.given=given;req.status='done';town.counter.served=(town.counter.served??0)+1;
    log('counter_served',{who:req.who,item:req.item,asked:req.count,given});
    if(given&&ready(`served:${req.who}`,120000))await say(c.id,`Here you are, ${name}: ${given} ${words(req.item)}.`).catch(()=>{});
    // Whatever did not reach them (they left) goes back into its chest.
    if(given<got)await civic().deposit(c.id,req.item,got-given).catch(()=>0);
    if(!who)log('counter_requester_gone',{who:req.who,item:req.item});
  }
  // Chest labels: a floating sign on each chest's front (plugin 2.28.0 "labels") - its category and what is in it.
  const SIGN_CAT={BUILDING_BLOCKS:'BUILDING BLOCKS',ORES_AND_METALS:'ORES & METALS',FOOD_AND_AGRICULTURE:'FOOD & FARMING',TOOLS_AND_EQUIPMENT:'TOOLS & EQUIPMENT',
    WEAPONS:'WEAPONS',REDSTONE_AND_COMPONENTS:'REDSTONE',MISC_AND_VALUABLES:'MISC & VALUABLES',INPUT_DROP_BOX:'DROP BOX',RETIRED:'RETIRED'};
  function labelOf(map,c){
    const cat=map.categoryOfChest(c);if(!cat)return '';
    if(cat==='INPUT_DROP_BOX')return 'DROP BOX|deliveries here';
    const ded=map.dedicatedTo?.(c);
    const top=Object.entries(c.items??{}).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([k])=>words(k));
    return `${SIGN_CAT[cat]??cat}|${ded?words(ded)+' only':top.length?top.join(', '):'(empty)'}`;
  }
  async function relabel(c){
    const map=civic().warehouseMap(),seen=W.labels??={},out=[];
    for(const ch of town.stock?.chests??[]){const k=`${ch.x},${ch.y},${ch.z}`,t=labelOf(map,ch);if(seen[k]!==t){out.push([ch.x,ch.y,ch.z,t]);seen[k]=t;}}
    for(let i=0;i<out.length;i+=40){
      const r=await act(c.id,{type:'labels',x:0,y:0,z:0,spec:{labels:out.slice(i,i+40)}}).catch(e=>({error:e.message}));
      if(r?.error){for(const [x,y,z] of out.slice(i,i+40))delete seen[`${x},${y},${z}`];log('labels_error',{message:r.error});return;}
    }
    if(out.length)log('chests_labelled',{agent:c.id,changed:out.length});
  }
  /** INDEX_WAREHOUSE: fresh chest contents, categories for new chests, the summary and low-stock alerts. */
  async function index(c){
    set('INDEX_WAREHOUSE');W.lastIndex=now();
    await civic().refreshStock();
    const map=civic().warehouseMap(),chests=town.stock?.chests??[];
    if(map.assign(chests))log('warehouse_indexed',{chests:chests.length,assign:map.state.assign});
    const sum=map.summary(chests);
    await relabel(c).catch(()=>{});
    if(W.lastSummaryDay!==town.day){
      W.lastSummaryDay=town.day;
      const parts=Object.entries(sum).filter(([k])=>k!=='INPUT_DROP_BOX').map(([k,v])=>`${catWords(k)} ${v.used}/${v.slots} slots`);
      ledger(c.id,`took stock of the warehouse: ${Object.values(town.stock.items??{}).reduce((a,b)=>a+b,0)} items in ${chests.length} chests (${parts.join(', ')})`);
    }
    // Low stock: what the forge and the builders run on (skills/supply.mjs standing orders), once an hour each.
    for(const o of civic().standing?.()??[])if(now()-(W.lastAlert[o.key]??0)>3600000){
      W.lastAlert[o.key]=now();ledger(c.id,`low stock in the warehouse: ${o.item==='LOG'?'timber':words(o.item)} for ${o.for} - asked the ${o.role}`);
      log('low_stock_alert',{key:o.key,item:o.item,role:o.role});
    }
  }
  const byMerchant=()=>d.merchant?.()??null;
  /**
   * CLEAR_OUT (a full warehouse): a load of what is over its cap (skills/supply.mjs) out of the chests and to the
   * merchant's market stall (HAUL_LIMIT items a trip).
   */
  async function clearOut(c,s,self){
    set('CLEAR_OUT');
    if(!W.load){
      if(!await civic().goToWarehouse(c.id,self))return;
      const got=[];for(const l of loadOf(surplusOf(town.stock?.items??{}))){const n=await civic().withdraw(c.id,l.item,l.count);if(n)got.push({item:l.item,count:n});}
      if(!got.length)return;W.load=got;log('surplus_loaded',{agent:c.id,load:got});return;
    }
    // Onto the stalls in Marlo's market hall (the market's stock chests); before the market is set up, to Marlo himself.
    // Food to Antoine's bakery, everything else to Marlo's market - one shop per trip, the rest on the next.
    const shop=civic().shopFor?.(W.load[0].item);
    if(shop){
      const part=W.load.filter(l=>civic().shopFor(l.item)===shop),rest=W.load.filter(l=>!part.includes(l));
      const put=await civic().stockMarket(c.id,self,part,{shop});if(put===null)return;   // still walking there
      // Whatever did not go on the shelves was sold to a caravan in stockMarket (shelf caps) - nothing left in hand.
      const left=part.map(l=>({item:l.item,count:l.count-(put[l.item]??0)})).filter(l=>l.count>0);
      const where=shop==='chef'?"Antoine's bakery":"Marlo's market";
      ledger(c.id,`took ${part.map(l=>`${l.count} ${words(l.item)}`).join(', ')} from the warehouse to ${where}`);
      log('surplus_cleared',{agent:c.id,to:shop,load:part,left});W.load=rest.length?rest:null;
      if(ready('clearout-say',900000))await say(c.id,`Those chests are full. The rest goes to ${where} - we keep what we use.`).catch(()=>{});
      return;
    }
    const m=byMerchant(),p=d.posOf?.(m);if(!p){W.load=null;return;}
    if(Math.hypot(self.x-p.x,self.z-p.z)>3){if(!self.pathing)await d.travel?.(c.id,self,{x:p.x+1,y:Math.round(p.y),z:p.z+1}).catch(()=>{});return;}
    for(const l of W.load)await act(c.id,{type:'wage',x:0,y:0,z:0,to:m,target:l.item,count:l.count}).catch(()=>{});
    ledger(c.id,`took ${W.load.map(l=>`${l.count} ${words(l.item)}`).join(', ')} from the overfull warehouse to the market stall`);
    log('surplus_cleared',{agent:c.id,to:m,load:W.load});W.load=null;
    if(ready('clearout-say',900000))await say(c.id,'The warehouse was stuffed to the rafters. Surplus goes to the market - we keep what we use.').catch(()=>{});
  }
  /** One move from chest to chest (withdraw, then deposit), with both chests locked meanwhile. */
  async function move(c,self,m){
    const map=civic().warehouseMap();
    if(!map.lock(m.from,c.id)||!map.lock(m.to,c.id)){map.unlock(m.from,c.id);return false;}
    try{
      // A big warehouse: walk to each chest in turn (reach is 5 blocks).
      if(civic().reachChest&&!await civic().reachChest(c.id,m.from))return false;
      const got=await act(c.id,{type:'withdraw',x:m.from.x,y:m.from.y,z:m.from.z,target:m.item,count:m.count}).then(r=>r?.withdrew??0).catch(()=>0);
      if(!got)return false;
      civic().noteChest(m.from,m.item,-got);
      if(civic().reachChest&&!await civic().reachChest(c.id,m.to)){const back=await act(c.id,{type:'deposit',x:m.from.x,y:m.from.y,z:m.from.z,target:m.item,count:got}).then(r=>r?.deposited??0).catch(()=>0);civic().noteChest(m.from,m.item,back);return false;}
      const put=await act(c.id,{type:'deposit',x:m.to.x,y:m.to.y,z:m.to.z,target:m.item,count:got}).then(r=>r?.deposited??0).catch(()=>0);
      civic().noteChest(m.to,m.item,put);
      // No room there after all (the free count was stale): that chest is full; leave this item for 10 minutes.
      if(!put){m.to.free=0;(W.stuck??={})[m.item]=now();}
      // Whatever did not fit goes back where it came from.
      if(put<got){const back=await act(c.id,{type:'deposit',x:m.from.x,y:m.from.y,z:m.from.z,target:m.item,count:got-put}).then(r=>r?.deposited??0).catch(()=>0);civic().noteChest(m.from,m.item,back);}
      if(!put){if(ready('move-failed',300000))log('warehouse_full',{agent:c.id,item:m.item,to:{x:m.to.x,y:m.to.y,z:m.to.z}});return false;}
      W.moves++;if(m.kind==='consolidate')W.merged+=put;else W.filed+=put;
      if(m.kind==='retire'){W.retired=(W.retired??0)+put;
        if(!map.retiredLeft(town.stock?.chests??[]).length&&!W.floorEmptyAnnounced){W.floorEmptyAnnounced=true;
          log('floor_chests_empty',{agent:c.id,moved:W.retired});ledger(c.id,`emptied the old floor chests into the wall chests (${W.retired} items moved); they can be taken out`);
          await say(c.id,'All the old floor chests are empty now - everything is in the wall chests. The floor chests can be taken out.').catch(()=>{});}}
      log('warehouse_move',{agent:c.id,kind:m.kind,item:m.item,count:put,from:{x:m.from.x,y:m.from.y,z:m.from.z,category:map.categoryOfChest(m.from)},to:{x:m.to.x,y:m.to.y,z:m.to.z,category:map.categoryOfChest(m.to)}});
      if(m.kind==='misfiled'&&ready('misfiled-say',600000))
        await say(c.id,random()<0.5?`Who put ${words(m.item)} in the ${catWords(map.categoryOfChest(m.from))} chest again?!`:`${words(m.item)[0].toUpperCase()+words(m.item).slice(1)} does not belong with the ${catWords(map.categoryOfChest(m.from))} goods. Filed properly now.`).catch(()=>{});
      return true;
    }finally{map.unlock(m.from,c.id);map.unlock(m.to,c.id);}
  }
  return {
    /** The clerk's work while the bank does not need him (null: nothing to do, or not the clerk). */
    job(c,s,self,night){
      if(c.role!=='clerk'||night||!town.built?.warehouse)return null;
      const onDuty=this.onDuty();
      const map=civic().warehouseMap(),chests=town.stock?.chests??[];
      // The counter comes first: someone waiting for goods is served before any sorting.
      const req=onDuty&&(civic().counter?.()?.requests??[]).find(r=>r.status==='open'&&!r.taken);
      if(req)return async()=>{if(!W.load)await serve(c,self,req);};
      const due=now()-W.lastIndex>600000||!Object.keys(map.state.assign).length;
      // Nearly full (fewer than 10 free slots in all) and something over its cap: carry a load of it to the market.
      // Over the cap: a load to the market when the warehouse is nearly full - or at once for things that do not stack.
      const free=chests.reduce((a,x)=>a+(x.free??0),0),surplus=!due&&byMerchant()&&(free<10||unstackableSurplus(town.stock?.items).length)?surplusOf(town.stock?.items??{}):[];
      // With Barnaby the Runner in town the overflow is his to carry (civic clearout errand): Jasper never leaves his post.
      if(civic().hasRunner?.()&&W.load){const l=W.load;W.load=null;return async()=>{if(!await civic().goToWarehouse(c.id,self))return;const box=civic().warehouseMap().dropBox(town.stock?.chests??[]);
        for(const x of l){let put=await civic().deposit(c.id,x.item,x.count).catch(()=>0);
          // What has no room in its own chests waits in the drop box for Barnaby (he collects it for the shops).
          if(put<x.count&&box){const r=await act(c.id,{type:'deposit',x:box.x,y:box.y,z:box.z,target:x.item,count:x.count-put}).then(r=>r?.deposited??0).catch(()=>0);if(r)civic().noteChest(box,x.item,r);put+=r;}
          if(x.count>0)civic().queueForMarket(x.item,x.count);}};}
      if(!civic().hasRunner?.()&&(surplus.length||W.load))return ()=>clearOut(c,s,self);   // a load in hand is delivered first
      // Goods he picked up off the floor (the plugin hands loose items to him): filed straight into their chests.
      const loose=W.load?[]:Object.entries(self.inventory??{}).filter(([k,n])=>n>0&&k!=='PAPER'&&!(EDIBLE.test(k)&&n<=16)&&now()-((W.stuck??{})[k]??0)>=600000);
      if(loose.length)return async()=>{if(!await civic().goToWarehouse(c.id,self))return;set('FILE_PICKUPS');
        // What the warehouse will not take (over its storage cap, no room) is set aside for 10 minutes, not retried forever.
        const toMarket=[];
        for(const [item,n] of loose){const put=await civic().deposit(c.id,item,n);if(put)log('floor_item_filed',{agent:c.id,item,count:put});else{(W.stuck??={})[item]=now();if(civic().shopFor?.(item))toMarket.push({item,count:n});}}
        // No room in its own category: carried to the market with the next load.
        if(toMarket.length&&!W.load){W.load=toMarket;log('surplus_loaded',{agent:c.id,load:toMarket,why:'category_full'});}};
      const next=due?null:map.nextMove(chests,{agent:c.id,skip:item=>now()-((W.stuck??{})[item]??0)<600000});
      // Nothing to sort: on duty he stays in the warehouse at his spot, keeping an eye on the drop box (he leaves only
      // off duty - the evening and the night - or to sleep). Off duty: his own time.
      if(!due&&!next){set('IDLE');return onDuty?async()=>{await civic().goToWarehouse(c.id,self);}:null;}
      return async()=>{
        if(!await civic().goToWarehouse(c.id,self))return;
        if(due){await index(c);return;}
        set(STATE_OF[next.kind],{item:next.item});
        if(next.kind==='to_market'&&civic().hasRunner?.()){civic().queueForMarket(next.item,next.count);(W.stuck??={})[next.item]=now();log('market_flagged',{agent:c.id,item:next.item,count:next.count});return;}
        if(next.kind==='to_market'){
          // Its own category's chests are full: out of this chest and onto Marlo's stalls (with any other surplus).
          if(!civic().shopFor?.(next.item)){(W.stuck??={})[next.item]=now();return;}
          if(civic().reachChest&&!await civic().reachChest(c.id,next.from))return;
          const got=await act(c.id,{type:'withdraw',x:next.from.x,y:next.from.y,z:next.from.z,target:next.item,count:next.count}).then(r=>r?.withdrew??0).catch(()=>0);
          if(!got){(W.stuck??={})[next.item]=now();return;}
          civic().noteChest(next.from,next.item,-got);W.load=[{item:next.item,count:got}];
          log('surplus_loaded',{agent:c.id,load:W.load,why:'category_full',from:{x:next.from.x,y:next.from.y,z:next.from.z}});
          return;
        }
        await move(c,self,next);
        if(ready('relabel',60000))await relabel(c).catch(()=>{});
      };
    },
    /** Whether there is warehouse work waiting (the banker hands over between serving rounds); "carrying" with a load in hand. */
    pending(){if(W.load)return "carrying";if(!town.built?.warehouse)return false;const map=civic()?.warehouseMap?.();if(!map)return false;const chests=town.stock?.chests??[],free=chests.reduce((x,c)=>x+(c.free??0),0);
      return now()-W.lastIndex>600000||((free<10||unstackableSurplus(town.stock?.items).length>0)&&!!byMerchant()&&surplusOf(town.stock?.items??{}).length>0)||!!map.nextMove(chests,{skip:item=>now()-((W.stuck??{})[item]??0)<600000});},
    /** On duty: every waking hour (dawn, day and dusk). The worker keeps gatherings, quests and hobbies off him meanwhile. */
    onDuty(){const p=d.phase?.()??'day';return p!=='night';},   // every waking hour: Jasper is an essential worker
    /** Every warehouse chest with what is in it (dashboard Warehouse page). */
    chests(){const map=civic()?.warehouseMap?.();
      return (town.stock?.chests??[]).map(c=>({x:c.x,y:c.y,z:c.z,size:c.size??54,free:c.free??null,items:c.items??{},
        category:map?.categoryOfChest(c)??null,dedicated:map?.dedicatedTo?.(c)??null}));},
    view:()=>({state:W.state,counter:{waiting:(town.counter?.requests??[]).filter(r=>r.status==='open').length,served:town.counter?.served??0},moves:W.moves,filed:W.filed,merged:W.merged,lastIndex:W.lastIndex?new Date(W.lastIndex).toISOString():null,
      categories:civic()?.warehouseMap?.()?.summary(town.stock?.chests??[])??{},itemCategory:Object.fromEntries(Object.keys(town.stock?.items??{}).map(k=>[k,categoryOf(k)])),market:civic()?.marketView?.()??null,chests:(()=>{try{return d.chestsView?.()??null;}catch{return null;}})()}),
    context(c){return c.role==='clerk'?{warehouse:`You are the warehouse clerk: Barnaby handles citizen fetch requests and deliveries; you stay inside the warehouse to sort and consolidate chests by category (${W.filed} items filed, ${W.merged} merged so far). Mention misplaced goods with mild exasperation; you know where every material is.`}:{};},
  };
}
