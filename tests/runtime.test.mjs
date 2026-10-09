import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {Bridge,AdminRcon} from '../node-bridge/bridge.mjs';
import {LLMRouter,parsePlan} from '../agent-core/lm.mjs';
import {Memory} from '../agent-core/memory.mjs';
import {validatePlan,assertAction} from '../agent-core/actions.mjs';
const action={type:'wait',x:0,y:0,z:0,target:'',text:'',to:'',blocks:[],count:1,spec:{}};
test('reject malformed plans, distant movement, unknown teammates and player attacks',()=>{
  assert.equal(validatePlan({reflection:'ok',plan:'wait',action}),true);
  assert.equal(validatePlan({reflection:'ok',plan:'bad',action:{...action,type:'rcon'}}),false);
  const self={id:'scout',x:0,y:64,z:0,entities:[{uuid:'p',type:'PLAYER'}]};
  assert.throws(()=>assertAction({...action,type:'move',x:300},self,['scout']));
  assert.throws(()=>assertAction({...action,type:'tell',to:'stranger'},self,['scout']));
  assert.throws(()=>assertAction({...action,type:'attack',target:'p'},self,['scout']));
  assert.doesNotThrow(()=>assertAction({...action,type:'build',blocks:[{x:2,y:64,z:1,block:'OAK_PLANKS'}]},self,['scout']));
  assert.throws(()=>assertAction({...action,type:'build',blocks:[{x:2,y:64,z:1,block:'OAK_PLANKS'},{x:24,y:64,z:0,block:'OAK_PLANKS'}]},self,['scout']),/out of reach/);
  assert.throws(()=>assertAction({...action,type:'place',x:12,y:64,z:0,target:'OAK_PLANKS'},self,['scout']),/out of reach/);
});
test('memory and teammate messages survive restart with bounded history',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'sid-'));
  try{
    const m=new Memory(dir);await m.load();m.agent({id:'a',goal:'survey'});m.agent({id:'b',goal:'coordinate'});
    for(let i=0;i<100;i++)m.add('a',{i});m.tell('a','b','Meet at spawn');await m.save();
    const recovered=new Memory(dir);await recovered.load();
    assert.equal(recovered.data.agents.a.episodes.length,40);
    assert.equal(recovered.data.agents.b.inbox[0].text,'Meet at spawn');
    assert.equal(recovered.data.agents.a.goal,'survey');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('WebSocket session, acknowledgement, disconnect rejection and resubscription',async()=>{
  const server=new WebSocketServer({port:0});await once(server,'listening');let sessions=0;
  server.on('connection',(socket,request)=>{
    assert.equal(request.headers.authorization,'Bearer test-token');
    socket.on('message',buffer=>{
      const m=JSON.parse(buffer);if(m.type==='session')sessions++;
      if(m.type==='action'&&m.action.type==='disconnect'){socket.close();return;}
      socket.send(JSON.stringify({type:'ack',id:m.id,ok:true,result:m.type}));
    });
  });
  const bridge=new Bridge(`ws://127.0.0.1:${server.address().port}`,'test-token',[{id:'a'}]);
  try{
    const ready=once(bridge,'ready');bridge.start();await ready;
    assert.equal((await bridge.action('a',action)).result,'action');
    const reconnect=once(bridge,'ready');
    await assert.rejects(bridge.action('a',{type:'disconnect'}),/Disconnected/);
    await reconnect;assert.equal(sessions,2);
  }finally{bridge.stop();for(const client of server.clients)client.terminate();await new Promise(r=>server.close(r));}
});
test('LM model roles, bearer auth, JSON validation and no public endpoint fallback',async()=>{
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer secret');
    let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'reason'},{id:'dialog'}]}));return;}
    const body=JSON.parse(raw);requests.push(body);
    res.end(JSON.stringify({choices:[{message:{content:body.response_format?JSON.stringify({reflection:'safe',plan:'wait',action}):'Hello teammate'}}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    // Old-style settings (LM_BASE_URL, REASON_MODEL, LM_API_TOKEN) still configure the primary.
    const lm=new LLMRouter({LM_BASE_URL:`http://127.0.0.1:${server.address().port}`,REASON_MODEL:'reason',LM_API_TOKEN:'secret',OFFLOAD_LLM_URL:'http://127.0.0.1:1/v1'});
    await lm.init();assert.equal((await lm.plan({})).action.type,'wait');
    requests.length=0;await lm.speak({});
    assert.deepEqual(requests.map(r=>r.model),['reason']);
    assert.throws(()=>new LLMRouter({PRIMARY_LLM_URL:'https://example.com'}),/private LAN/);
    assert.throws(()=>new LLMRouter({LM_BASE_URL:'http://127.0.0.1:1',OFFLOAD_LLM_URL:'https://example.com/v1'}),/private LAN/);
  }finally{await new Promise(r=>server.close(r));}
});
test('RCON blocks unapproved commands before connecting',async()=>{
  const rcon=new AdminRcon({host:'127.0.0.1',port:1,password:'x'});
  await assert.rejects(rcon.command('op stranger'),/allowlisted/);
});
test('RCON authenticates, dispatches and reconnects after server disconnect',async()=>{
  const sockets=new Set();let connections=0;
  const server=net.createServer(socket=>{
    sockets.add(socket);connections++;socket.on('close',()=>sockets.delete(socket));
    let input=Buffer.alloc(0);
    socket.on('data',chunk=>{
      input=Buffer.concat([input,chunk]);
      while(input.length>=4&&input.length>=input.readInt32LE(0)+4){
        const length=input.readInt32LE(0),packet=input.subarray(4,length+4);input=input.subarray(length+4);
        const id=packet.readInt32LE(0),type=packet.readInt32LE(4),text=packet.subarray(8,-2).toString();
        if(type===3)assert.equal(text,'secret');else assert.equal(text,'list');
        const body=Buffer.from(type===3?'':'There are 0 players online');
        const output=Buffer.alloc(body.length+14);output.writeInt32LE(body.length+10,0);output.writeInt32LE(id,4);output.writeInt32LE(type===3?2:0,8);body.copy(output,12);
        socket.write(output);
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const rcon=new AdminRcon({host:'127.0.0.1',port:server.address().port,password:'secret'});
  try{
    assert.match(await rcon.command('list'),/0 players/);
    const ended=once(rcon.client,'end');for(const socket of sockets)socket.end();await ended;
    assert.match(await rcon.command('list'),/0 players/);assert.equal(connections,2);
  }finally{rcon.close();for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
});
test('plan parser tolerates reasoning, fences, prose and omitted fields but not garbage',()=>{
  const plan=parsePlan('<think>look around</think>Sure:\n```json\n{"reflection":"r","plan":"p","action":{"type":"wait"}}\n```');
  assert.equal(validatePlan(plan),true);assert.deepEqual(plan.action,action);
  assert.equal(validatePlan(parsePlan('{"reflection":"r","plan":"p","action":{"type":"rcon"}}')),false);
  assert.equal(typeof parsePlan('{"reflection":"r","plan":{"step":1},"action":{"type":"wait"}}').plan,'string');
  assert.equal(parsePlan('{"reflection":"r","plan":"p","action":{"type":"Move/pathfind to absolute x,y,z","x":1}}').action.type,'move');
  assert.equal(parsePlan(JSON.stringify({reflection:'r',plan:'p',action:{type:'chat',text:'x'.repeat(300)}})).action.text.length,240);
  assert.throws(()=>parsePlan('I will wait.'),/Invalid plan JSON/);
});
test('personality evolution is validated and trimmed',async()=>{
  const server=http.createServer(async(req,res)=>{
    for await(const _ of req);
    res.setHeader('Content-Type','application/json');
    const content=JSON.stringify({personality:'Brave and kind. '.repeat(40),mood:'proud',relationships:{jrmym1981:'Trusts them after building the square together.'}});
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    // Personality reflection is background work: offload first (down here), then the primary.
    const lm=new LLMRouter({LM_BASE_URL:`http://127.0.0.1:${server.address().port}`,REASON_MODEL:'r',OFFLOAD_LLM_URL:'http://127.0.0.1:1/v1'});
    const update=await lm.evolve({});
    assert.equal(update.personality.length,400);assert.equal(update.mood,'proud');
    assert.match(update.relationships.jrmym1981,/Trusts/);
  }finally{await new Promise(r=>server.close(r));}
});
test('bridge paces requests under the plugin rate limit and subscribes to /sid commands',async()=>{
  const server=new WebSocketServer({port:0});await once(server,'listening');
  const times=[];let subscribed;
  server.on('connection',socket=>socket.on('message',buffer=>{
    const m=JSON.parse(buffer);times.push(Date.now());if(m.type==='subscribe')subscribed=m.events;
    socket.send(JSON.stringify({type:'ack',id:m.id,ok:true,result:'ok'}));
  }));
  const bridge=new Bridge(`ws://127.0.0.1:${server.address().port}`,'t',[]);
  try{
    const ready=once(bridge,'ready');bridge.start();await ready;
    assert.ok(subscribed.includes('command'));
    times.length=0;
    await Promise.all(Array.from({length:10},()=>bridge.action('a',action)));
    const gaps=times.slice(1).map((t,i)=>t-times[i]);
    assert.ok(Math.min(...gaps)>=60,`gaps ${gaps}`);
    assert.ok(10/((times.at(-1)-times[0])/1000)<=20,'stays under 20 requests per second');
  }finally{bridge.stop();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));}
});
