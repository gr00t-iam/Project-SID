import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Bridge,fitMapSpec,MAX_TEXT} from '../node-bridge/bridge.mjs';

// A stand-in for the plugin socket: records send times and acknowledges everything.
class FakeSocket extends EventEmitter {
  static last;
  constructor(){super();this.readyState=0;this.sent=[];FakeSocket.last=this;setImmediate(()=>{this.readyState=1;this.emit('open');});}
  send(text,callback){
    const message=JSON.parse(text);this.sent.push({at:Date.now(),message,length:text.length});callback?.();
    setImmediate(()=>this.emit('message',Buffer.from(JSON.stringify({type:'ack',id:message.id,ok:true,result:message.action?.text??'ok'}))));
  }
  ping(){} terminate(){this.close();}
  close(){if(this.readyState===3)return;this.readyState=3;setImmediate(()=>this.emit('close',1000,Buffer.from('')));}
}
async function connected(t,options={}){
  const bridge=new Bridge('ws://test','t',[],{WebSocketClass:FakeSocket,...options});bridge.on('log',()=>{});t.after(()=>bridge.stop());
  const ready=new Promise(resolve=>bridge.once('ready',resolve));bridge.start();await ready;
  const ws=FakeSocket.last;ws.sent.length=0;return {bridge,ws};
}
const peak=(times,window=1000)=>Math.max(0,...times.map(t=>times.filter(u=>u>=t&&u-t<window).length));

test('an event-loop stall does not release a burst: never more than 15 sends in any second',async t=>{
  const {bridge,ws}=await connected(t);
  const done=Array.from({length:30},(_,i)=>bridge.action(`a${i}`,{type:'pathfind',x:i,y:0,z:0}));
  const until=Date.now()+1200;while(Date.now()<until);   // the loop is busy while the requests wait
  await Promise.all(done);
  const times=ws.sent.map(s=>s.at);
  assert.equal(times.length,30);
  assert.ok(peak(times)<=15,`peak ${peak(times)}/s`);
  for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=55,`gap ${times[i]-times[i-1]} ms`);
});

test('one agent never gets two actions within 300 ms (plugin: 250 ms), others are not held up',async t=>{
  const {bridge,ws}=await connected(t);
  await Promise.all([bridge.action('a',{type:'pathfind',x:1,y:0,z:0}),bridge.action('a',{type:'pathfind',x:2,y:0,z:0}),
    bridge.action('b',{type:'chat',x:0,y:0,z:0,text:'hi'})]);
  const a=ws.sent.filter(s=>s.message.agent==='a');
  assert.deepEqual(a.map(s=>s.message.action.x),[1,2],'order kept');
  assert.ok(a[1].at-a[0].at>=295,`gap ${a[1].at-a[0].at}`);
  assert.ok(ws.sent.findIndex(s=>s.message.agent==='b')<ws.sent.indexOf(a[1]),'b goes in between');
});

test('queued status updates for an agent collapse into the newest one',async t=>{
  const {bridge,ws}=await connected(t);
  const move=bridge.action('a',{type:'pathfind',x:1,y:0,z:0});   // holds agent a for 300 ms
  const results=await Promise.all(['one','two','three'].map(text=>bridge.action('a',{type:'status',x:0,y:0,z:0,text,tag:'x'})));
  await move;
  assert.deepEqual(ws.sent.filter(s=>s.message.action.type==='status').map(s=>s.message.action.text),['three']);
  assert.deepEqual(results.map(r=>r.result),['three','three','three']);
});

test('identical read-only requests share one round trip',async t=>{
  const {bridge,ws}=await connected(t);
  const survey={type:'survey',x:5,y:0,z:5,width:1,depth:1};
  const [a,b]=await Promise.all([bridge.action('a',survey),bridge.action('a',{...survey})]);
  assert.equal(ws.sent.length,1);assert.equal(a,b);
  await bridge.action('a',survey);assert.equal(ws.sent.length,2,'answered requests are asked again');
});

test('an oversized request fails on its own instead of getting the connection closed',async t=>{
  const {bridge,ws}=await connected(t);
  await assert.rejects(bridge.action('a',{type:'mapdata',x:0,y:0,z:0,spec:{resources:'x'.repeat(9000)}}),/too large/);
  assert.equal(ws.sent.length,0);assert.equal(ws.readyState,1);
  assert.ok((await bridge.action('a',{type:'wait',x:0,y:0,z:0})).ok);
});

test('map layers are trimmed to fit the plugin message limit',()=>{
  const resources=Array.from({length:500},(_,i)=>({id:String(i),label:'oak log',detail:'Trees seen by Gideon "Timber" Vance',x:i,y:64,z:-i}));
  const spec=fitMapSpec({resources},'resources');
  assert.ok(JSON.stringify({type:'action',id:'00000000-0000-0000-0000-000000000000',agent:'lumberjack',action:{type:'mapdata',x:0,y:0,z:0,spec}}).length<=MAX_TEXT);
  assert.ok(spec.resources.length>20&&spec.resources.length<500);
  assert.equal(spec.resources[0].id,'0','keeps the first entries');
  const small={places:[{id:'p'}],points:[]};assert.deepEqual(fitMapSpec(small,'points'),small);
});
