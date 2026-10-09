import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {LLMRouter,isOffline,ROUTES,normalizeModel,pickModel,TASK_SAMPLING,TASK_MAX_TOKENS,REASONING_ALLOWANCE,unwrapLine} from '../agent-core/lm.mjs';

// A fake LM Studio that streams its answers (server-sent events), split into small pieces.
function fakeServer(port,{models=['m'],reply='hello',hang=false,busyMs=0,native=null,listStatus=200,v1=null,cut=false}={}){
  const served=[],bodies=[],admin=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    if(req.url==='/v1/models'){res.statusCode=listStatus;return res.end(JSON.stringify({data:models.map(id=>({id}))}));}
    // LM Studio's native API: which models are loaded (only when the test provides it).
    if(req.url==='/api/v0/models'){if(!native){res.statusCode=404;return res.end('{}');}return res.end(JSON.stringify({data:native}));}
    // LM Studio's REST API: loaded instances with their load settings, and unload/load.
    if(req.url==='/api/v1/models'){if(!v1){res.statusCode=404;return res.end('{}');}return res.end(JSON.stringify({models:v1}));}
    if(req.url==='/api/v1/models/unload'||req.url==='/api/v1/models/load'){admin.push({url:req.url,body:JSON.parse(body)});
      return res.end(JSON.stringify(req.url.endsWith('load')&&!req.url.endsWith('unload')?{instance_id:'gemma-4-12b-it-qat',status:'loaded',load_time_seconds:1}:{instance_id:JSON.parse(body).instance_id}));}
    const parsed=JSON.parse(body);served.push(parsed.model);bodies.push(parsed);
    if(cut){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'{"reflection":"half'}}]})}

`);return setTimeout(()=>res.destroy(),50);}
    if(hang)return;   // accepts the request but never answers: a frozen or busy server
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
    if(busyMs)await new Promise(r=>setTimeout(r,busyMs));   // busy with other requests: headers now, tokens later
    const text=typeof reply==='function'?reply():reply;
    for(let i=0;i<text.length;i+=3)res.write(`data: ${JSON.stringify({choices:[{delta:{content:text.slice(i,i+3)}}]})}\n\n`);
    res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);res.end();
  });
  return new Promise(r=>server.listen(port,'127.0.0.1',()=>r(Object.assign(server,{served,bodies,admin}))));
}
const close=s=>new Promise(r=>{s.closeAllConnections?.();s.close(()=>r());});
const router=(p,o,extra={})=>new LLMRouter({PRIMARY_LLM_URL:`http://127.0.0.1:${p}`,PRIMARY_LLM_MODEL:'m',OFFLOAD_LLM_URL:`http://127.0.0.1:${o}/v1`,OFFLOAD_LLM_MODEL:'gemma-4-12B-it-qat-q4_0.gguf',
  LM_TIMEOUT_MS:'60000',PRIMARY_FIRST_BYTE_MS:'400',UTILITY_FIRST_BYTE_MS:'400',...extra});

