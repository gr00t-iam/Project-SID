import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../agent-core/test-banking-economy.mjs';
import {createBank,emptyBank,taxOn} from '../agent-core/skills/banking.mjs';
import {laborValue,AWARD_ACTIVITY} from '../agent-core/skills/economy.mjs';
import {blueprint} from '../agent-core/blueprints.mjs';
import {assertAction} from '../agent-core/actions.mjs';

test('bank and labour economy end to end (agent-core/test-banking-economy.mjs)',async()=>{
  const r=await simulate();
  assert.deepEqual(r.failures,[]);
});

test('ledger schema and tax maths',async()=>{
  const state=emptyBank(),bank=createBank(state,{now:()=>Date.parse('2026-10-01T00:00:00Z')});
  assert.deepEqual(Object.keys(state.municipal_vault).sort(),['total_tax_reserves','treasury_balance']);
  assert.equal(state.tax_config.income_tax_rate,0.10);assert.ok(state.tax_config.tax_collection_interval_ticks>0);
  for(const k of ['FARMING','MINING','CRAFTING','PATROL','BUILDING'])assert.ok(state.wage_rates[k]>0);
  assert.equal(taxOn(9,0.1),0);assert.equal(taxOn(10,0.1),1);assert.equal(taxOn(25,0.1),2);
  const r=await bank.payWage('a',20,{memo:'test'});
  assert.deepEqual([r.gross,r.tax,r.net],[20,2,18]);
  const t=state.accounts.a.transaction_history;
  assert.equal(t[0].type,'TAX');assert.equal(t[1].type,'WAGE');assert.match(t[1].timestamp,/^2026-10-01T00:00:00\.000Z$/);assert.match(t[1].id,/^T-\d{6}$/);
  assert.equal(state.municipal_vault.total_tax_reserves,2);
  await assert.rejects(bank.deposit('a',0),/whole number/);await assert.rejects(bank.deposit('a',65),/1 to 64/);await assert.rejects(bank.withdraw('a',1.5,{requester:'a'}),/whole number/);
  assert.equal(laborValue('BUILDING',100,{rates:state.wage_rates,level:3}),100*state.wage_rates.BUILDING*1.2);
  assert.equal(AWARD_ACTIVITY.place,'BUILDING');
});

test('the bank blueprint keeps its vault chests inside the vault box, behind grates',()=>{
  const b=blueprint({shape:'bank'},100,64,200),at=(x,y,z)=>b.find(q=>q.x===x&&q.y===y&&q.z===z)?.block;
  const chests=b.filter(q=>q.block==='CHEST');assert.equal(chests.length,4);
  for(const c of chests){assert.equal(c.y,65);assert.ok(c.x>=101&&c.x<=107&&c.z>=201&&c.z<=202);}   // civic.bankVault(): x+1, y+1, z+1, 7 x 1 x 2
  for(let x=101;x<=107;x++)assert.equal(at(x,65,203),'COBBLESTONE_WALL');                               // the grates
  assert.equal(b.filter(q=>q.block==='BARREL').length,4);assert.equal(at(104,65,206),undefined);        // counter; door
});

test('the bank actions are part of the schema',()=>{
  const self={id:'a',x:0,y:64,z:0,entities:[]},base={x:0,y:64,z:0,target:'',text:'',to:'',blocks:[],count:5,spec:{}};
  for(const type of ['deposit_emeralds','withdraw_emeralds','get_balance'])assert.ok(assertAction({...base,type},self,['a']));
});

test('players are paid untaxed into an account and cash out at the counter; a failed hand-over changes nothing',async()=>{
  const state=emptyBank();let vault=0;const inv={banker:0};
  const physical=async({op,agent,count})=>{if(op==='count')return {vault};if(op==='mint'){vault+=count;return {};}
    if(op==='withdraw'){if(vault<count)throw Error('short');vault-=count;inv[agent]+=count;return {};}
    if(op==='deposit'){inv[agent]-=count;vault+=count;return {};}return {};};
  const bank=createBank(state,{physical,retryMs:1});
  await bank.mint(16);await bank.payWage('jrmym1981',16,{memo:'order #409',taxFree:true});
  assert.equal(bank.balance('jrmym1981').balance,16);assert.equal(state.municipal_vault.total_tax_reserves,0,'no tax taken from a player');
  await assert.rejects(bank.cashOut('jrmym1981',10,{agent:'banker',handOver:async()=>{throw Error('too far');}}),/within 4 blocks/);
  assert.equal(bank.balance('jrmym1981').balance,16);assert.equal(vault,16,'the coins went back into the vault');
  const handed=[];await bank.cashOut('jrmym1981',10,{agent:'banker',handOver:async n=>{handed.push(n);}});
  assert.deepEqual(handed,[10]);assert.equal(bank.balance('jrmym1981').balance,6);assert.equal(vault,6);
  assert.equal(vault,bank.liabilities(),'books and vault agree');
});
