// Mayor funding is serialized with payroll and persisted before each physical move.
export function createFunding({bank,physical,save,now=()=>Date.now(),log=()=>{}}){
 const state=bank.state;state.fundingOps??=[];
 for(const op of state.fundingOps)if(['moving','prepared'].includes(op.status)){op.status='review';op.error='Interrupted transaction requires review';}
 const sources=new Set(['grant','warehouse','donate','treasury','reconcile']);
 const count=async()=>{
  const r=await physical({op:'count',count:1});
  if(!Number.isInteger(r?.vault)||r.vault<0||!Number.isInteger(r?.treasury)||r.treasury<0)throw Error('Could not verify vault and treasury balances');
  return r;
 };
 const answer=op=>({id:op.id,status:op.status,amount:op.credited,requested:op.amount,audit:state.lastAudit,
  message:op.status==='review'?'A coin move needs review; no retry will repeat it.':`${op.credited} of ${op.amount} emeralds ${op.source==='treasury'?'moved to the warehouse treasury':'assigned to wage reserves'}${op.error?`: ${op.error}`:'.'}`});
 async function run({source,amount,actor,opId,memo=''}){
  if(!sources.has(source)||!Number.isInteger(amount)||amount<1||amount>4096||!actor||!/^[-a-zA-Z0-9_:]{1,100}$/.test(opId??''))throw Error('Choose a funding source and 1–4096 whole emeralds');
  return bank.withLock('~finance',()=>bank.withLock(actor,()=>bank.withLock('~vault',async()=>{
   const old=state.fundingOps.find(o=>o.id===opId);
   if(old){if(old.source!==source||old.amount!==amount||old.actor!==actor)throw Error('Transaction ID already belongs to a different request');return {...answer(old),repeated:true};}
   if(state.pending.length||state.fundingOps.some(o=>o.status==='review'))throw Error('Resolve pending bank transactions before adding or reconciling funds');
   let before=await count();const a=bank.audit(before.vault),res=state.municipal_vault;
   if(source==='reconcile'){
    if(a.diff<=0||amount!==a.diff)throw Error(`Verified surplus is ${Math.max(0,a.diff)}; reconcile that exact amount`);
   }else if(!a.ok)throw Error('Reconcile the vault difference before moving funding');
   if(source==='warehouse'&&before.treasury<amount)throw Error(`The warehouse treasury has only ${before.treasury}`);
   if(source==='treasury'&&res.total_tax_reserves<amount)throw Error(`Wage reserves have only ${res.total_tax_reserves}`);
   const account=bank.account(actor);
   if(source==='donate'&&account.balance<amount)throw Error(`Your account has only ${account.balance}`);
   const op={id:opId,actor,source,amount,memo:String(memo).slice(0,120),credited:0,status:'prepared',time:new Date(now()).toISOString()};
   state.fundingOps.unshift(op);await save();
   if(source==='reconcile'||source==='donate'){
    if(source==='donate'){
     account.balance-=amount;account.transaction_history.unshift({id:`F-${opId}`,type:'DONATION',amount,timestamp:op.time,memo:op.memo||'Mayor donation to wage reserves'});account.transaction_history.length=Math.min(50,account.transaction_history.length);
    }
    res.total_tax_reserves+=amount;op.credited=amount;op.status='done';
   }else{
    const physicalOp={grant:'grant',warehouse:'from_treasury',treasury:'to_treasury'}[source];
    const sign=source==='treasury'?-1:1;
    while(op.credited<amount){
     const n=Math.min(64,amount-op.credited);op.chunk={count:n,beforeVault:before.vault,beforeTreasury:before.treasury};op.status='moving';await save();
     let after,error;
     try{await physical({op:physicalOp,count:n});after=await count();}
     catch(e){error=e;try{after=await count();}catch{}}
     const moved=after?.vault===before.vault+sign*n&&(source==='grant'?after.treasury===before.treasury:after.treasury===before.treasury-sign*n);
     const unchanged=after?.vault===before.vault&&after?.treasury===before.treasury;
     if(moved){res.total_tax_reserves+=sign*n;op.credited+=n;before=after;delete op.chunk;op.status='prepared';await save();continue;}
     op.status=unchanged?'failed':'review';op.error=error?.message??'Coin counts did not match the requested move';await save();
     if(!op.credited&&unchanged)throw Error(op.error);
     break;
    }
    if(op.credited===amount)op.status='done';
   }
   await save();const final=await count();res.treasury_balance=final.treasury;bank.audit(final.vault);await save();
   log('mayor_funding',{...op,audit:state.lastAudit});return answer(op);
  })));
 }
 return {run,view:()=>({limit:4096,operations:state.fundingOps.slice(0,12),blocked:state.fundingOps.some(o=>o.status==='review')})};
}