test('primary tasks go to the primary; utility tasks go to the offload server',async()=>{
  const p=await fakeServer(19401,{reply:'from primary'}),o=await fakeServer(19402,{models:['gemma-4-12b-it-qat'],reply:'from offload'});
  const lm=router(19401,19402);await lm.init();
  assert.equal(await lm.callPrimaryTask('bot_planning','sys',{}),'from primary');
  assert.equal(await lm.callUtilityTask('diary_generation','sys',{}),'from offload');
  assert.equal(await lm.call('chat_log_json_parsing','sys',{}),'from offload');
  assert.equal(await lm.call('player_dialogue','sys',{}),'from primary');
  assert.equal(ROUTES.town_chronicle_summaries,'utility');assert.equal(ROUTES.emergency_survival_reasoning,'primary');
  await close(p);await close(o);
});
test('fails over both ways, with one warning per task kind',async()=>{
  const o=await fakeServer(19404,{models:['gemma-4-12b-it-qat'],reply:'from offload'});
  const lm=router(19403,19404);const warnings=[];lm.onFailover=w=>warnings.push(w);
  // Primary PC is off: planning is answered by the offload server.
  assert.equal(await lm.callPrimaryTask('bot_planning','sys',{}),'from offload');
  assert.equal(await lm.callPrimaryTask('bot_planning','sys',{}),'from offload');
  assert.equal(warnings.length,1);assert.deepEqual([warnings[0].from,warnings[0].to],['primary','offload']);
  await close(o);
  const p=await fakeServer(19405,{reply:'from primary'});
  const lm2=router(19405,19406);const w2=[];lm2.onFailover=w=>w2.push(w);
  // Offload server down: the diary is written by the primary.
  assert.equal(await lm2.callUtilityTask('diary_generation','sys',{}),'from primary');
  assert.deepEqual([w2[0].from,w2[0].to],['offload','primary']);
  await close(p);
});
test('a server that accepts but does not start answering in time is skipped',async()=>{
  const p=await fakeServer(19407,{hang:true}),o=await fakeServer(19408,{models:['gemma-4-12b-it-qat'],reply:'from offload'});
  const lm=router(19407,19408);
  const t0=Date.now();
  assert.equal(await lm.callPrimaryTask('player_dialogue','sys',{}),'from offload');
  assert.ok(Date.now()-t0<3000,`failed over quickly (${Date.now()-t0} ms)`);
  await close(p);await close(o);
});
test('a PC switched off mid-answer: the request is cut off and retried on the other server',async()=>{
  const p=await fakeServer(19409,{hang:true}),o=await fakeServer(19410,{models:['gemma-4-12b-it-qat'],reply:'from offload'});
  const lm=router(19409,19410,{PRIMARY_FIRST_BYTE_MS:'30000'});
  const pending=lm.callPrimaryTask('bot_planning','sys',{});
  setTimeout(()=>lm.primary.setOnline(false,'test'),300);
  assert.equal(await pending,'from offload');
  await close(p);await close(o);
});
test('offline only when neither server answers; back as soon as one does',async()=>{
  const lm=router(19411,19412);const changes=[];lm.onChange=o=>changes.push(o);
  for(let i=0;i<2;i++)await Promise.all([lm.primary.probe(),lm.offload.probe()]);
  assert.equal(lm.online,false);
  const t0=Date.now();
  await assert.rejects(lm.callUtilityTask('diary_generation','sys',{}),e=>isOffline(e));
  assert.ok(Date.now()-t0<200,'fails immediately');
  const o=await fakeServer(19412,{models:['gemma-4-12b-it-qat']});
  await lm.offload.probe();
  assert.equal(lm.online,true);assert.deepEqual(changes,[false,true]);
  assert.equal(await lm.callPrimaryTask('bot_planning','sys',{}),'hello','primary tasks use the offload server while the primary is off');
  await close(o);
});
test('the offload server uses whatever model is loaded there; the primary must run its own',async()=>{
  const p=await fakeServer(19413,{models:['other-model']}),o=await fakeServer(19414,{models:['text-embedding-x','google/gemma-4-12b-it-qat-q4_k_m']});
  const lm=router(19413,19414);
  await lm.offload.probe();assert.equal(lm.offload.model,'google/gemma-4-12b-it-qat-q4_k_m');
  await lm.primary.probe();await lm.primary.probe();assert.equal(lm.primary.online,false,'configured primary model not loaded');
  await lm.callUtilityTask('diary_generation','sys',{});assert.equal(o.served.at(-1),'google/gemma-4-12b-it-qat-q4_k_m');
  await close(p);await close(o);
});
test('plans stream in pieces and still parse',async()=>{
  const plan={reflection:'ok',plan:'wait here',action:{type:'wait',x:0,y:0,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{}}};
  const p=await fakeServer(19415,{reply:'<think>hmm</think>'+JSON.stringify(plan)});
  const lm=router(19415,19416);
  const got=await lm.plan({});
  assert.equal(got.action.type,'wait');assert.equal(p.served.length,1);
  await close(p);
});
test('a busy server that responds at once but starts generating late is waited for, not skipped',async()=>{
  const p=await fakeServer(19417,{reply:'from primary',busyMs:1200}),o=await fakeServer(19418,{models:['gemma-4-12b-it-qat'],reply:'from offload'});
  const lm=router(19417,19418);const warnings=[];lm.onFailover=w=>warnings.push(w);
  assert.equal(await lm.callPrimaryTask('bot_planning','sys',{}),'from primary');
  assert.equal(warnings.length,0);
  await close(p);await close(o);
});

