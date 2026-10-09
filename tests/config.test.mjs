import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadAgents,loadOptionalJson,checkAgents,checkEnv,ConfigError,parseJson} from '../agent-core/config.mjs';
import {LLMError,isOffline} from '../agent-core/lm.mjs';

test('agents file: clear diagnostics for missing, malformed and invalid configurations',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'sid-cfg-'));
  await assert.rejects(loadAgents(path.join(dir,'none.json')),e=>e instanceof ConfigError&&/does not exist/.test(e.message)&&/AGENTS_FILE/.test(e.hint));
  await writeFile(path.join(dir,'bad.json'),'[\n  {"id":"a",}\n]');
  await assert.rejects(loadAgents(path.join(dir,'bad.json')),e=>/not valid JSON at line 2/.test(e.message));
  assert.throws(()=>checkAgents([{id:'a'},{id:'a'}]),/used twice/);
  assert.throws(()=>checkAgents([{id:'no spaces'}]),/id must be/);
  assert.throws(()=>checkAgents({}),/JSON array/);
  await writeFile(path.join(dir,'ok.json'),JSON.stringify([{id:'builder',goal:'build',personality:'kind'},{id:'scout'}]));
  const r=await loadAgents(path.join(dir,'ok.json'));assert.equal(r.configs.length,2);assert.deepEqual(r.warnings,['agents.json entry 2 ("scout") has no goal','agents.json entry 2 ("scout") has no personality'].map(w=>w.replace('agents.json',path.join(dir,'ok.json'))));
  assert.deepEqual((await loadOptionalJson(path.join(dir,'missing.json'),{homes:{}})),{value:{homes:{}},warning:null});
  assert.match((await loadOptionalJson(path.join(dir,'bad.json'),{})).warning,/using defaults/);
  assert.equal(parseJson('{"a":1}','x.json').a,1);
});
test('environment: required keys, numeric settings and recommendations',()=>{
  const bad=checkEnv({BRIDGE_TOKEN:'REPLACE_ME',LOOP_MS:'fast'});
  assert.ok(bad.errors.some(e=>/BRIDGE_URL is not set/.test(e))&&bad.errors.some(e=>/BRIDGE_TOKEN/.test(e))&&bad.errors.some(e=>/LOOP_MS must be a number/.test(e)));
  const good=checkEnv({BRIDGE_URL:'ws://10.0.0.58:3001',BRIDGE_TOKEN:'x'.repeat(64),PRIMARY_LLM_URL:'http://10.0.0.162:1234',STATE_DIR:'/var/lib/sid-local'});
  assert.deepEqual(good.errors,[]);assert.ok(good.warnings.some(w=>/DASHBOARD_TOKEN/.test(w)));
});
test('model errors are typed and keep the legacy flags',()=>{
  const e=new LLMError('down',{code:'OFFLINE',offline:true});
  assert.equal(e.code,'OFFLINE');assert.ok(e instanceof Error);assert.equal(isOffline(e),true);
  const h=new LLMError('bad',{code:'HTTP',status:503,retryable:true});assert.deepEqual([h.status,h.retryable,h.offline],[503,true,undefined]);
});
