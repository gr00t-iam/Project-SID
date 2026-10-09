import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT,createPercy} from '../agent-core/roles/percy.mjs';
import {newConflict,sentenceFor} from '../agent-core/skills/justice.mjs';

function fixture(){
 let time=100000,jailed=false,witness=true,cases=[],said=[],moves=[],position={id:'percy',x:323,z:119,y:65};
 const memory={data:{agents:{percy:{}}},save:async()=>{}};
 const snapshot=()=>({agents:[position,...(witness?[{id:'clerk',x:324,z:119,y:65}]:[])]});
 const justice={restricted:()=>jailed,state:{conflicts:cases},complain:(by,against,text,{kind})=>{const c=newConflict({n:cases.length+1,party_a:by,party_b:against,reason:text,kind,time});cases.push(c);return c;}};
 const role=createPercy({memory,configs:[AGENT,{id:'clerk',role:'clerk'}],justice:()=>justice,getSnapshot:snapshot,tavernSpot:()=>({x:323,z:119,y:65}),jailSite:()=>({layoutVersion:2}),say:async(id,text)=>said.push(text),travel:async(id,self,to)=>moves.push(to),log:()=>{},now:()=>time,random:()=>0});
 return {role,memory,cases,said,moves,setPosition:p=>Object.assign(position,p),step:async()=>{const job=role.job(AGENT,memory.data.agents.percy,snapshot().agents[0],false);if(job)await job();},advance:n=>time+=n,setJailed:v=>jailed=v,setWitness:v=>witness=v};
}
test('Percy has approved name, nickname and aliases',()=>{assert.equal(AGENT.name,'Percy Wobblefoot');assert.equal(AGENT.nickname,'Tipsy');assert.ok(AGENT.aliases.includes('tipsy'));});
test('worker custody observation triggers an apology even when the role job was skipped in jail',async()=>{const f=fixture();f.setJailed(true);f.role.observeCustody(AGENT,f.memory.data.agents.percy);f.setJailed(false);await f.step();assert.equal(f.memory.data.agents.percy.tipsy.phase,'sober');assert.match(f.said.at(-1),/sorry/i);assert.ok(f.memory.data.agents.percy.tipsy.nextEpisode>100000+1200000-1);});
test('a witnessed disturbance files one case, with evidence, and no duplicate on restart',async()=>{const f=fixture();await f.step();f.advance(180001);await f.step();assert.equal(f.cases.length,0);f.advance(90001);await f.step();assert.equal(f.cases.length,1);assert.equal(f.cases[0].kind,'public_disturbance');assert.ok(f.cases[0].evidence.some(e=>e.kind==='provocation'&&e.about==='percy'));await f.step();assert.equal(f.cases.length,1);});
test('no witness means no invented complaint; custody prevents incidents and release gives cooldown',async()=>{const f=fixture();f.setWitness(false);await f.step();f.advance(300001);await f.step();f.advance(90001);await f.step();assert.equal(f.cases.length,0);f.setJailed(true);await f.step();f.setJailed(false);await f.step();assert.match(f.said.at(-1),/sorry/i);f.setWitness(true);await f.step();assert.equal(f.cases.length,0);assert.ok(f.memory.data.agents.percy.tipsy.nextEpisode>100000+390002);});
test('public disturbance has short bounded sentences and innocent citizens remain free',()=>{const c=newConflict({n:1,party_a:'clerk',party_b:'percy',kind:'public_disturbance',reason:'noise'});assert.equal(sentenceFor(c,{fault:null}).outcome,'dismissed');assert.equal(sentenceFor(c,{fault:'percy'},{priors:{percy:99}}).ticks,3600);assert.equal(sentenceFor(c,{fault:'percy'}).ticks,1200);});

test('tavern visits use its actual floor height rather than the height of a distant hill',async()=>{const f=fixture();await f.step();f.setPosition({x:280,z:90,y:80});f.advance(180001);await f.step();assert.deepEqual(f.moves[0],{x:323,z:119,y:65});});
