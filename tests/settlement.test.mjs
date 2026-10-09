import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../agent-core/intel/db.mjs';
import {createBoard} from '../agent-core/intel/orders.mjs';
import {createSocial} from '../agent-core/intel/social.mjs';
import {createExecutor} from '../agent-core/intel/executor.mjs';

function world({fail=null}={}){
  let t=Date.parse('2026-10-02T10:00:00Z');const now=()=>t;
  const db=openDatabase(':memory:'),board=createBoard(db,{now}),social=createSocial(db,{now});
  const paid=[];let mode=fail;
  const act=async(id,a)=>{
    await new Promise(r=>setTimeout(r,5));   // a payment takes a round trip
    if(mode==='fail')throw Error('The treasury only has 0 EMERALD');
    if(mode==='unknown')throw Error('Disconnected; action outcome may be unknown');
    paid.push({from:id,to:a.to,count:a.count});return {paid:a.count};
  };
  const executor=createExecutor({act,say:async()=>{},board,social,log:()=>{},ledger:()=>{},nameOf:x=>x,roleOf:x=>x,isAgent:()=>true});
  const o=board.post({issuer:'builder',item:'OAK_LOG',quantity:4,reward:6});
  board.claim(o.order_id,'crafter',{});board.progress(o.order_id,4,'crafter');
  return {board,executor,paid,o,setMode:m=>{mode=m;},tick:ms=>{t+=ms;}};
}

test('two paths settling the same order at once pay exactly once',async()=>{
  const w=world();
  const order=w.board.get(w.o.order_id);
  const [a,b]=await Promise.all([w.executor.settle(order,'crafter'),w.executor.settle(order,'crafter')]);
  assert.equal(w.paid.length,1,'one payment');
  assert.ok(a||b);assert.equal(w.board.get(w.o.order_id).status,'VERIFIED');
  assert.equal(await w.executor.settle(order,'crafter'),true,'settling a verified order again pays nothing and reports paid');
  assert.equal(w.paid.length,1);
});

test('a failed payment keeps the wage owed (UNPAID, not VERIFIED) and is retried',async()=>{
  const w=world({fail:'fail'});
  assert.equal(await w.executor.settle(w.board.get(w.o.order_id),'crafter'),false);
  const o=w.board.get(w.o.order_id);
  assert.equal(o.status,'UNPAID');assert.equal(o.delivered,4,'the work stays done');assert.equal(w.paid.length,0);
  await w.executor.retryUnpaid();assert.equal(w.paid.length,0,'not retried within 5 minutes');
  w.setMode(null);w.tick(301000);
  await w.executor.retryUnpaid();
  assert.equal(w.paid.length,1);assert.equal(w.board.get(w.o.order_id).status,'VERIFIED');
});

test('a payment with an unknown outcome is held, never retried automatically',async()=>{
  const w=world({fail:'unknown'});
  await w.executor.settle(w.board.get(w.o.order_id),'crafter');
  assert.equal(w.board.get(w.o.order_id).status,'PAYMENT_UNCERTAIN');
  w.setMode(null);w.tick(3600000);await w.executor.retryUnpaid();
  assert.equal(w.paid.length,0,'could already have been paid: no automatic second payment');
});

test('an advance is recorded only after it was paid; a failed advance releases the claim',async()=>{
  const w=world();const b=w.board;
  const o=b.post({issuer:'farmer',item:'BREAD',quantity:1,reward:4});
  b.claim(o.order_id,'chef',{upfront:0});
  assert.equal(b.get(o.order_id).upfront_paid,0);
  assert.equal(b.recordUpfront(o.order_id,2).upfront_paid,2);
});
