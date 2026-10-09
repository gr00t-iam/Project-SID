import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../agent-core/test-healthcare.mjs';

test('healthcare: triage, the medic\'s emergency interrupt, feeding the starving, infirmary beds and records (agent-core/test-healthcare.mjs)',async()=>{
  const r=await simulate();assert.deepEqual(r.failures,[]);
});