test('Gemma model names: file names, aliases and instances all match the loaded model',()=>{
  assert.equal(normalizeModel('gemma-4-12B-it-qat-q4_0.gguf'),'gemma-4-12b-it-qat');
  assert.equal(normalizeModel('gemma-4-12b-it-qat:2'),'gemma-4-12b-it-qat');
  assert.equal(pickModel('gemma-4-12B-it-qat-q4_0.gguf',{loaded:['prism-ml/bonsai-27b','gemma-4-12b-it-qat:2'],listed:['gemma-4-12b-it-qat']}),'gemma-4-12b-it-qat:2','the loaded instance');
  assert.equal(pickModel('gemma-4-12b-it-qat',{loaded:['google/gemma-4-e4b','prism-ml/bonsai-27b']}),'google/gemma-4-e4b','same family');
  assert.equal(pickModel('gemma-4-12b',{loaded:['prism-ml/bonsai-27b']}),'prism-ml/bonsai-27b','any loaded model rather than forcing a load');
  assert.equal(pickModel('gemma-4-12b',{listed:['a','google/gemma-4-12b-it-qat']}),'google/gemma-4-12b-it-qat','short names do not match by accident');
});
test('offload server: loaded instance from the native API, Gemma chat format, per-task temperatures',async()=>{
  const o=await fakeServer(19419,{models:['gemma-4-12b-it-qat','gemma-4-12b-it-qat:2','prism-ml/bonsai-27b'],reply:'{"summary":"ok"}',
    native:[{id:'gemma-4-12b-it-qat:2',state:'loaded',type:'vlm',loaded_context_length:16384},{id:'gemma-4-12b-it-qat',state:'not-loaded',type:'vlm'},{id:'prism-ml/bonsai-27b',state:'loaded',type:'vlm'}]});
  const lm=router(19420,19419);const picked=[];lm.onModel=(ep,model)=>picked.push([ep,model]);
  await lm.offload.probe();
  assert.equal(lm.offload.model,'gemma-4-12b-it-qat:2');assert.deepEqual(picked,[['offload','gemma-4-12b-it-qat:2']]);
  assert.equal(lm.status().offload.context,16384);
  await lm.callUtilityTask('chat_log_json_parsing','Return JSON.',{chat:'hi'});
  await lm.callUtilityTask('diary_generation','Write a diary.',{day:1});
  const [json,diary]=o.bodies;
  assert.deepEqual(json.messages.map(m=>m.role),['user'],'no system turn for Gemma');
  assert.equal(json.messages[0].content,'Return JSON.\n\n{"chat":"hi"}','instructions first, then the input');
  assert.equal(json.temperature,0.2);assert.equal(diary.temperature,0.6);
  assert.equal(json.reasoning_effort,'none','Gemma does not think for utility work');
  assert.equal(lm.lastRoute.endpoint,'offload');
  assert.equal(TASK_SAMPLING.town_chronicle_summaries.temperature,0.6);
  await close(o);
});
test('offload server that will not list its models: the configured name is used as is',async()=>{
  const o=await fakeServer(19421,{listStatus:404,reply:'fine'});
  const lm=router(19422,19421);
  await lm.offload.probe();
  assert.equal(lm.offload.online,true);assert.equal(lm.offload.model,'gemma-4-12B-it-qat-q4_0.gguf');
  assert.equal(await lm.callUtilityTask('diary_generation','sys',{}),'fine');assert.equal(o.served.at(-1),'gemma-4-12B-it-qat-q4_0.gguf');
  await close(o);
});

