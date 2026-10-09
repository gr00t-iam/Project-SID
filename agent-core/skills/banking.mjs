// The town bank: every citizen's emerald account, the municipal vault (tax reserves) and the treasury float.
//
//   memory.data.bank = {
//     accounts:        { citizen_id: { balance, deposited_at, transaction_history: [{id, type, amount, timestamp, memo}] } },
//     municipal_vault: { total_tax_reserves, treasury_balance },
//     wage_rates:      { FARMING, MINING, ... }   emeralds per unit of work (skills/economy.mjs uses them)
//     tax_config:      { income_tax_rate, sales_tax_rate, tax_collection_interval_ticks },
//     ops:             recent operation ids (a repeated request is answered, not done twice)
//   }
//
// Money is real: the emeralds behind every balance and the tax reserves lie in the bank's vault chests (plugin action
// "vault"), so physical vault = sum of balances + tax reserves, which the Banker's audit checks. Each operation on an
// account runs under that account's lock; the ledger entry is written first and taken back if the coins cannot move.
// Transaction types: DEPOSIT, WITHDRAWAL, WAGE, TAX (and TRANSFER for the town's own moves).

// Emeralds per unit of work done without goods (goods are paid by their value: skills/economy.mjs goodsValue).
// A day's honest work in any role comes to roughly the daily cap (tax_config.daily_pay_cap).
export const DEFAULT_WAGE_RATES={FARMING:0.25,MINING:0.5,LUMBER:0.15,FISHING:0.4,CRAFTING:0.1,COOKING:0.15,BUILDING:0.05,HAULING:0.01,PATROL:1,GUARDING:3,TENDING:0.05,DEFENSE:1,INVESTIGATION:2};
// daily_pay_cap: most a citizen can earn from work in a real day; holding_fee: share of a balance above holding_free
// returned to the town once a day; stipend_floor: citizens below it get a stipend from the town's surplus.
export const DEFAULT_TAX={income_tax_rate:0.10,sales_tax_rate:0.05,tax_collection_interval_ticks:12000,daily_pay_cap:24,holding_fee:0.02,holding_free:64,stipend_floor:12,reserve_buffer:48};
const HISTORY=50;

export function emptyBank(){
  return {accounts:{},municipal_vault:{total_tax_reserves:0,treasury_balance:0},wage_rates:{...DEFAULT_WAGE_RATES},tax_config:{...DEFAULT_TAX},ops:[],next:1};
}
/** Income tax on a gross amount (whole emeralds, rounded down so a 1-emerald wage is not taxed to nothing). */
export function taxOn(gross,rate){return Math.max(0,Math.floor(gross*rate));}

// The plugin connection dropped while an action was in flight: the coins may or may not have moved.
export const UNKNOWN_OUTCOME=/outcome may be unknown|disconnected|timed? ?out|socket|ECONNRESET/i;

