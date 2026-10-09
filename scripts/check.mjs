import net from 'node:net';
import {once} from 'node:events';
import {Bridge,AdminRcon} from '../node-bridge/bridge.mjs';
import {LocalLM} from '../agent-core/lm.mjs';
let failed=false;
async function check(name,fn){try{console.log('PASS',name,await fn());}catch(e){failed=true;console.error('FAIL',name,e.message);}}
await check('Minecraft TCP',()=>new Promise((resolve,reject)=>{
  const socket=net.connect({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565)});
  socket.setTimeout(4000,()=>{socket.destroy();reject(Error('TCP timeout'));});
  socket.once('connect',()=>{socket.end();resolve('connected');});socket.once('error',reject);
}));
await check('LM model listing and inference',async()=>{
  const lm=new LocalLM();await lm.init();
  const output=await lm.complete(lm.reason,'Reply with the word READY.',{});
  if(!output.trim())throw Error('Empty inference');
  return output.slice(0,120);
});
// Creates one configured NPC session, but does not issue movement/combat actions.
await check('WebSocket session + snapshot',async()=>{
  const bridge=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:'scout'}]);
  let timer;
  try{
    const snapshot=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('No snapshot in 12 seconds')),12000);
      bridge.on('message',m=>{if(m.type==='snapshot'&&m.agents.some(a=>a.id==='scout'))resolve('scout snapshot received');});
    });
    bridge.on('log',m=>console.error(m));bridge.start();return await snapshot;
  }finally{clearTimeout(timer);bridge.stop();}
});
if(process.env.RCON_PASSWORD)await check('RCON list',async()=>{
  const rcon=new AdminRcon({host:process.env.MC_HOST,port:Number(process.env.RCON_PORT||25576),password:process.env.RCON_PASSWORD});
  try{return await rcon.command('list');}finally{rcon.close();}
});
else console.log('SKIP RCON (RCON_PASSWORD not configured)');
process.exitCode=failed?1:0;
