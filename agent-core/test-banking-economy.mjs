// The bank and the labour economy end to end, against a simulated vault that behaves like the plugin's (emeralds
// move between citizens' inventories, the vault chests and the treasury; minting is capped per day):
//   1. citizens earn through work (goods delivered, blocks built, a patrol shift) and payroll pays them, tax withheld
//   2. a deposit with the Banker: balance and transaction log updated, coins in the vault
//   3. income and sales tax go into the municipal vault; the treasury float comes out of the reserves
//   4. withdrawals: over-budget, someone else's account, a double request and a failed hand-over are all refused safely
//   5. the audit: vault = every balance + the reserves
//   node agent-core/test-banking-economy.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {createBank,emptyBank,taxOn} from './skills/banking.mjs';
import {createEconomy,activityOf,planPayroll} from './skills/economy.mjs';
import {createBanker} from './roles/banker.mjs';

export async function simulate(){
  const failures=[],steps=[];const check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=Date.parse('2026-10-01T16:00:00Z');const now=()=>t;
  // The world: inventories, the vault, the treasury (warehouse), a daily mint cap.
  const world={inv:{scout:{EMERALD:27},farmer:{EMERALD:4},builder:{EMERALD:0}},vault:0,treasury:0,minted:0,cap:256,failNext:false};
  const physical=async({op,agent,count})=>{
    if(op==='count')return {vault:world.vault};
    if(world.failNext){world.failNext=false;throw Error('The vault is full');}
    // A lost acknowledgement: the coins moved (or not), but the answer never came back.
    const lost=world.lostAck;world.lostAck=null;
    if(lost==='not')throw Error('Disconnected; action outcome may be unknown');
    const inv=world.inv[agent]??={};
    switch(op){
      case 'deposit':if((inv.EMERALD??0)<count)throw Error('Not enough EMERALD');inv.EMERALD-=count;world.vault+=count;break;
      case 'withdraw':if(world.vault<count)throw Error(`The vault only has ${world.vault}`);world.vault-=count;inv.EMERALD=(inv.EMERALD??0)+count;break;
      case 'mint':if(world.minted+count>world.cap)throw Error('Mint cap reached');world.minted+=count;world.vault+=count;break;
      case 'to_treasury':if(world.vault<count)throw Error('short');world.vault-=count;world.treasury+=count;break;
    }
    await new Promise(r=>setTimeout(r,2));   // the round trip to the server
    if(lost==='moved')throw Error('Disconnected; action outcome may be unknown');
    if(lost==='skew'){world.vault+=2;throw Error('Disconnected; action outcome may be unknown');}   // something else moved too: ambiguous
    return {vault:world.vault};
  };
  const state=emptyBank();state.labor={backlogFixedV1:true};state.tax_config.daily_pay_cap=1000;   // the mechanics first; the cap is checked on its own below
  const logs=[];const log=(type,data)=>logs.push({type,...data});
  const bank=createBank(state,{now,log,physical,retryMs:1});
  const levels={farmer:3,builder:2,sheriff:1,scout:1,courier:1};
  const economy=createEconomy({bank,state:state.labor,log,now,isCitizen:id=>id in levels,levelOf:id=>levels[id],isHauler:id=>id==='courier'});

  // ---------- 1. work becomes pay ----------
  check(activityOf('WHEAT')==='FARMING'&&activityOf('RAW_IRON')==='MINING'&&activityOf('OAK_LOG')==='LUMBER'&&activityOf('BREAD')==='COOKING','items map to the right kind of work');
  economy.sale('farmer','WHEAT',40,{price:0.5,hauler:'courier'});           // 20 emeralds of wheat, hauled by the courier
  economy.labor('builder','BUILDING',120);                                  // 120 blocks placed
  economy.labor('sheriff','PATROL',1);                                      // one patrol shift
  const owed=economy.view().owed;
  const wheatPay=20*1.2*0.95;   // 40 wheat at 0.5, +20% for a level-3 farmer, less 5% sales tax
  check(Math.abs(owed.farmer-wheatPay)<0.01,`the farmer is owed the wheat's value less 5% sales tax (owed ${owed.farmer})`);
  check(owed.builder>6&&owed.sheriff===1&&owed.courier>0,'building, patrolling and hauling are paid work');
  steps.push(`owed before payroll: ${Object.entries(owed).map(([k,v])=>`${k} ${v}`).join(', ')}`);
  t+=state.tax_config.tax_collection_interval_ticks/20*1000+1;
  check(economy.due(),'payroll is due after the tax interval');
  const pay=await economy.payroll({mint:n=>physical({op:'mint',count:n})});
  const farmer=bank.balance('farmer');
  const g=Math.floor(wheatPay);
  check(farmer.balance===g-taxOn(g,0.10),`the farmer's account holds the wage less 10% income tax (${farmer.balance})`);
  check(farmer.history.some(x=>x.type==='WAGE')&&farmer.history.some(x=>x.type==='TAX'&&x.amount===taxOn(g,0.10)),'WAGE and TAX transactions are logged');
  check(world.vault===bank.liabilities(),`the minted coins are in the vault (${world.vault}) and match the books (${bank.liabilities()})`);
  check(state.municipal_vault.total_tax_reserves>=taxOn(19,0.10)+1,'income tax and sales tax are in the municipal reserves');
  steps.push(`payroll: ${pay.total} emeralds to ${pay.paid.length} citizens, ${pay.minted} minted, reserves ${state.municipal_vault.total_tax_reserves}`);

  // ---------- 2. a deposit ----------
  const dep=await bank.deposit('scout',20,{memo:'savings'});
  check(dep.balance===20&&world.inv.scout.EMERALD===7&&bank.balance('scout').history[0].type==='DEPOSIT','the deposit is credited and logged; the coins left the inventory');
  check(world.vault===bank.liabilities(),'the vault still matches the books after the deposit');
  let err=null;try{await bank.deposit('scout',30);}catch(e){err=e.message;}
  check(/Deposit failed/.test(err)&&bank.balance('scout').balance===20,'depositing coins you do not have changes nothing');
  world.failNext=true;err=null;try{await bank.deposit('farmer',2);}catch(e){err=e.message;}
  check(err&&bank.balance('farmer').balance===farmer.balance&&!bank.balance('farmer').history.some(x=>x.type==='DEPOSIT'),'a deposit the vault refused is rolled back');

  // ---------- 3. taxes and the treasury ----------
  const before=state.municipal_vault.total_tax_reserves,moved=await bank.toTreasury(2);
  check(moved===2&&world.treasury===2&&state.municipal_vault.total_tax_reserves===before-2,'tax reserves fund the treasury float');
  check(world.vault===bank.liabilities(),'the books still balance after the transfer');

  // ---------- 4. withdrawals ----------
  err=null;try{await bank.withdraw('scout',50,{requester:'scout'});}catch(e){err=e.message;}
  check(/Insufficient funds/.test(err)&&bank.balance('scout').balance===20,'an over-budget withdrawal is refused');
  err=null;try{await bank.withdraw('scout',5,{requester:'builder'});}catch(e){err=e.message;}
  check(/account holder/.test(err)&&bank.balance('scout').balance===20,"someone else's withdrawal is refused");
  // Two withdrawals of the whole balance at the same moment: only one can pass.
  const both=await Promise.allSettled([bank.withdraw('scout',20,{requester:'scout'}),bank.withdraw('scout',20,{requester:'scout'})]);
  check(both.filter(r=>r.status==='fulfilled').length===1&&bank.balance('scout').balance===0&&world.inv.scout.EMERALD===27,'two simultaneous withdrawals cannot overdraw (one passes)');
  // The same request sent twice (a retry) pays once.
  await bank.deposit('scout',10);
  const a1=await bank.withdraw('scout',4,{requester:'scout',opId:'w-1'}),a2=await bank.withdraw('scout',4,{requester:'scout',opId:'w-1'});
  check(a2.repeated&&bank.balance('scout').balance===6&&a1.txn===a2.txn,'a repeated withdrawal request is answered, not paid twice');
  world.failNext=true;err=null;try{await bank.withdraw('scout',3,{requester:'scout'});}catch(e){err=e.message;}
  check(err&&bank.balance('scout').balance===6,'a withdrawal the vault could not hand over is refunded');
  check(world.vault===bank.liabilities(),'the vault matches the books after every withdrawal');
  // Lost acknowledgements: the vault is counted again instead of guessing.
  await bank.deposit('scout',3);const bal0=bank.balance('scout').balance,inv0=world.inv.scout.EMERALD;
  world.lostAck='moved';const w1=await bank.withdraw('scout',2,{requester:'scout'});
  check(w1.txn&&!w1.pending&&bank.balance('scout').balance===bal0-2&&world.inv.scout.EMERALD===inv0+2,'a withdrawal whose answer was lost but whose coins moved is NOT refunded');
  world.lostAck='not';let lostErr=null;try{await bank.withdraw('scout',1,{requester:'scout'});}catch(e){lostErr=e.message;}
  check(/Withdrawal failed/.test(lostErr)&&bank.balance('scout').balance===bal0-2,'a withdrawal whose coins never moved is refunded');
  world.lostAck='moved';const d1=await bank.deposit('scout',2);
  check(d1.txn&&bank.balance('scout').balance===bal0,'a deposit whose answer was lost but whose coins arrived is credited');
  world.lostAck='skew';const w2=await bank.withdraw('scout',1,{requester:'scout'});
  check(w2.pending&&bank.balance('scout').balance===bal0-1,'an ambiguous withdrawal stays debited and pending');
  world.vault-=2;   // the stray coins are found and removed; the vault now proves the withdrawal happened
  const settled=bank.audit(world.vault);
  check(settled.ok&&!state.pending.length&&bank.balance('scout').history[0].type==='WITHDRAWAL','the audit settles the pending withdrawal from the vault count');
  check(world.vault===bank.liabilities(),'books and vault agree after every lost acknowledgement');

  // ---------- 5. the Banker: payroll when due, the audit, the mint cap ----------
  const said=[];
  const banker=createBanker({act:async()=>({}),say:async(id,x)=>said.push(x),log,ledger:()=>{},getSnapshot:()=>({worldTime:6000,agents:[]}),travel:async()=>{},bank:()=>bank,economy:()=>economy,now,
    physical,treasury:()=>world.treasury,mintCap:256,counter:()=>null,isCitizen:id=>id in levels,day:()=>301});
  economy.sale('farmer','CARROT',30,{price:1});
  t+=state.tax_config.tax_collection_interval_ticks/20*1000+1;
  const job=banker.job({id:'banker',role:'banker'},{},{x:0,z:0},false);await job();
  check(world.treasury>=2&&said.some(x=>/Payroll is out/.test(x)),'the Banker runs payroll and tops up the treasury');
  const audit=await banker.audit({id:'banker'});
  check(audit?.ok,`the audit balances (vault ${audit?.vault}, owed ${audit?.owed})`);
  world.vault-=1;const bad=await banker.audit({id:'banker'});world.vault+=1;
  check(bad&&!bad.ok&&bad.diff===-1,'a missing emerald is caught by the audit');
  // A tight mint cap: what cannot be minted stays owed, nobody is paid with money that does not exist.
  world.cap=world.minted+3;economy.sale('farmer','WHEAT',40,{price:0.5});
  t+=state.tax_config.tax_collection_interval_ticks/20*1000+1;
  const capped=await economy.payroll({mint:n=>physical({op:'mint',count:n}),dailyCap:256});
  check(world.vault===bank.liabilities(),'with the mint cap reached the books still balance');
  check((economy.view().owed.farmer??0)>0,'pay that could not be funded stays owed');
  steps.push(`capped payroll: ${capped.total} paid, still owed ${JSON.stringify(economy.view().owed)}`);
  // ---------- 6. fair values, the daily cap, and money flowing back ----------
  const seeds=economy.sale('farmer','WHEAT_SEEDS',3000,{});
  check(seeds===0,'thousands of wheat seeds are worth nothing (the old overpayment)');
  const hauled=economy.sale('courier','WHEAT',500,{price:0.5});
  check(hauled===0&&(economy.view().owed.courier??0)<2,'a courier hauling crops earns hauling pay, not the crops');
  state.tax_config.daily_pay_cap=24;const owedBefore=economy.view().owed.farmer??0,earnedToday=economy.view().today.farmer??0;
  economy.sale('farmer','WHEAT',4000,{price:0.5});
  check(Math.abs((economy.view().today.farmer??0)-Math.max(earnedToday,24))<0.01,`a day's pay stops at the cap (${economy.view().today.farmer})`);
  // The loop: meals and purchases pay the town; idle wealth pays a holding fee; the town's surplus pays stipends.
  const r0=state.municipal_vault.total_tax_reserves;
  await economy.charge('farmer',2.6,'meal');
  check(state.municipal_vault.total_tax_reserves===r0+2&&Math.abs(state.labor.tab.farmer-0.6)<0.001,'a meal is paid from the account to the town (the remainder stays on the tab)');
  state.accounts.builder.balance=200;state.accounts.scout.balance=0;state.municipal_vault.total_tax_reserves=60;
  state.labor.lastHoldingDay=null;   // the Banker already ran today's fee in step 5
  const liab0=bank.liabilities(),circ=await economy.recirculate(['builder','scout','farmer']);
  check(circ.fees===Math.floor((200-64)*0.02),'a holding fee on balances above 64 returns to the town');
  check(circ.paid.includes('scout')&&state.accounts.scout.balance>0,'the poorest citizen gets a stipend from the surplus');
  check(state.municipal_vault.total_tax_reserves>=state.tax_config.reserve_buffer-0,'stipends never dig into the town buffer');
  check(bank.liabilities()===liab0,'recirculation moves money, it never creates or destroys it');
  const tr=await bank.transfer('~town','scout',5,{memo:'quest #9',kind:'wage'});
  check(tr.net===5-taxOn(5,0.1),'a quest paid by the town reaches the worker inside the bank, tax withheld');
  check(planPayroll({a:5.5,b:0.4},{mintable:3,reserves:10}).payouts.map(p=>`${p.id}:${p.minted}+${p.fromReserves}`).join()==='a:3+2','payroll plans mint first, then reserves, whole emeralds');
  return {failures,steps,balances:Object.fromEntries(Object.entries(state.accounts).map(([k,a])=>[k,a.balance])),vault:world.vault,reserves:state.municipal_vault.total_tax_reserves,treasury:world.treasury};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();
  for(const s of r.steps)console.log('-',s);
  console.log(`\nBalances: ${JSON.stringify(r.balances)}; vault ${r.vault}, tax reserves ${r.reserves}, treasury ${r.treasury}`);
  if(r.failures.length){console.log('\nFAILED:\n - '+r.failures.join('\n - '));process.exit(1);}
  console.log('\nAll checks passed: labour pay, deposits, taxes, treasury float, safe withdrawals, audit.');
}
