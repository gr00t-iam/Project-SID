// Labour monetization: work done in town becomes pay in the citizens' bank accounts (skills/banking.mjs).
//
//   goods delivered to the warehouse  -> the producer earns their market value (or the wage rate for the activity),
//                                        less sales tax; the goods back new money: the bank mints up to their value
//                                        (plus a 30% public-works share) - capped per day, so prices stay sane
//   work without goods                -> building (per block), tending, defence, crafting, hauling others' goods,
//                                        patrols and guard shifts, investigations: wage rate x units
//   skill level                       -> +10% per level above 1 (town.mjs levels from XP)
//   payroll (the Banker, every tax interval) -> whole emeralds are paid: minted against goods first, then from the
//                                        tax reserves; income tax is withheld into the municipal vault; anything
//                                        unfunded stays owed until the next payroll
// Pure helpers (activityOf, laborValue, planPayroll) are exported for tests.

const FOOD_RAW=/^(WHEAT|CARROT|POTATO|BEETROOT|PUMPKIN|MELON_SLICE|SWEET_BERRIES|APPLE|SUGAR_CANE|EGG|COCOA_BEANS)$/;
export const PUBLIC_WORKS_SHARE=0.3;
/** Which kind of work produced an item. */
export function activityOf(item){
  const k=String(item).toUpperCase();
  if(FOOD_RAW.test(k)||/_SEEDS$/.test(k))return 'FARMING';
  if(/_LOG$|_WOOD$|_SAPLING$|^STICK$/.test(k))return 'LUMBER';
  if(/^(COD|SALMON|TROPICAL_FISH|PUFFERFISH)$/.test(k))return 'FISHING';
  if(/^(BREAD|COOKED_|BAKED_POTATO|MUSHROOM_STEW|PUMPKIN_PIE|COOKIE|CAKE|RABBIT_STEW|BEETROOT_SOUP)/.test(k))return 'COOKING';
  if(/_ORE$|^RAW_|^COAL$|^DIAMOND|^EMERALD$|^REDSTONE|^LAPIS|^QUARTZ|^COBBLESTONE$|^COBBLED_DEEPSLATE$|^STONE$|^GRANITE$|^DIORITE$|^ANDESITE$|^FLINT$|^GRAVEL$|^SAND$|^CLAY_BALL$/.test(k))return 'MINING';
  return 'CRAFTING';
}
// What goods off the market price list are worth (value units, the market's scale: 40 units = 1 emerald paid).
// Byproducts nobody needs are worth nothing - delivering 3,000 wheat seeds used to pay like a field of wheat.
export const GOODS_VALUE={RAW_GOLD:5,GOLD_INGOT:7,DIAMOND:40,EMERALD:0,REDSTONE:1,LAPIS_LAZULI:1,RAW_COPPER:1.5,COPPER_INGOT:2,
  SPRUCE_LOG:1,BIRCH_LOG:1,DARK_OAK_LOG:1,JUNGLE_LOG:1,ACACIA_LOG:1,CHERRY_LOG:1,MANGROVE_LOG:1,SPRUCE_PLANKS:0.25,BIRCH_PLANKS:0.25,
  COD:1,SALMON:1.5,BEEF:1.5,PORKCHOP:1.5,CHICKEN:1,MUTTON:1,COOKED_BEEF:3,COOKED_PORKCHOP:3,COOKED_CHICKEN:2,COOKED_MUTTON:2,PUMPKIN_PIE:3,
  BEETROOT:0.6,PUMPKIN:1,MELON_SLICE:0.3,SUGAR_CANE:0.3,EGG:0.3,LEATHER:1,WOOL:0.5,STRING:0.3,FEATHER:0.2,GLASS:0.3,STONE:0.15,
  IRON_PICKAXE:20,IRON_AXE:20,IRON_SWORD:14,IRON_SHOVEL:8,IRON_HOE:14,STONE_PICKAXE:2,CHEST:2,CRAFTING_TABLE:1,FURNACE:2,LANTERN:4,BARREL:2};
