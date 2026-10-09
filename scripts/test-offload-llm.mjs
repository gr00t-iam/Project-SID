// Diagnostic for the offload (secondary) model server, e.g. Gemma 4 12B in LM Studio at 10.0.0.45:1234.
//   npm run test:offload      (reads config/runtime.env)
// 1. Lists the models the server offers (and which are loaded) and shows the one the router picks.
// 2. Sends a utility task (parse a chat log to JSON) through the router and checks the answer.
// 3. Makes the offload server unreachable and checks the same task falls back to the primary model.
// Exit code 0 when all three pass.
import {LLMRouter,normalizeModel} from '../agent-core/lm.mjs';

const env=process.env,results=[];
const step=(name,ok,detail)=>{results.push({name,ok});console.log(`${ok===null?'SKIP':ok?'PASS':'FAIL'}  ${name}${detail?`\n      ${detail}`:''}`);};
const base=String(env.OFFLOAD_LLM_URL||'http://10.0.0.45:1234/v1').replace(/\/+$/,'').replace(/\/v1$/,'');
const headers=env.OFFLOAD_LLM_KEY?{Authorization:`Bearer ${env.OFFLOAD_LLM_KEY}`}:{};
const SAMPLE=['Hazel: The wheat on the east plot is ready. I will bake sixteen loaves tonight.','Bram: Good. Save four for the builders, the town hall walls go up tomorrow.',
  'Hazel: Deal. Can you ask Marlo for more seeds?','Bram: I will post a work order for 32 wheat seeds.'];
const PROMPT='Read the chat log and return ONLY JSON {"summary":"one sentence","topic_tags":["snake_case"],"agreements":["..."]}.';
const parse=text=>{const body=String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g,'').replace(/```(?:json)?/g,'');return JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));};

console.log(`Offload server: ${base}  (configured model: ${env.OFFLOAD_LLM_MODEL||'gemma-4-12B-it-qat-q4_0.gguf'})\n`);
// 1. Model list
try{
  const t0=Date.now(),r=await fetch(`${base}/v1/models`,{headers,signal:AbortSignal.timeout(5000)});
  const ids=((await r.json()).data??[]).map(m=>m.id);
  let loaded=null;
  try{const n=await fetch(`${base}/api/v0/models`,{headers,signal:AbortSignal.timeout(5000)});if(n.ok)loaded=((await n.json()).data??[]).filter(m=>m.state==='loaded').map(m=>`${m.id}${m.loaded_context_length?` (context ${m.loaded_context_length})`:''}`);}catch{}
  step('GET /v1/models',r.ok&&ids.length>0,`HTTP ${r.status} in ${Date.now()-t0} ms; listed: ${ids.join(', ')}${loaded?`\n      loaded: ${loaded.join(', ')}`:''}`);
}catch(error){step('GET /v1/models',false,error.cause?.code??error.message);}
const lm=new LLMRouter(env);
// Two checks each, so a server that is down is actually reported as offline.
for(let i=0;i<2;i++)await Promise.all([lm.primary.probe(),lm.offload.probe()]);
const st=lm.status();
step('router picks an offload model',st.offload.online,`picked "${st.offload.model}" for configured "${st.offload.configured}" (normalised: ${normalizeModel(st.offload.configured)})${st.offload.context?`, context ${st.offload.context}`:''}; Gemma chat format (no system turn): ${lm.offload.foldSystem?'yes':'no'}`);
console.log(`      primary: ${st.primary.online?'online':'offline'} (${st.primary.model})`);

// 2. Utility task through the router
try{
  const text=await lm.callUtilityTask('chat_log_json_parsing',PROMPT,{chat:SAMPLE});
  const r=lm.lastRoute,json=parse(text);
  const ok=typeof json.summary==='string'&&json.summary.length>8&&Array.isArray(json.topic_tags);
  step('call_utility_task: chat log -> JSON',ok&&r.endpoint==='offload',`served by ${r.endpoint} (${r.model}) in ${r.ms} ms at temperature ${0.2}\n      ${JSON.stringify(json).slice(0,300)}`);
}catch(error){step('call_utility_task: chat log -> JSON',false,error.message);}

// 3. Failover: the offload server unreachable (a closed port on the same host)
if(!lm.primary.online)step('failover: offload unreachable -> primary',null,'skipped: the primary server is offline too, so there is nothing to fail over to (start LM Studio on the main PC to test this)');
else try{
  const broken=new LLMRouter({...env,OFFLOAD_LLM_URL:base.replace(/:\d+$/,':1')+'/v1'});
  const warnings=[];broken.onFailover=w=>warnings.push(w);
  await broken.primary.probe();
  const t0=Date.now(),text=await broken.callUtilityTask('chat_log_json_parsing',PROMPT,{chat:SAMPLE});
  const r=broken.lastRoute,json=parse(text);
  step('failover: offload unreachable -> primary',r.endpoint==='primary'&&typeof json.summary==='string',
    `served by ${r.endpoint} (${r.model}) after ${Date.now()-t0} ms; failover warning: ${warnings.length?`${warnings[0].from} -> ${warnings[0].to} (${warnings[0].error})`:'none (offload already known down)'}\n      ${JSON.stringify(json).slice(0,200)}`);
}catch(error){step('failover: offload unreachable -> primary',false,error.message);}

const failed=results.filter(r=>r.ok===false).length,skipped=results.filter(r=>r.ok===null).length;
console.log(`\n${results.length-failed-skipped}/${results.length} checks passed${skipped?`, ${skipped} skipped`:''}`);
process.exit(failed?1:0);
