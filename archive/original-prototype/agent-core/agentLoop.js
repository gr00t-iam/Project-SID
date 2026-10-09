import WebSocket from 'ws';
import { runLLM } from './llmRouter.js';

const PAPER_WS = 'ws://10.0.0.58:25566';
const AGENT_ID = process.env.AGENT_ID || 'sid-01';

let ws;
let memory = { short: [], long: {} };
let goals = [{ id: 'survive', priority: 1 }];

function connect(){
  ws = new WebSocket(PAPER_WS);
  ws.on('open', ()=> console.log('Connected to PaperMC'));
  ws.on('message', async data => {
    const perception = JSON.parse(data);
    const result = await runLLM(perception, memory, goals, {name:'Sid'});
    ws.send(JSON.stringify({agentId:AGENT_ID, ...result}));
    memory = {...memory, ...result.memoryUpdate};
  });
  ws.on('close', ()=> setTimeout(connect, 3000));
}
connect();