export const UNITS_PER_EMERALD=40;
/** A good's value in value units (0 for anything not worth paying for). marketUnits: its live market value, if listed. */
export function goodsValue(item,marketUnits=null){
  const k=String(item).toUpperCase();
  if(marketUnits!=null)return marketUnits;
  return GOODS_VALUE[k]??0;
}
/** XP award kinds (town.mjs) that are paid work without goods changing hands. */
export const AWARD_ACTIVITY={place:'BUILDING',tend:'TENDING',kill:'DEFENSE',craft:'CRAFTING',smelt:'CRAFTING'};
/** The value of `units` of work at a skill level. */
export function laborValue(activity,units,{rates,level=1}={}){
  const rate=rates?.[activity]??0;
  return Math.max(0,rate*units*(1+0.1*Math.max(0,level-1)));
}
/**
 * Who gets paid how much from what funds: whole emeralds only; minted money first (up to `mintable`), then the
 * reserves. Returns {payouts:[{id,gross,minted,fromReserves}], minted, fromReserves}.
 */
export function planPayroll(pending,{mintable=0,reserves=0,multiplier=1}={}){
  let mint=Math.max(0,Math.floor(mintable)),res=Math.max(0,Math.floor(reserves));
  const payouts=[];
  for(const [id,value] of Object.entries(pending).sort((a,b)=>b[1]-a[1])){
    const gross=Math.floor(value*multiplier);if(gross<1)continue;
    const m=Math.min(gross,mint);mint-=m;
    const r=Math.min(gross-m,res);res-=r;
    if(m+r>0)payouts.push({id,gross:m+r,minted:m,fromReserves:r,owedValue:value,paidValue:(m+r)/multiplier});
  }
  return {payouts,minted:payouts.reduce((s,p)=>s+p.minted,0),fromReserves:payouts.reduce((s,p)=>s+p.fromReserves,0)};
}

