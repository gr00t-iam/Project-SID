// Startup configuration checks with diagnostics that say exactly what is wrong and where.
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
// Optional profile fields (religion, culture, hobbies, charisma): config/citizen.schema.json.
const citizenSchema=JSON.parse(readFileSync(new URL('../config/citizen.schema.json',import.meta.url),'utf8'));
const validCitizen=new Ajv({allErrors:true,allowUnionTypes:true}).compile(citizenSchema);

/** A configuration problem that should stop startup; `hint` says how to fix it. */
export class ConfigError extends Error{
  constructor(message,{file,hint}={}){super(message);this.name='ConfigError';if(file)this.file=file;if(hint)this.hint=hint;}
}

/** Parses JSON text, turning a syntax error into a message with the line and column. */
export function parseJson(text,file){
  try{return JSON.parse(text);}
  catch(error){
    const pos=Number(error.message.match(/position (\d+)/)?.[1]);
    const where=Number.isFinite(pos)?(()=>{const before=text.slice(0,pos).split('\n');return ` at line ${before.length}, column ${before.at(-1).length+1}`;})():'';
    throw new ConfigError(`${file} is not valid JSON${where}: ${error.message}`,{file,hint:'Check for a missing comma, quote or bracket.'});
  }
}

/**
 * Checks an agents list: 1-16 agents, unique ids of 1-32 letters, digits, - or _. Returns warnings for fields
 * that are optional but usually wanted (goal, personality).
 */
export function checkAgents(configs,file='agents.json'){
  if(!Array.isArray(configs))throw new ConfigError(`${file} must be a JSON array of agents`,{file,hint:'[{"id":"builder","role":"builder","goal":"...","personality":"..."}]'});
  if(configs.length<1||configs.length>16)throw new ConfigError(`${file} lists ${configs.length} agents; 1 to 16 are supported (the plugin's max-agents)`,{file});
  const seen=new Set(),warnings=[];
  configs.forEach((c,i)=>{
    const where=`${file} entry ${i+1}${c?.id?` ("${c.id}")`:''}`;
    if(!c||typeof c!=='object')throw new ConfigError(`${where} is not an object`,{file});
    if(typeof c.id!=='string'||!/^[-a-zA-Z0-9_]{1,32}$/.test(c.id))throw new ConfigError(`${where}: id must be 1-32 letters, digits, - or _`,{file});
    if(seen.has(c.id))throw new ConfigError(`${where}: the id "${c.id}" is used twice`,{file});
    seen.add(c.id);
    for(const k of ['goal','personality'])if(typeof c[k]!=='string'||!c[k].trim())warnings.push(`${where} has no ${k}`);
    if(!validCitizen(c))throw new ConfigError(`${where}: ${validCitizen.errors.map(e=>`${e.instancePath||'/'} ${e.message}${e.params?.allowedValues?` (${e.params.allowedValues.join(', ')})`:''}`).join('; ')}`,{file,hint:'See config/citizen.schema.json for religion, culture and hobbies.'});
  });
  return warnings;
}

/** Reads and checks the agents file. */
export async function loadAgents(file){
  let text;
  try{text=await readFile(file,'utf8');}
  catch(error){throw new ConfigError(`Cannot read ${file}: ${error.code==='ENOENT'?'the file does not exist':error.message}`,{file,hint:'Set AGENTS_FILE or copy config/agents.json into place.'});}
  const configs=parseJson(text,file);
  return {configs,warnings:checkAgents(configs,file)};
}

/** Reads an optional JSON file: its value, or the fallback (with a warning when the file exists but is broken). */
export async function loadOptionalJson(file,fallback){
  let text;
  try{text=await readFile(file,'utf8');}catch(error){return {value:fallback,warning:error.code==='ENOENT'?null:`Cannot read ${file}: ${error.message}`};}
  try{return {value:parseJson(text,file),warning:null};}catch(error){return {value:fallback,warning:`${error.message} - using defaults`};}
}

const REQUIRED={BRIDGE_URL:'the plugin WebSocket, e.g. ws://10.0.0.58:3001',BRIDGE_TOKEN:'the shared secret from the plugin config'};
const RECOMMENDED={DASHBOARD_TOKEN:'without it the dashboard is open to anyone on the network',STATE_DIR:'defaults to ./state (memory is lost when the folder is replaced)'};
/** Environment checks: {errors, warnings}. errors stop startup. */
export function checkEnv(env=process.env){
  const errors=[],warnings=[];
  for(const [k,why] of Object.entries(REQUIRED))if(!env[k]||String(env[k]).startsWith('REPLACE'))errors.push(`${k} is not set (${why})`);
  if(env.BRIDGE_URL&&!/^wss?:\/\//.test(env.BRIDGE_URL))errors.push('BRIDGE_URL must start with ws:// or wss://');
  if(!env.PRIMARY_LLM_URL&&!env.LM_BASE_URL)warnings.push('No model server set (PRIMARY_LLM_URL or LM_BASE_URL): using http://10.0.0.162:1234');
  for(const [k,why] of Object.entries(RECOMMENDED))if(!env[k])warnings.push(`${k} is not set: ${why}`);
  for(const k of ['LM_TIMEOUT_MS','FIRST_TOKEN_MS','LOOP_MS','MEMORY_SAVE_MS','THINK_HEARTBEAT_MS','PRIMARY_PARALLEL','OFFLOAD_PARALLEL','AGENT_CONCURRENCY','DASHBOARD_PORT'])
    if(env[k]!==undefined&&env[k]!==''&&!Number.isFinite(Number(env[k])))errors.push(`${k} must be a number (got "${env[k]}")`);
  return {errors,warnings};
}
