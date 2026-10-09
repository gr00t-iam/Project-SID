import test from 'node:test';
import assert from 'node:assert/strict';
import {createBank,emptyBank} from '../agent-core/skills/banking.mjs';
import {createEconomy} from '../agent-core/skills/economy.mjs';
import {createFunding} from '../agent-core/skills/funding.mjs';
function fixture(){
 const state=emptyBank();state.accounts.mayor={balance:20,transaction_history:[]};state.municipal_vault.total_tax_reserves=10;
 let vault=30,treasury=100,calls=0,fail=false;const bank=createBank(state);
 const funding=createFunding({bank,save:async()=>{},physical:async({op,count})=>{
  if(op==='count')return {vault,treasury};calls++;
  if(fail)throw Error('vault full');
  if(op==='grant')vault+=count;
  if(op==='from_treasury'){treasury-=count;vault+=count;}
  if(op==='to_treasury'){treasury+=count;vault-=count;}
  return {vault,treasury};
 }});
 return {state,funding,get:()=>({vault,treasury,calls}),extra:n=>vault+=n,fail:()=>fail=true};
}
test('Mayor grant is backed, audited, and duplicate clicks never add money twice',async()=>{
 const f=fixture(),r=await f.funding.run({source:'grant',amount:100,actor:'mayor',opId:'g1'});
 assert.equal(r.audit.diff,0);assert.equal(f.get().vault,130);assert.equal(f.state.municipal_vault.total_tax_reserves,110);
 await f.funding.run({source:'grant',amount:100,actor:'mayor',opId:'g1'});assert.equal(f.get().vault,130);
 await assert.rejects(f.funding.run({source:'grant',amount:1,actor:'mayor',opId:'g1'}),/different/);
});
test('existing warehouse coins and personal donations are conserved',async()=>{
 const f=fixture();await f.funding.run({source:'warehouse',amount:70,actor:'mayor',opId:'w'});
 assert.deepEqual([f.get().vault,f.get().treasury],[100,30]);
 await f.funding.run({source:'donate',amount:15,actor:'mayor',opId:'d'});
 assert.equal(f.state.accounts.mayor.balance,5);assert.equal(f.get().vault,100);
 await f.funding.run({source:'treasury',amount:20,actor:'mayor',opId:'t'});
 assert.deepEqual([f.get().vault,f.get().treasury],[80,50]);
 await assert.rejects(f.funding.run({source:'warehouse',amount:51,actor:'mayor',opId:'no'}),/only/);
});
test('reconciliation credits only a freshly verified surplus and prevents taking account backing',async()=>{
 const f=fixture();f.extra(512);
 await assert.rejects(f.funding.run({source:'reconcile',amount:513,actor:'mayor',opId:'bad'}),/surplus/);
 const r=await f.funding.run({source:'reconcile',amount:512,actor:'mayor',opId:'r'});
 assert.equal(r.audit.diff,0);assert.equal(f.get().vault,542);assert.equal(f.get().calls,0);
});
test('failed physical grants never credit reserves; invalid amounts never move coins',async()=>{
 const f=fixture();f.fail();await assert.rejects(f.funding.run({source:'grant',amount:2,actor:'mayor',opId:'bad'}),/vault full/);
 assert.equal(f.state.municipal_vault.total_tax_reserves,10);
 for(const amount of [0,-1,1.5,5000])await assert.rejects(f.funding.run({source:'grant',amount,actor:'mayor',opId:'bad'+amount}));
});

test('lost acknowledgement is settled only by exact coin counts and concurrent clicks serialize',async()=>{
 const state=emptyBank(),bank=createBank(state);let vault=0,moves=0;
 const funding=createFunding({bank,save:async()=>{},physical:async({op,count})=>{if(op==='count')return {vault,treasury:0};vault+=count;moves++;throw Error('lost acknowledgement');}});
 const request={source:'grant',amount:100,actor:'mayor',opId:'lost'};
 const results=await Promise.all([funding.run(request),funding.run(request)]);
 assert.equal(vault,100);assert.equal(moves,2);assert.equal(state.municipal_vault.total_tax_reserves,100);assert.equal(results[1].repeated,true);assert.equal(state.lastAudit.diff,0);
});
test('restart blocks uncertain moves and never replays them',async()=>{
 const state=emptyBank();state.fundingOps=[{id:'crash',source:'grant',actor:'mayor',amount:64,credited:0,status:'moving'}];let moves=0;
 const funding=createFunding({bank:createBank(state),save:async()=>{},physical:async()=>{moves++;return {vault:64,treasury:0};}});
 assert.equal((await funding.run({source:'grant',actor:'mayor',amount:64,opId:'crash'})).status,'review');
 await assert.rejects(funding.run({source:'grant',actor:'mayor',amount:1,opId:'new'}),/pending/);assert.equal(moves,0);
});
test('partial funding failure credits only proved successful chunks',async()=>{
 const state=emptyBank();let vault=0,moves=0;
 const funding=createFunding({bank:createBank(state),save:async()=>{},physical:async({op,count})=>{if(op==='count')return {vault,treasury:0};if(++moves===2)throw Error('full');vault+=count;}});
 const r=await funding.run({source:'grant',actor:'mayor',amount:100,opId:'partial'});
 assert.equal(r.status,'failed');assert.equal(r.amount,64);assert.equal(state.municipal_vault.total_tax_reserves,64);assert.equal(r.audit.diff,0);
});

test('funded reserves pay earned wages and taxes without minting more coins',async()=>{
 const f=fixture();await f.funding.run({source:'grant',amount:100,actor:'mayor',opId:'pay-fund'});
 const bank=createBank(f.state),labor={pending:{builder:20},backlogFixedV1:true};
 const economy=createEconomy({bank,state:labor});const r=await economy.payroll({mint:async()=>{throw Error('No extra mint expected');}});
 assert.equal(r.total,20);assert.equal(r.minted,0);assert.equal(bank.balance('builder').balance,18);assert.equal(f.state.municipal_vault.total_tax_reserves,92);assert.equal(bank.audit(f.get().vault).diff,0);assert.equal(economy.view().owed.builder,undefined);
});