test('an answer cut off mid-stream (model unloaded, PC switched off) is retried on the other server',async()=>{
  const p=await fakeServer(19423,{reply:'from primary'}),o=await fakeServer(19424,{models:['gemma-4-12b-it-qat'],cut:true});
  const lm=router(19423,19424);
  assert.equal(await lm.callUtilityTask('diary_generation','sys',{}),'from primary');
  assert.equal(lm.lastRoute.endpoint,'primary');
  await close(p);await close(o);
});
test('Gemma loaded with a slow speculative draft model is reloaded without it, once',async()=>{
  const inst={id:'gemma-4-12b-it-qat:2',config:{context_length:16384,flash_attention:true,offload_kv_cache_to_gpu:true,eval_batch_size:2048,speculative_draft_model:'google/gemma-4-e4b'}};
  const o=await fakeServer(19425,{models:['gemma-4-12b-it-qat:2'],native:[{id:'gemma-4-12b-it-qat:2',state:'loaded',type:'vlm'}],v1:[{key:'gemma-4-12b-it-qat',loaded_instances:[inst]}]});
  const lm=router(19426,19425);const events=[];lm.onDraft=(ep,what)=>events.push(what);
  await lm.offload.probe();
  assert.deepEqual(o.admin.map(a=>a.url),['/api/v1/models/unload','/api/v1/models/load']);
  assert.equal(o.admin[1].body.speculative_draft_model,null);assert.equal(o.admin[1].body.context_length,16384);
  assert.equal(lm.offload.model,'gemma-4-12b-it-qat');assert.deepEqual(events,['reloading','reloaded']);
  await lm.offload.probe();assert.equal(o.admin.length,2,'not again within 10 minutes');
  const off=router(19426,19425,{OFFLOAD_DISABLE_DRAFT:'false'});await off.offload.probe();assert.equal(o.admin.length,2,'can be turned off');
  await close(o);
});

test('the offload server runs as many requests at once as it has slots; the rest queue',async()=>{
  let active=0,peak=0;
  const server=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'gemma-4-12b-it-qat'}]}));
    if(req.url.startsWith('/api/'))return res.writeHead(404).end('{}');
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,150));active--;
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})}

data: [DONE]

