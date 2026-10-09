import {LocalLM} from '../agent-core/lm.mjs';
const lm=new LocalLM();
console.log(JSON.stringify(await lm.http('/v1/models'),null,2));
