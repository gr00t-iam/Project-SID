import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate as courtSim} from '../agent-core/test-court.mjs';
import {simulate as jurySim} from '../agent-core/test-jury.mjs';

test('the courthouse and Judge Thaddeus: a contract case from filing to adjournment (agent-core/test-court.mjs)',async()=>{
  const r=await courtSim();assert.deepEqual(r.failures,[]);
});
test('the jury: escalation, impartial selection, an alternate, deliberation by traits and a two-thirds verdict (agent-core/test-jury.mjs)',async()=>{
  const r=await jurySim();assert.deepEqual(r.failures,[]);
});
