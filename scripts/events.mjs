import {Bridge} from '../node-bridge/bridge.mjs';
// An observer owns no agents and can run alongside the main service.
const bridge=new Bridge(process.env.BRIDGE_URL,process.env.BRIDGE_TOKEN,[]);
bridge.on('log',console.error);
bridge.on('message',m=>console.log(JSON.stringify(m)));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>bridge.stop());
bridge.start();