export function createBank(bank,{now=()=>Date.now(),log=()=>{},physical=async()=>({ok:true}),retryMs=1500}={}){
  bank.accounts??={};bank.municipal_vault??={total_tax_reserves:0,treasury_balance:0};bank.wage_rates={...DEFAULT_WAGE_RATES,...bank.wage_rates};
  bank.tax_config={...DEFAULT_TAX,...bank.tax_config};bank.ops??=[];bank.next??=1;
  // One-time: rates from before the valuation fix (tending, hauling and crafting paid far too much) give way to the new ones.
  if(!bank.ratesV2){bank.ratesV2=true;bank.wage_rates={...DEFAULT_WAGE_RATES};}
  const iso=()=>new Date(now()).toISOString();
  const locks=new Map();
  /** Runs fn with the account locked: operations on one account happen one after another, never interleaved. */
  function withLock(key,fn){
    const prev=locks.get(key)??Promise.resolve();
    const run=prev.then(fn,fn);
    const tail=run.catch(()=>{});locks.set(key,tail);tail.then(()=>{if(locks.get(key)===tail)locks.delete(key);});
    return run;
  }
  const account=id=>bank.accounts[id]??=({balance:0,deposited_at:null,transaction_history:[]});
  const amountOk=n=>Number.isInteger(n)&&n>0&&n<=100000;
  const MAX_COUNTER=64;   // emeralds handed over the counter in one go (one stack)
  function record(id,type,amount,memo){
    const t={id:`T-${String(bank.next++).padStart(6,'0')}`,type,amount,timestamp:iso(),memo:String(memo??'').slice(0,120)};
    const a=account(id);a.transaction_history.unshift(t);a.transaction_history.length=Math.min(a.transaction_history.length,HISTORY);
    return t;
  }
  function unrecord(id,t){const a=account(id);a.transaction_history=a.transaction_history.filter(x=>x!==t);}
  /** A repeated operation id gets the first answer back (a retried request never pays twice). */
  function once(opId,fn){
    if(!opId)return fn();
    const seen=bank.ops.find(o=>o.id===opId);if(seen)return Promise.resolve({...seen.result,repeated:true});
    return fn().then(result=>{bank.ops.unshift({id:opId,result});bank.ops.length=Math.min(bank.ops.length,200);return result;});
  }

  // ---------- moving real coins ----------
  // Every physical move runs under the vault lock, so vault counts before and after a move belong to that move alone.
  // A lost acknowledgement ("outcome may be unknown") is never guessed at: the vault is counted again. Unchanged ->
  // nothing moved; changed by exactly the amount -> it moved; anything else -> held as a pending transaction that the
  // Banker's audit settles (see audit). Definite errors mean nothing moved.
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const vaultCount=async()=>{try{const r=await physical({op:'count',count:1});return Number.isFinite(r?.vault)?r.vault:null;}catch{return null;}};
  const SIGN={deposit:1,mint:1,withdraw:-1,to_treasury:-1};
  /** Moves coins; returns {status:'done'|'failed'|'unknown', error}. Call with the vault lock held. */
  async function move(op,{agent=null,count}){
    const before=await vaultCount();
    try{await physical({op,agent,count});return {status:'done'};}
    catch(err){
      const msg=err?.message??String(err);
      if(!UNKNOWN_OUTCOME.test(msg))return {status:'failed',error:msg};
      if(before==null)return {status:'unknown',error:msg};
      for(let i=1;i<=3;i++){
        await sleep(retryMs*i);
        const after=await vaultCount();if(after==null)continue;
        if(after===before+SIGN[op]*count)return {status:'done',reconciled:true};
        if(after===before)return {status:'failed',error:msg,reconciled:true};
        return {status:'unknown',error:msg};
      }
      return {status:'unknown',error:msg};
    }
  }
  bank.pending??=[];
  function pend(kind,id,amount,memo){
    const p={id:`P-${String(bank.next++).padStart(6,'0')}`,kind,account:id,amount,memo,timestamp:iso()};
    bank.pending.push(p);log('bank_pending',p);return p;
  }

  /** deposit_emeralds: coins from the citizen's inventory into the vault, credited once they are confirmed in the vault. */
  function deposit(id,amount,{opId=null,memo='deposit at the bank'}={}){
    if(!amountOk(amount)||amount>MAX_COUNTER)return Promise.reject(Error(`Deposit a whole number of emeralds (1 to ${MAX_COUNTER} at a time)`));
    return withLock(id,()=>once(opId,()=>withLock('~vault',async()=>{
      const a=account(id),m=await move('deposit',{agent:id,count:amount});
      if(m.status==='failed')throw Error(`Deposit failed: ${m.error}`);
      if(m.status==='unknown'){const p=pend('deposit',id,amount,memo);return {balance:a.balance,txn:null,pending:p.id};}
      const t=record(id,'DEPOSIT',amount,memo);a.balance+=amount;a.deposited_at=iso();
      log('bank_deposit',{agent:id,amount,balance:a.balance,txn:t.id,reconciled:!!m.reconciled});
      return {balance:a.balance,txn:t.id};
    })));
  }
  /**
   * withdraw_emeralds: only the account holder (requester === id), only what the balance covers. The balance is
   * debited before the coins move, so two withdrawals at once can never both pass on the same coins; it is refunded
   * only when the vault proves the coins did not move.
   */
  function withdraw(id,amount,{requester,opId=null,memo='withdrawal at the bank'}={}){
    if(requester!==id)return Promise.reject(Error('Only the account holder can withdraw from an account'));
    if(!amountOk(amount)||amount>MAX_COUNTER)return Promise.reject(Error(`Withdraw a whole number of emeralds (1 to ${MAX_COUNTER} at a time)`));
    return withLock(id,()=>once(opId,()=>withLock('~vault',async()=>{
      const a=account(id);
      if(a.balance<amount)throw Error(`Insufficient funds: the balance is ${a.balance} emeralds`);
      a.balance-=amount;
      const m=await move('withdraw',{agent:id,count:amount});
      if(m.status==='failed'){a.balance+=amount;throw Error(`Withdrawal failed: ${m.error}`);}
      if(m.status==='unknown'){const p=pend('withdrawal',id,amount,memo);return {balance:a.balance,txn:null,pending:p.id};}   // stays debited until the audit
      const t=record(id,'WITHDRAWAL',amount,memo);
      log('bank_withdrawal',{agent:id,amount,balance:a.balance,txn:t.id,reconciled:!!m.reconciled});
      return {balance:a.balance,txn:t.id};
    })));
  }
  /**
   * Cash out for someone without an inventory of their own in the plugin (a player): the coins leave the vault into
   * the hands of `agent` (the Banker at the counter), who hands them over. Debited only when the vault confirms the
   * move; if the hand-over fails the coins go back into the vault and the balance is restored.
   */
  function cashOut(id,amount,{agent,handOver}){
    if(!amountOk(amount)||amount>MAX_COUNTER)return Promise.reject(Error(`Cash out 1 to ${MAX_COUNTER} emeralds at a time`));
    return withLock(id,()=>withLock('~vault',async()=>{
      const a=account(id);if(a.balance<amount)throw Error(`The balance is ${a.balance} emeralds`);
      a.balance-=amount;
      const m=await move('withdraw',{agent,count:amount});
      if(m.status==='failed'){a.balance+=amount;throw Error(`Cash out failed: ${m.error}`);}
      if(m.status==='unknown'){pend('withdrawal',id,amount,'cash out');return {balance:a.balance,pending:true};}
      const handed=await handOver(amount).then(()=>true).catch(()=>false);
      if(!handed){const back=await move('deposit',{agent,count:amount});if(back.status!=='failed')a.balance+=amount;throw Error('Could not hand the coins over (come within 4 blocks of the Banker)');}
      record(id,'WITHDRAWAL',amount,'cash out at the counter');
      log('bank_cashout',{account:id,amount,balance:a.balance,by:agent});
      return {balance:a.balance};
    }));
  }
  /** New money against goods (economy.mjs): into the vault and nowhere else until payroll credits it. */
  function mint(n){
    return withLock('~vault',async()=>{
      const m=await move('mint',{count:n});
      if(m.status==='done')return n;
      if(m.status==='unknown'){pend('mint',null,n,'payroll mint');throw Error('mint outcome unknown');}
      throw Error(m.error);
    });
  }
  /**
   * Payroll credit: gross pay for work, income tax withheld into the municipal vault. The coins are already in the
   * vault (minted against goods, or taken from the reserves) - the caller moves them first.
   */
  function payWage(id,gross,{memo='wages',fromReserves=false,taxFree=false}={}){
    if(!amountOk(gross))return Promise.reject(Error('Wages must be a whole number of emeralds'));
    return withLock(id,()=>withLock('~vault',async()=>{
      const v=bank.municipal_vault;
      if(fromReserves){if(v.total_tax_reserves<gross)throw Error(`The reserves hold only ${v.total_tax_reserves}`);v.total_tax_reserves-=gross;}
      const tax=taxFree?0:taxOn(gross,bank.tax_config.income_tax_rate),net=gross-tax,a=account(id);
      a.balance+=net;record(id,'WAGE',net,`${memo} (gross ${gross})`);
      if(tax>0){record(id,'TAX',tax,`income tax ${Math.round(bank.tax_config.income_tax_rate*100)}%`);v.total_tax_reserves+=tax;}
      log('bank_wage',{agent:id,gross,tax,net,balance:a.balance,fromReserves});
      return {gross,tax,net,balance:a.balance};
    }));
  }
  /**
   * Money changing hands inside the vault (no coins move, so it always clears): from a citizen's account or the town
   * ('~town', the tax reserves) to a citizen or the town. kind: 'wage' (income tax withheld into the reserves),
   * 'purchase' / 'fee' (to the town), 'stipend' (from the town, untaxed). Locks both accounts in a fixed order.
   */
  function transfer(from,to,amount,{memo='payment',kind='wage'}={}){
    if(!amountOk(amount))return Promise.reject(Error('Transfers are whole emeralds (1 or more)'));
    if(from===to)return Promise.reject(Error('Cannot pay yourself'));
    const keys=[from,to].filter(k=>k!=='~town').sort();
    const locked=fn=>keys.length===2?withLock(keys[0],()=>withLock(keys[1],()=>withLock('~vault',fn))):withLock(keys[0],()=>withLock('~vault',fn));
    return locked(async()=>{
      const v=bank.municipal_vault;
      if(from==='~town'){if(v.total_tax_reserves<amount)throw Error(`The town reserves hold only ${v.total_tax_reserves}`);v.total_tax_reserves-=amount;}
      else{const a=account(from);if(a.balance<amount)throw Error(`Insufficient funds: the balance is ${a.balance}`);a.balance-=amount;record(from,'TRANSFER',amount,`${memo} (to ${to==='~town'?'the town':to})`);}
      const tax=kind==='wage'?taxOn(amount,bank.tax_config.income_tax_rate):0,net=amount-tax;
      if(to==='~town')v.total_tax_reserves+=amount;
      else{const b=account(to);b.balance+=net;record(to,kind==='stipend'?'STIPEND':kind==='fine'?'FINE':'WAGE',net,`${memo}${from==='~town'?' (from the town)':` (from ${from})`}`);
        if(tax>0){record(to,'TAX',tax,`income tax ${Math.round(bank.tax_config.income_tax_rate*100)}%`);v.total_tax_reserves+=tax;}}
      log('bank_transfer',{from,to,amount,kind,tax,memo});
      return {amount,tax,net:to==='~town'?amount:net};
    });
  }
  /** Sales tax on a sale (the old market fee): withheld from the producer's sale proceeds. */
  const salesTax=gross=>taxOn(gross,bank.tax_config.sales_tax_rate);
  /** The town's float: tax reserves moved to the warehouse treasury so quests and projects can pay. */
  function toTreasury(n,{memo='treasury float'}={}){
    return withLock('~vault',async()=>{
      const v=bank.municipal_vault;n=Math.min(n,v.total_tax_reserves,64);if(n<1)return 0;
      v.total_tax_reserves-=n;
      const m=await move('to_treasury',{count:n});
      if(m.status==='failed'){v.total_tax_reserves+=n;throw Error(m.error);}
      if(m.status==='unknown'){pend('to_treasury',null,n,memo);return 0;}
      log('bank_transfer',{to:'treasury',amount:n,memo,reserves:v.total_tax_reserves});
      return n;
    });
  }
  const balance=id=>({balance:bank.accounts[id]?.balance??0,history:(bank.accounts[id]?.transaction_history??[]).slice(0,10),pending:bank.pending.filter(p=>p.account===id)});
  /** What the vault must hold: every balance plus the tax reserves. */
  const liabilities=()=>Object.values(bank.accounts).reduce((s,a)=>s+a.balance,0)+bank.municipal_vault.total_tax_reserves;
  /**
   * Audit: the physical count against the books, settling a pending transaction when the count proves what happened.
   * With one pending transaction the difference says it all; with several, each is settled only when its amount alone
   * explains the difference (anything else waits for a person: logged as bank_audit with pending listed).
   */
  function audit(physicalCount){
    for(let pass=0;pass<bank.pending.length+1;pass++){
      const diff=physicalCount-liabilities();
      const p=bank.pending.length===1?bank.pending[0]:bank.pending.find(x=>x.amount===Math.abs(diff)&&diff!==0);
      if(!p)break;
      // Coins in the vault that the books do not count (+amount) or exactly what the books say (0).
      const extra=diff===p.amount,none=diff===0;
      if(!extra&&!none)break;
      bank.pending=bank.pending.filter(x=>x!==p);
      const moved=p.kind==='deposit'||p.kind==='mint'?extra:none;
      if(p.kind==='deposit'&&moved){const a=account(p.account);a.balance+=p.amount;a.deposited_at=iso();record(p.account,'DEPOSIT',p.amount,`${p.memo} (confirmed by audit)`);}
      if(p.kind==='withdrawal'){if(moved)record(p.account,'WITHDRAWAL',p.amount,`${p.memo} (confirmed by audit)`);else account(p.account).balance+=p.amount;}
      if(p.kind==='mint'&&moved)bank.municipal_vault.total_tax_reserves+=p.amount;   // minted coins nobody was paid with belong to the town
      if(p.kind==='to_treasury'&&!moved)bank.municipal_vault.total_tax_reserves+=p.amount;
      log('bank_pending_settled',{...p,moved});
    }
    const owed=liabilities(),diff=physicalCount-owed;
    bank.lastAudit={time:iso(),vault:physicalCount,owed,diff,ok:diff===0,pending:bank.pending.map(p=>`${p.id} ${p.kind} ${p.amount}`)};
    log('bank_audit',bank.lastAudit);
    return bank.lastAudit;
  }
  return {deposit,withdraw,payWage,mint,transfer,cashOut,salesTax,toTreasury,balance,liabilities,audit,withLock,account,state:bank};
}
