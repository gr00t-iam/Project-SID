import {Bridge,AdminRcon} from '../node-bridge/bridge.mjs';
// Proves the agent can stay connected on an empty server. Run with the main service stopped:
//   node --env-file=config/runtime.env scripts/verify-spawn.mjs [agent]
// Longer than the vanilla 60 s pause-when-empty default, so a paused server fails this check.
const agent=process.argv[2]||'scout';
const soakMs=Number(process.env.SOAK_SECONDS||90)*1000;
const maxGapMs=5000;
const log=(status,name,detail='')=>console.log(status,name,detail);
// Monotonic tick counter; 26.x replaced "time query daytime" with timelines.
const gametime=text=>{const m=/(\d+) tick/.exec(text);if(!m)throw Error(`Unexpected gametime reply: ${text}`);return Number(m[1]);};

if(!process.env.RCON_PASSWORD)throw Error('Set RCON_PASSWORD in config/runtime.env');
const rcon=new AdminRcon({host:process.env.MC_HOST,port:Number(process.env.RCON_PORT||25576),password:process.env.RCON_PASSWORD});
const bridge=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:agent}]);
let failed=false;
try{
  const players=await rcon.command('list');
  log('PASS','RCON handshake',players.trim());
  const startTicks=gametime(await rcon.command('time query gametime'));

  let ready=0,offline=0,snapshots=0,maxGap=0,last=0,position=null;
  bridge.on('log',m=>console.error('bridge:',m));
  bridge.on('ready',()=>{ready++;log(ready===1?'PASS':'WARN','WebSocket session',ready===1?`agent ${agent} registered`:`re-registered (#${ready})`);});
  bridge.on('offline',()=>{offline++;log('WARN','WebSocket offline');});
  bridge.on('message',m=>{
    if(m.type!=='snapshot')return;
    const self=m.agents?.find(a=>a.id===agent);if(!self)return;
    const now=Date.now();
    if(last)maxGap=Math.max(maxGap,now-last);
    if(!snapshots)log('PASS','NPC spawned',`${agent} at ${[self.x,self.y,self.z].map(v=>v.toFixed(1)).join(' ')}`);
    last=now;snapshots++;position=self;
  });
  bridge.start();

  const deadline=Date.now()+soakMs;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,10000));
    if(last)maxGap=Math.max(maxGap,Date.now()-last);
    log('....','soak',`${Math.round((soakMs-(deadline-Date.now()))/1000)}s snapshots=${snapshots} maxGap=${maxGap}ms`);
  }
  const endTicks=gametime(await rcon.command('time query gametime'));
  const elapsed=endTicks-startTicks;

  if(!snapshots){failed=true;log('FAIL','NPC spawned','no snapshot for this agent');}
  if(offline||ready!==1){failed=true;log('FAIL','Connection stable',`ready=${ready} offline=${offline}`);}
  else log('PASS','Connection stable',`single session for ${soakMs/1000}s`);
  if(maxGap>maxGapMs){failed=true;log('FAIL','Snapshot continuity',`max gap ${maxGap}ms`);}
  else if(snapshots)log('PASS','Snapshot continuity',`${snapshots} snapshots, max gap ${maxGap}ms`);
  // 20 ticks/s; allow a slow server, but a paused one advances ~0.
  if(elapsed<soakMs/1000*10){failed=true;log('FAIL','World ticking',`game time advanced ${elapsed} ticks; set pause-when-empty-seconds=0`);}
  else log('PASS','World ticking',`game time advanced ${elapsed} ticks`);
  if(position)log('INFO','final position',JSON.stringify({x:position.x,y:position.y,z:position.z,health:position.health}));
}catch(error){failed=true;log('FAIL','verify',error.message);}
finally{bridge.removeAllListeners();bridge.stop();rcon.close();}
process.exitCode=failed?1:0;
