import test from 'node:test';
import assert from 'node:assert/strict';
import {requestDelivery,nextDelivery,recordDelivery} from '../agent-core/deliveries.mjs';
test('runner requests deduplicate retries and retain only undelivered goods',()=>{
 const q=[];requestDelivery(q,'chef','BREAD',8,100);requestDelivery(q,'chef','BREAD',8,101);
 assert.equal(q.length,1);
 assert.equal(nextDelivery(q,{BREAD:3}).to,'chef');
 recordDelivery(q,q[0].id,{BREAD:3});assert.equal(q[0].count,5);
 assert.equal(nextDelivery(q,{}),null);
 recordDelivery(q,q[0].id,{BREAD:5});assert.equal(q.length,0);
});
