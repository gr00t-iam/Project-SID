// Latency and throughput benchmark for the LM Studio servers (the RTX 4090 PC running Muse Glimmer by default).
//   npm run bench                      primary (Muse Glimmer on the 4090 PC)
//   npm run bench -- --endpoint offload   the offload server (Gemma)
//   npm run bench -- --workers 5 --tokens 200
// 1. N concurrent "worker" requests: time to first token (TTFT), generation speed (tokens/s) and round trip for each,
//    plus the total throughput.
// 2. Prompt-cache check: two requests sharing a long static prefix; the second should start much faster.
// 3. Fallback: the other server unreachable -> requests still answered (offload down -> Muse Glimmer; primary down -> Gemma).
import {LLMRouter,normalizeModel} from '../agent-core/lm.mjs';

const args=Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(a=>{const [k,...v]=a.trim().split(/\s+/);return [k,v.join(' ')||true];}));
const env=process.env,which=args.endpoint==='offload'?'offload':'primary',workers=Number(args.workers||5),tokens=Number(args.tokens||200);
const lm=new LLMRouter(env);
for(let i=0;i<2;i++)await Promise.all([lm.primary.probe(),lm.offload.probe()]);
const ep=lm[which];
const pct=(xs,p)=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
const sec=ms=>(ms/1000).toFixed(2)+' s';
console.log(`Benchmark: ${which} ${ep.base} model ${ep.model} (${ep.online?'online':'OFFLINE'}); reasoning effort sent: ${ep.effort||'none'}; slots in router: ${ep.slots??1}\n`);
if(!ep.online){console.log('The server is offline: skipping the speed tests.\n');}

/** One streamed request: TTFT (first visible or reasoning token), generation speed, round trip. */
async function timed(messages,max){
  const body={model:ep.model,messages,max_tokens:max,temperature:0.6,stream:true,stream_options:{include_usage:true}};
  if(ep.effort)body.reasoning_effort=ep.effort;
  const t0=performance.now();let first=null,last=null,pieces=0,usage=null,buf='';
  const r=await fetch(`${ep.base}/v1/chat/completions`,{method:'POST',headers:ep.headers(),body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  const dec=new TextDecoder();
  for await(const chunk of r.body){
    buf+=dec.decode(chunk,{stream:true});let i;
    while((i=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(!line.startsWith('data:')||line.includes('[DONE]'))continue;
      const j=JSON.parse(line.slice(5));if(j.usage)usage=j.usage;
      const d=j.choices?.[0]?.delta;if(d&&(d.content||d.reasoning_content)){pieces++;first??=performance.now();last=performance.now();}
    }
  }
  const out=usage?.completion_tokens??pieces,gen=last&&first&&last>first?(out-1)/((last-first)/1000):null;
  return {ttft:first-t0,total:performance.now()-t0,tokens:out,prompt:usage?.prompt_tokens,tps:gen};
}

if(ep.online){
  // 1. Concurrent workers
  const prompt=i=>[{role:'user',content:`You are villager #${i} in a Minecraft town. In about ${Math.round(tokens*0.6)} words, describe your plan for today and why.`}];
  const t0=performance.now();
  const runs=await Promise.all(Array.from({length:workers},(_,i)=>timed(prompt(i),tokens).catch(e=>({error:e.message}))));
  const wall=performance.now()-t0,ok=runs.filter(r=>!r.error);
  console.log(`1. ${workers} concurrent worker requests (${tokens} max tokens each)`);
  runs.forEach((r,i)=>console.log(r.error?`   worker ${i+1}: FAILED ${r.error}`:`   worker ${i+1}: TTFT ${sec(r.ttft)}  ${r.tokens} tokens at ${r.tps?.toFixed(1)??'?'} tok/s  round trip ${sec(r.total)}`));
  if(ok.length){
    const total=ok.reduce((s,r)=>s+r.tokens,0);
    console.log(`   TTFT median ${sec(pct(ok.map(r=>r.ttft),0.5))}, worst ${sec(Math.max(...ok.map(r=>r.ttft)))} | per-request speed median ${pct(ok.map(r=>r.tps??0),0.5).toFixed(1)} tok/s | round trip median ${sec(pct(ok.map(r=>r.total),0.5))}`);
    console.log(`   throughput: ${total} tokens in ${sec(wall)} = ${(total/(wall/1000)).toFixed(1)} tok/s across all workers\n`);
  }
  // 2. Prompt cache: same long static prefix, different tail
  const prefix='You are the planner for a Minecraft settlement. Rules and reference material follow.\n'+Array.from({length:120},(_,i)=>`Rule ${i+1}: villagers keep the town tidy, share food, respect zones and help each other with materials number ${i}.`).join('\n');
  const a=await timed([{role:'user',content:`${prefix}\n\nState: Hazel is hungry at the farm. Reply with one short sentence.`}],40);
  const b=await timed([{role:'user',content:`${prefix}\n\nState: Bram needs 32 planks at the warehouse. Reply with one short sentence.`}],40);
  console.log(`2. Prompt cache (shared ${a.prompt} token prefix): first request TTFT ${sec(a.ttft)}, second ${sec(b.ttft)} -> ${b.ttft<a.ttft*0.6?'the prefix was reused':'little or no reuse'}\n`);
}

// 3. Fallback: make one server unreachable (closed port on its host) and check the other answers.
async function fallback(down){
  const up=down==='offload'?'primary':'offload';
  const broken={...env};
  if(down==='offload')broken.OFFLOAD_LLM_URL=lm.offload.base.replace(/:\d+$/,':1')+'/v1';
  else{broken.PRIMARY_LLM_URL=lm.primary.base.replace(/:\d+$/,':1');broken.LM_BASE_URL=broken.PRIMARY_LLM_URL;}
  const r=new LLMRouter(broken);const warnings=[];r.onFailover=w=>warnings.push(w);
  await r[up].probe();
  if(!r[up].online)return console.log(`   ${down} down -> ${up}: SKIPPED (${up} is offline too)`);
  const t0=performance.now();
  try{
    const text=down==='offload'?await r.callUtilityTask('chat_log_json_parsing','Return ONLY JSON {"summary":"one sentence"}.',{chat:['Hazel: bread tonight','Bram: planks tomorrow']})
      :await r.callPrimaryTask('player_dialogue','Reply in one short friendly sentence.',{message:'Hello!'});
    console.log(`   ${down} down -> ${r.lastRoute.endpoint} (${r.lastRoute.model}) answered in ${sec(performance.now()-t0)}${warnings.length?` [failover logged: ${warnings[0].from} -> ${warnings[0].to}]`:''}: ${String(text).slice(0,80)}`);
    return r.lastRoute.endpoint===up;
  }catch(e){console.log(`   ${down} down -> FAILED: ${e.message}`);return false;}
}
console.log('3. Fallback');
const f1=await fallback('offload'),f2=await fallback('primary');
console.log(`\nprimary ${normalizeModel(lm.primary.model)} ${lm.primary.online?'online':'offline'} | offload ${normalizeModel(lm.offload.model)} ${lm.offload.online?'online':'offline'} | fallback ${[f1,f2].filter(x=>x===true).length}/2 verified`);
