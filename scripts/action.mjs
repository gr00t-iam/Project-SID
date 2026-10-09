import {Bridge} from '../node-bridge/bridge.mjs';
const [agent,json]=process.argv.slice(2);
if(!agent||!json)throw Error('Usage: node --env-file=config/runtime.env scripts/action.mjs scout \'{"type":"chat","text":"Hello"}\'');
const action=JSON.parse(json);
const bridge=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[{id:agent}]);
const timer=setTimeout(()=>{console.error('Timed out');bridge.stop();process.exitCode=1;},45000);
bridge.on('log',console.error);
bridge.once('ready',async()=>{
  try{
    console.log(JSON.stringify(await bridge.action(agent,action)));
    if(['move','pathfind'].includes(action.type))await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{bridge.off('message',observe);reject(Error('Arrival not observed within 30 seconds'));},30000);
      function observe(message){
        if(message.type!=='snapshot')return;
        const self=message.agents.find(a=>a.id===agent);if(!self)return;
        const distance=Math.hypot(self.x-action.x,self.y-action.y,self.z-action.z);
        console.log(JSON.stringify({agent,distance,pathing:self.pathing}));
        if(distance<2){clearTimeout(deadline);bridge.off('message',observe);console.log('ARRIVED');resolve();}
      }
      bridge.on('message',observe);
    });
  }
  catch(e){console.error(e.message);process.exitCode=1;}
  finally{clearTimeout(timer);bridge.stop();}
});
bridge.start();
