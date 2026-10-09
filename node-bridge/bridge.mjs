import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import rconPackage from 'rcon-client';
const {Rcon} = rconPackage;

// The plugin closes the socket (1008 "Request limit") when a client sends more than 20 messages within its
// 1-second window or any message over 8192 characters, and rejects a second action for the same agent within
// 250 ms. Every request goes through one queue that is drained against the real send times (a sliding window),
// so event-loop stalls cannot release a burst. Status/mood updates still waiting in the queue are replaced by
// the newer one, and identical read-only requests share a single round trip.
const COALESCE=new Set(['status','mood']);
const SHARED=new Set(['survey','find','appraise','recipes','books']);
export const MAX_TEXT=8000;

/** Drops entries from the end of spec[list] (then of spec.places) until a mapdata request fits MAX_TEXT. */
export function fitMapSpec(spec,list,max=MAX_TEXT-400){
  const out={...spec,[list]:[...(spec[list]??[])]};
  while(JSON.stringify(out).length>max&&out[list].length)out[list].pop();
  while(JSON.stringify(out).length>max&&out.places?.length)out.places=out.places.slice(0,-1);
  return out;
}

export class Bridge extends EventEmitter {
  // rate: at most this many sends in any `window` ms (plugin limit 20/s); interval: minimum gap between sends;
  // agentGap: minimum gap between two actions of one agent.
  constructor(url,token,agents,{rate=15,window=1000,interval=60,agentGap=300,maxText=MAX_TEXT,WebSocketClass=WebSocket}={}) {
    super(); Object.assign(this,{url,token,agents,rate,window,interval,agentGap,maxText,WebSocketClass});
    this.queue=[];this.sentAt=[];this.agentAt=new Map();this.shared=new Map();this.recent=[];
    this.stats={sent:0,coalesced:0,shared:0,tooLarge:0,peak:0,kinds:{}};
    this.pending=new Map(); this.stopped=true; this.ready=false; this.attempt=0;
  }
  start() {
    this.stopped=false; this.connect();
    this.statsTimer=setInterval(()=>this.emit('log',`stats ${JSON.stringify(this.takeStats())}`),600000);this.statsTimer.unref?.();
  }
  connect() {
    if(this.stopped) return;
    const ws=this.ws=new this.WebSocketClass(this.url,{headers:{Authorization:`Bearer ${this.token}`},handshakeTimeout:5000,maxPayload:2*1024*1024});
    let alive=true;
    const beat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;if(ws.readyState===WebSocket.OPEN)ws.ping();},15000);
    ws.on('pong',()=>{alive=true;});
    ws.on('open',async()=>{
      try {
        // The plugin replies with its build settings (allowed materials).
        this.info=(await this.request('subscribe',{events:['chat','movement','block','entity','action','trade','command','player','vandalism','damage']})).result;
        for(const agent of this.agents) await this.request('session',{agent:agent.id});
        this.ready=true; this.attempt=0; this.emit('ready');
      } catch(error) {this.emit('log',error.message); ws.close();}
    });
    ws.on('message',data=>{
      let message; try {message=JSON.parse(data.toString());}catch{return;}
      const pending=this.pending.get(message.id);
      if(message.type==='ack' && pending) {
        clearTimeout(pending.timer);this.pending.delete(message.id);
        message.ok?pending.resolve(message):pending.reject(Error(message.error||'Action rejected'));
      } else this.emit('message',message);
    });
    ws.on('error',e=>this.emit('log',`bridge: ${e.message}`));
    ws.on('close',(code,reason)=>{
      clearInterval(beat);this.ready=false;this.emit('offline',{code,reason:reason?.toString()});
      if(code!==1000&&code!==1005)this.emit('log',`bridge closed by server: ${code} ${reason?.toString()||''}`.trim());
      if(code===1008)this.emit('log',`request limit: ${JSON.stringify(this.recentSends())}`);
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Disconnected; action outcome may be unknown'));}
      this.pending.clear();
      // Queued requests were never sent, so nothing happened in the world.
      clearTimeout(this.pumpTimer);this.pumpTimer=null;
      for(const item of this.queue.splice(0))for(const w of item.waiters)w.reject(Error('Bridge offline'));
      this.shared.clear();
      if(!this.stopped)this.retry=setTimeout(()=>this.connect(),Math.min(30000,1000*2**Math.min(this.attempt++,5))+Math.random()*500);
    });
  }
  request(type,fields={}) {
    if(this.ws?.readyState!==WebSocket.OPEN)return Promise.reject(Error('Bridge offline'));
    const kind=type==='action'?String(fields.action?.type??'?'):type,agent=type==='action'?fields.agent:null;
    if(agent&&COALESCE.has(kind)){
      const queued=this.queue.find(q=>q.agent===agent&&q.kind===kind);
      if(queued){queued.fields=fields;this.stats.coalesced++;return new Promise((resolve,reject)=>queued.waiters.push({resolve,reject}));}
    }
    const key=SHARED.has(kind)?JSON.stringify([type,fields]):null;
    if(key&&this.shared.has(key)){this.stats.shared++;return this.shared.get(key);}
    if(this.pending.size+this.queue.length>=32)return Promise.reject(Error('Too many pending requests'));
    const promise=new Promise((resolve,reject)=>this.queue.push({id:randomUUID(),type,fields,kind,agent,waiters:[{resolve,reject}]}));
    if(key){const drop=()=>{if(this.shared.get(key)===promise)this.shared.delete(key);};this.shared.set(key,promise);promise.then(drop,drop);}
    this.pump();
    return promise;
  }
  /** Send what the limits allow now; otherwise come back when the next slot opens. */
  pump() {
    clearTimeout(this.pumpTimer);this.pumpTimer=null;
    while(this.queue.length) {
      const ws=this.ws;if(ws?.readyState!==WebSocket.OPEN)return;
      const now=Date.now();
      while(this.sentAt.length&&now-this.sentAt[0]>=this.window)this.sentAt.shift();
      let wait=this.sentAt.length>=this.rate?this.sentAt[0]+this.window-now:0;
      if(this.sentAt.length)wait=Math.max(wait,this.sentAt.at(-1)+this.interval-now);
      if(wait>0){this.pumpTimer=setTimeout(()=>this.pump(),wait);return;}
      // The oldest request whose agent may act again (each agent's own requests keep their order).
      let index=-1,agentWait=Infinity;
      for(let i=0;i<this.queue.length&&index<0;i++){
        const q=this.queue[i],left=q.agent?(this.agentAt.get(q.agent)??-Infinity)+this.agentGap-now:0;
        if(left<=0)index=i;else agentWait=Math.min(agentWait,left);
      }
      if(index<0){this.pumpTimer=setTimeout(()=>this.pump(),agentWait);return;}
      this.send(ws,this.queue.splice(index,1)[0],now);
    }
  }
  send(ws,item,now) {
    const fail=error=>{for(const w of item.waiters)w.reject(error);};
    const text=JSON.stringify({type:item.type,id:item.id,...item.fields});
    if(text.length>this.maxText){this.stats.tooLarge++;fail(Error(`Request too large for the plugin (${item.kind}: ${text.length} chars, limit ${this.maxText})`));return;}
    this.sentAt.push(now);if(item.agent)this.agentAt.set(item.agent,now);
    this.stats.sent++;this.stats.kinds[item.kind]=(this.stats.kinds[item.kind]||0)+1;this.stats.peak=Math.max(this.stats.peak,this.sentAt.length);
    this.recent.push({t:now,k:item.kind,n:text.length});if(this.recent.length>200)this.recent.splice(0,50);
    const timer=setTimeout(()=>{this.pending.delete(item.id);fail(Error('Acknowledgement timeout; do not blindly repeat actions'));},5000);
    this.pending.set(item.id,{timer,resolve:message=>{for(const w of item.waiters)w.resolve(message);},reject:fail});
    ws.send(text,error=>{if(error){clearTimeout(timer);this.pending.delete(item.id);fail(error);}});
  }
  /** What went out in the last 2 s (logged if the plugin still closes us for "Request limit"). */
  recentSends() {
    const now=Date.now(),last=this.recent.filter(x=>now-x.t<2000),kinds={};
    for(const x of last)kinds[x.k]=(kinds[x.k]||0)+1;
    return {last1s:last.filter(x=>now-x.t<1000).length,last2s:last.length,maxLen:Math.max(0,...last.map(x=>x.n)),kinds,queued:this.queue.length,pending:this.pending.size};
  }
  takeStats() {const s={...this.stats,queued:this.queue.length};this.stats={sent:0,coalesced:0,shared:0,tooLarge:0,peak:0,kinds:{}};return s;}
  action(agent,action){return this.request('action',{agent,action});}
  stop(){this.stopped=true;clearTimeout(this.retry);clearTimeout(this.pumpTimer);clearInterval(this.statsTimer);this.ws?.close();}
}

// Operator-only commands. The autonomous LLM never receives arbitrary RCON access.
export class AdminRcon {
  constructor(options){this.options=options;this.tail=Promise.resolve();}
  command(command) {
    if(!/^(list|version|time query (daytime|gametime|day))$/.test(command))return Promise.reject(Error('RCON command not allowlisted'));
    const task=this.tail.then(async()=>{
      if(!this.client){
        const client=new Rcon({...this.options,timeout:5000});
        client.on('error',()=>{if(this.client===client)this.client=null;});
        client.on('end',()=>{if(this.client===client)this.client=null;});
        try{await client.connect();}catch(error){client.end().catch(()=>{});throw error;}
        this.client=client;
      }
      try{return await this.client.send(command);}catch(error){this.client?.end().catch(()=>{});this.client=null;throw error;}
    });
    this.tail=task.catch(()=>{});return task;
  }
  close(){this.client?.end().catch(()=>{});this.client=null;}
}