export function createEconomy(d){
  const {bank,state,log=()=>{},ledger=()=>{},now=()=>Date.now()}=d;
  // state: memory.data.bank.labor = {pending:{id:value}, mintable, salesTax, earned:{id:{activity:value}}, lastPayroll, minted:{day,count}}
  state.pending??={};state.mintable??=0;state.salesTax??=0;state.earned??={};state.lastPayroll??=0;state.minted??={day:null,count:0};state.today??={day:null,earned:{}};state.tab??={};
  const rates=()=>bank.state.wage_rates;
  const cap=()=>bank.state.tax_config.daily_pay_cap??24;
  const today=()=>{const day=new Date(now()).toISOString().slice(0,10);if(state.today.day!==day)state.today={day,earned:{}};return state.today;};
  /** Credits pay owed for work, up to the daily cap per citizen (the rest of a very long day goes unpaid, as in any town). */
  const add=(id,activity,value)=>{if(!(value>0))return 0;
    const t=today(),room=Math.max(0,cap()-(t.earned[id]??0)),v=Math.min(value,room);if(v<=0)return 0;
    t.earned[id]=Math.round(((t.earned[id]??0)+v)*1000)/1000;
    state.pending[id]=Math.round(((state.pending[id]??0)+v)*1000)/1000;
    const e=state.earned[id]??={};e[activity]=Math.round(((e[activity]??0)+v)*100)/100;return v;};
  // One-time: the backlog built up while seeds and hauled goods were overpaid is cut to one day's cap each (back pay).
  if(!state.backlogFixedV1){state.backlogFixedV1=true;let before=0,after=0;
    for(const [id,v] of Object.entries(state.pending)){before+=v;state.pending[id]=Math.min(v,cap());after+=state.pending[id];}
    state.mintable=Math.min(state.mintable,after*(1+PUBLIC_WORKS_SHARE));
    log('backlog_adjusted',{before:Math.round(before),after:Math.round(after*100)/100});}
  /** Work without goods (from the XP awards and finished quests). */
  function labor(id,activity,units=1){
    if(!d.isCitizen?.(id))return 0;
    const v=laborValue(activity,units,{rates:rates(),level:d.levelOf?.(id)??1});add(id,activity,v);return v;
  }
  /**
   * Goods delivered to the warehouse: the producer earns their value; the goods back new money. A courier (or anyone
   * whose job is hauling) earns only hauling pay for goods it did not make; worthless goods earn nothing.
   * price: emeralds per item at the live market price, when the item is on the price list.
   */
  function sale(producer,item,n,{price=null,hauler=null}={}){
    if(!d.isCitizen?.(producer)||n<1)return 0;
    const unitValue=price!=null?price:goodsValue(item)/UNITS_PER_EMERALD;
    if(!(unitValue>0))return 0;
    if(d.isHauler?.(producer)){labor(producer,'HAULING',Math.min(n,64));return 0;}
    const activity=activityOf(item),value=unitValue*n*(1+0.1*Math.max(0,(d.levelOf?.(producer)??1)-1));
    const tax=value*bank.state.tax_config.sales_tax_rate;
    add(producer,activity,value-tax);state.salesTax+=tax;
    state.mintable+=value*(1+PUBLIC_WORKS_SHARE);
    if(hauler&&hauler!==producer)labor(hauler,'HAULING',Math.min(n,64));
    return value;
  }
  // ---------- money flowing back ----------
  /**
   * A citizen pays the town for something (a meal from the warehouse): small amounts add up on a tab and are paid in
   * whole emeralds from the account. Someone who cannot pay still eats (the town carries it).
   */
  async function charge(id,emeralds,memo='meal'){
    if(!d.isCitizen?.(id)||!(emeralds>0))return 0;
    state.tab[id]=Math.round(((state.tab[id]??0)+emeralds)*1000)/1000;
    const whole=Math.floor(state.tab[id]);if(whole<1)return 0;
    const bal=bank.state.accounts[id]?.balance??0,n=Math.min(whole,bal);if(n<1)return 0;
    await bank.transfer(id,'~town',n,{memo,kind:'purchase'});state.tab[id]-=n;return n;
  }
  /**
   * Once a day: a holding fee on large balances (money sitting idle returns to the town), then a stipend from the
   * town's surplus above its buffer to the poorest citizens - so the reserves never run dry and nobody stays broke.
   */
  async function recirculate(citizens=[]){
    const tc=bank.state.tax_config,v=bank.state.municipal_vault,day=new Date(now()).toISOString().slice(0,10);
    const out={fees:0,stipends:0,paid:[]};
    if(state.lastHoldingDay!==day){state.lastHoldingDay=day;
      for(const [id,a] of Object.entries(bank.state.accounts)){const fee=Math.floor(Math.max(0,a.balance-tc.holding_free)*tc.holding_fee);
        if(fee>=1){await bank.transfer(id,'~town',fee,{memo:`holding fee ${Math.round(tc.holding_fee*100)}% above ${tc.holding_free}`,kind:'fee'}).catch(()=>{});out.fees+=fee;}}}
    const surplus=v.total_tax_reserves-tc.reserve_buffer;
    if(surplus>=2){
      const poor=citizens.map(id=>({id,b:bank.state.accounts[id]?.balance??0})).filter(x=>x.b<tc.stipend_floor).sort((x,y)=>x.b-y.b);
      let budget=Math.floor(surplus/2);
      for(const p of poor){if(budget<1)break;const n=Math.min(budget,tc.stipend_floor-p.b,4);if(n<1)continue;
        await bank.transfer('~town',p.id,n,{memo:'town stipend',kind:'stipend'}).then(()=>{budget-=n;out.stipends+=n;out.paid.push(p.id);}).catch(()=>{});}
    }
    if(out.fees||out.stipends)log('recirculation',{...out,reserves:v.total_tax_reserves});
    return out;
  }
  /** Due when a tax interval has passed (interval in game ticks, 20 a second). */
  const due=()=>now()-state.lastPayroll>=bank.state.tax_config.tax_collection_interval_ticks/20*1000;
  /**
   * issue_payroll: mint against goods (capped per day), pay whole emeralds with income tax withheld; sales tax into
   * the reserves. mint(n) moves real emeralds into the vault and throws when it cannot.
   */
  async function payroll({mint,multiplier=1,dailyCap=256}={}){
    state.lastPayroll=now();
    const day=new Date(now()).toISOString().slice(0,10);if(state.minted.day!==day)state.minted={day,count:0};
    const room=Math.max(0,dailyCap-state.minted.count);
    const salesTax=Math.floor(state.salesTax),plan=planPayroll(state.pending,{mintable:Math.min(Math.floor(state.mintable),room)-Math.min(salesTax,room),reserves:Math.max(0,bank.state.municipal_vault.total_tax_reserves-(bank.state.tax_config.reserve_buffer??48)),multiplier});   // the buffer stays for quests and stipends
    // The coins first: minted wages plus the sales tax collected since the last payroll.
    let toMint=plan.minted+Math.min(salesTax,room),minted=0;
    try{while(toMint>0){const k=Math.min(64,toMint);await mint(k);minted+=k;toMint-=k;}}
    catch(error){log('bank_mint_failed',{wanted:plan.minted+salesTax,minted,message:error.message});}
    state.minted.count+=minted;state.mintable=Math.max(0,state.mintable-minted);
    // Sales tax goes into the reserves (as far as it was minted).
    const taxIn=Math.min(Math.min(salesTax,room),minted);
    if(taxIn>0){bank.state.municipal_vault.total_tax_reserves+=taxIn;state.salesTax-=taxIn;}
    let mintLeft=minted-taxIn;const paid=[];
    for(const p of plan.payouts){
      const m=Math.min(p.minted,mintLeft);mintLeft-=m;const gross=m+p.fromReserves;if(gross<1)continue;
      // Only what really reached the account leaves the owed list (a failed credit keeps the wage owed).
      let paidGross=0;
      if(m>0)await bank.payWage(p.id,m,{memo:'payroll'}).then(()=>{paidGross+=m;})
        .catch(e=>{bank.state.municipal_vault.total_tax_reserves+=m;log('bank_wage_failed',{agent:p.id,gross:m,message:e.message,to:'reserves'});});   // minted coins stay with the town
      if(p.fromReserves>0)await bank.payWage(p.id,p.fromReserves,{memo:'payroll (town reserves)',fromReserves:true}).then(()=>{paidGross+=p.fromReserves;})
        .catch(e=>log('bank_wage_failed',{agent:p.id,gross:p.fromReserves,message:e.message}));
      if(paidGross<1)continue;
      state.pending[p.id]=Math.max(0,Math.round((state.pending[p.id]-paidGross/multiplier)*1000)/1000);
      if(state.pending[p.id]<0.001)delete state.pending[p.id];
      paid.push({id:p.id,gross:paidGross});
    }
    const total=paid.reduce((s,p)=>s+p.gross,0);
    log('payroll',{paid:paid.length,total,minted,salesTax:taxIn,reserves:bank.state.municipal_vault.total_tax_reserves,owed:Math.round(Object.values(state.pending).reduce((s,v)=>s+v,0)*100)/100});
    if(total)ledger(d.bankerId?.()??'governor',`paid ${total} emeralds in wages to ${paid.length} citizens (income tax withheld into the town vault)`);
    return {paid,total,minted,salesTax:taxIn};
  }
  /** appraise_labor: wage rates follow what the town needs (food short -> farming and cooking pay more). */
  function appraise({pantryStatus='healthy',shortages=[],threats=0}={}){
    const r=bank.state.wage_rates,base=d.baseRates??{},before={...r};
    const set=(k,f)=>{const b=base[k]??r[k];r[k]=Math.round(b*f*1000)/1000;};
    const food=pantryStatus==='critical'?1.6:pantryStatus==='low'?1.3:1;
    set('FARMING',food);set('COOKING',food);set('FISHING',food);
    set('BUILDING',shortages.length?1.2:1);set('MINING',shortages.some(s=>/STONE|COBBLE|ORE|INGOT|BRICK/.test(s))?1.3:1);
    set('PATROL',threats>=5?1.5:1);set('GUARDING',threats>=5?1.5:1);
    const changed=Object.keys(r).filter(k=>r[k]!==before[k]);
    if(changed.length)log('wage_rates',{changed:Object.fromEntries(changed.map(k=>[k,r[k]]))});
    return changed;
  }
  const view=()=>({today:today().earned,dailyCap:cap(),tabs:state.tab,owed:Object.fromEntries(Object.entries(state.pending).map(([k,v])=>[k,Math.round(v*100)/100])),mintable:Math.round(state.mintable*10)/10,
    salesTaxPending:Math.round(state.salesTax*100)/100,mintedToday:state.minted,earned:state.earned,lastPayroll:state.lastPayroll});
  return {labor,sale,charge,recirculate,due,payroll,appraise,view};
}
