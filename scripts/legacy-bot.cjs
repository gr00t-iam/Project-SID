// Optional replacement for the original Mineflayer index.js.
// This gives an actionable failure instead of reconnecting forever on incompatible protocols.
// It does NOT add 26.2 protocol support to Mineflayer.
const mineflayer=require('mineflayer');
const protocol=require('minecraft-protocol');
const data=require('minecraft-data');
const host=process.env.MC_HOST||'10.0.0.58';
const port=Number(process.env.MC_PORT||25565);
let attempt=0,stopping=false,current;
async function start(){
  if(stopping)return;
  protocol.ping({host,port,closeTimeout:5000},(error,status)=>{
    if(error){console.error('Status ping failed:',error.message);retry();return;}
    const version=data(status.version.protocol);
    if(!version){console.error(`Server ${status.version.name} protocol ${status.version.protocol} is unsupported. Use SIDLocal/Citizens or a supported separate server. No LXC security change will fix this.`);process.exitCode=2;return;}
    let bot;
    try{bot=current=mineflayer.createBot({host,port,version:version.version.minecraftVersion,username:process.env.MC_USERNAME||'Agent_Sid_1',auth:process.env.MC_AUTH||'offline'});}
    catch(e){console.error(e.message);process.exitCode=2;return;}
    let permanent=false;
    bot.on('spawn',()=>{attempt=0;console.log('Bot spawned:',bot.username);});
    bot.on('chat',(username,message)=>console.log(`<${username}> ${message}`));
    bot.on('error',e=>{console.error(e.message);if(/unsupported|version/i.test(e.message))permanent=true;});
    bot.on('kicked',reason=>{console.error('Kicked:',JSON.stringify(reason));permanent=true;});
    bot.on('end',()=>{if(permanent)process.exitCode=2;else retry();});
  });
}
function retry(){if(!stopping)setTimeout(start,Math.min(30000,1000*2**Math.min(attempt++,5)));}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;current?.quit();});
start();