`);});
  await new Promise(r=>server.listen(19427,'127.0.0.1',r));
  const lm=router(19428,19427,{OFFLOAD_PARALLEL:'2'});
  const out=await Promise.all([1,2,3,4,5].map(()=>lm.callUtilityTask('diary_generation','sys',{})));
  assert.deepEqual(out,['ok','ok','ok','ok','ok']);assert.equal(peak,2,'two at a time');
  await close(server);
});

test('teamwork: a busy primary hands the next plan to the idle offload server',async()=>{
  const plan=JSON.stringify({reflection:'ok',plan:'wait',action:{type:'wait',x:0,y:0,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{}}});
  const p=await fakeServer(19431,{reply:plan,busyMs:800}),o=await fakeServer(19432,{models:['gemma-4-12b-it-qat'],reply:plan});
  const lm=router(19431,19432);const notices=[];lm.onTeam=(what,info)=>notices.push([what,info.to]);
  assert.equal(lm.mode,'teamwork');
  const [a,b]=await Promise.all([lm.plan({}),new Promise(r=>setTimeout(r,50)).then(()=>lm.plan({}))]);
  assert.equal(a.action.type,'wait');assert.equal(b.action.type,'wait');
  assert.equal(p.served.length,1,'the primary kept the first plan');assert.equal(o.served.length,1,'the second went to the idle offload server');
  assert.equal(lm.teamStatus().spillovers,1);assert.deepEqual(notices,[['spillover','offload']]);
  await close(p);await close(o);
});
test('teamwork: a broken plan from one model is repaired by the other',async()=>{
  const good=JSON.stringify({reflection:'ok',plan:'wait',action:{type:'wait',x:0,y:0,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{}}});
  const p=await fakeServer(19433,{reply:'I think I will wait here for a while.'}),o=await fakeServer(19434,{models:['gemma-4-12b-it-qat'],reply:good});
  const lm=router(19433,19434);
  assert.equal((await lm.plan({})).action.type,'wait');
  assert.equal(lm.teamStatus().repairs,1);assert.equal(o.served.length,1,'the offload server did the repair');
  assert.ok(o.bodies[0].messages.some(m=>/not valid JSON/.test(m.content)),'asked to repair');
  await close(p);await close(o);
});
test('teamwork: propose and review with both online; alone without a reviewer',async()=>{
  const p=await fakeServer(19435,{reply:'{"milestones":[]}'}),o=await fakeServer(19436,{models:['gemma-4-12b-it-qat'],reply:'{"approve":true}'});
  const lm=router(19435,19436);
  const r=await lm.proposeAndReview('macro_planning','plan it',{objective:'x'},'review it');
  assert.deepEqual([r.by,r.reviewer,r.review],['primary','offload','{"approve":true}']);assert.equal(lm.teamStatus().reviews,1);
  await close(o);for(let i=0;i<2;i++)await lm.offload.probe();
  assert.equal(lm.mode,'solo:primary');
  assert.equal((await lm.proposeAndReview('macro_planning','plan it',{objective:'x'},'review it')).review,null);
  await close(p);for(let i=0;i<2;i++)await lm.primary.probe();assert.equal(lm.mode,'offline');
});
test('teamwork: a sub-task failing again is escalated to the deeper model',async()=>{
  const {createReflector}=await import('../agent-core/intel/reflect.mjs');const {openDatabase}=await import('../agent-core/intel/db.mjs');
  const reply='{"reflection":"try elsewhere","strategy":"skip"}';
  const p=await fakeServer(19437,{reply}),o=await fakeServer(19438,{models:['gemma-4-12b-it-qat'],reply});
  const lm=router(19437,19438),ref=createReflector(openDatabase(':memory:'),{lm});
  const a={type:'withdraw',target:'BREAD'};
  assert.equal((await ref.reflect({agent:'x',subject:'s',action:a,error:'That chest has no BREAD'})).source,'llm');
  assert.equal((await ref.reflect({agent:'x',subject:'s',action:a,error:'That chest has no BREAD'})).source,'llm-deep');
  assert.deepEqual([o.served.length,p.served.length],[1,1],'first the offload model, then the primary');
  assert.equal(lm.teamStatus().escalations,1);
  await close(p);await close(o);
});
test('answer budgets: each task is capped, with room to think on a reasoning model; slots set the capacity',async()=>{
  const p=await fakeServer(19439),o=await fakeServer(19440,{models:['gemma-4-12b-it-qat']});
  const lm=router(19439,19440,{PRIMARY_PARALLEL:'4',OFFLOAD_PARALLEL:'2',LM_MAX_TOKENS:'6000'});
  await lm.init();
  assert.equal(lm.capacity,6);
  await lm.callPrimaryTask('player_dialogue','hi',{});
  await lm.callUtilityTask('chat_log_json_parsing','parse',{});
  assert.equal(p.bodies.at(-1).max_tokens,TASK_MAX_TOKENS.player_dialogue+REASONING_ALLOWANCE,'Muse reasons: allowance added');
  assert.equal(o.bodies.at(-1).max_tokens,TASK_MAX_TOKENS.chat_log_json_parsing,'Gemma runs without reasoning: the bare budget');
  await lm.callPrimaryTask('some_new_kind','x',{});
  assert.equal(p.bodies.at(-1).max_tokens,6000,'unknown tasks keep the global ceiling');
  await close(o);for(let i=0;i<2;i++)await lm.offload.probe();
  assert.equal(lm.capacity,4,'only the online server counts');
  await close(p);
});
test('an offload model that came back with too little context is reloaded with OFFLOAD_MIN_CONTEXT',async()=>{
  const inst={id:'gemma-4-12b-it-qat',config:{context_length:16384,flash_attention:true,offload_kv_cache_to_gpu:true,eval_batch_size:2048,parallel:2,speculative_draft_model:''}};
  const o=await fakeServer(19441,{models:['gemma-4-12b-it-qat'],native:[{id:'gemma-4-12b-it-qat',state:'loaded',type:'vlm'}],v1:[{key:'gemma-4-12b-it-qat',loaded_instances:[inst]}]});
  const lm=router(19442,19441,{OFFLOAD_MIN_CONTEXT:'32768',OFFLOAD_PARALLEL:'2'});
  await lm.offload.probe();
  assert.deepEqual(o.admin.map(a=>a.url),['/api/v1/models/unload','/api/v1/models/load']);
  assert.equal(o.admin[1].body.context_length,32768);assert.equal(o.admin[1].body.parallel,2);
  const fine=router(19442,19441);await fine.offload.probe();assert.equal(o.admin.length,2,'enough context: left alone');
  await close(o);
});
test('chat lines wrapped in JSON or quotes are unwrapped to the words',()=>{
  assert.equal(unwrapLine('{   "message": "I have bread, Dorn."}'),'I have bread, Dorn.');
  assert.equal(unwrapLine('"Hello there!"'),'Hello there!');
  assert.equal(unwrapLine('{"message": "cut off'),'cut off');
  assert.equal(unwrapLine('plain words'),'plain words');
});

test('balanced load: planning is shared by throughput, a full model hands over, pinned kinds stay put',async()=>{
  const {balancePick,BALANCED}=await import('../agent-core/lm.mjs');
  assert.ok(BALANCED.has('bot_planning')&&!BALANCED.has('player_dialogue'));
  // Muse: 4 slots at 38 s a plan; Gemma: 4 slots at 16 s -> Gemma's fair share is about 70%.
  const muse={name:'primary',slots:4,busy:0,lat:{plan:38000}},gemma={name:'offload',slots:4,busy:0,lat:{plan:16000}};
  const recent=[];for(let i=0;i<100;i++){const e=balancePick('plan',muse,gemma,recent.slice(-40));recent.push(e.name);}
  const share=recent.slice(-40).filter(x=>x==='offload').length/40;
  assert.ok(share>0.6&&share<0.8,`Gemma takes ~70% of the plans (${share})`);
  assert.ok(recent.includes('primary'),'Muse still gets its share');
  // A full model never takes the next one while the other has a free slot.
  assert.equal(balancePick('plan',muse,{...gemma,busy:4},['primary']).name,'primary');
  assert.equal(balancePick('plan',{...muse,busy:4},gemma,['offload','offload','offload']).name,'offload');
  // Through the router: with no history the first plan goes to the preferred model, the next ones are shared.
  const plan=JSON.stringify({reflection:'ok',plan:'wait',action:{type:'wait',x:0,y:0,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{}}});
  const p=await fakeServer(19461,{reply:plan}),o=await fakeServer(19462,{models:['gemma-4-12b-it-qat'],reply:plan});
  const lm=router(19461,19462);
  for(let i=0;i<8;i++)await lm.plan({});
  assert.ok(o.served.length>=4&&p.served.length>=1,`both models plan (Muse ${p.served.length}, Gemma ${o.served.length})`);
  assert.ok(lm.teamStatus().offloadSharePct.plan.offload>=50);
  await lm.callPrimaryTask('player_dialogue','hi',{});assert.equal(lm.lastRoute.endpoint,'primary','player replies stay on Muse while it is free');
  await close(p);await close(o);
});
