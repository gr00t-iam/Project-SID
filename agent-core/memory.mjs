import {mkdir,readFile,open,rename} from 'node:fs/promises';
import path from 'node:path';
export class Memory {
  // debounceMs > 0 coalesces saves: save() marks the state dirty and one compact write happens at most every
  // debounceMs (flush() writes now, e.g. at shutdown). 0 keeps the old behaviour: every save() writes.
  constructor(dir,{debounceMs=0}={}){this.dir=dir;this.file=path.join(dir,'memory.json');this.data={agents:{},board:[]};this.debounceMs=debounceMs;this.writes=0;}
  async load(){
    await mkdir(this.dir,{recursive:true});
    try{this.data=JSON.parse(await readFile(this.file,'utf8'));if(!this.data.agents||!Array.isArray(this.data.board))throw Error('Invalid memory file');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  agent(config){return this.data.agents[config.id]??=( {goal:config.goal,episodes:[],inbox:[],last:null} );}
  add(id,episode){const a=this.data.agents[id];a.episodes.push(episode);a.episodes=a.episodes.slice(-40);}
  tell(from,to,text){
    const item={time:Date.now(),from,to,text};
    this.data.agents[to].inbox.push(item);this.data.agents[to].inbox=this.data.agents[to].inbox.slice(-20);
    this.data.board.push(item);this.data.board=this.data.board.slice(-30);
  }
  // Serialized: the model loop and the background worker both save.
  save(){
    if(!this.debounceMs)return this.flush();
    this.dirty=true;
    this.timer??=setTimeout(()=>{this.timer=null;if(this.dirty)this.flush().catch(()=>{});},this.debounceMs);
    return Promise.resolve();
  }
  flush(){
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    this.dirty=false;
    // The state is serialised when the write runs (the latest version), written to a temporary file, flushed to
    // disk, then renamed over the old file: a crash leaves either the old or the new file, never half of one.
    const run=async()=>{
      const handle=await open(this.file+'.tmp','w',0o600);
      try{await handle.writeFile(JSON.stringify(this.data,null,this.debounceMs?0:2));await handle.sync();}finally{await handle.close();}
      await rename(this.file+'.tmp',this.file);
      if(process.platform!=='win32'){const dir=await open(this.dir,'r');try{await dir.sync();}finally{await dir.close();}}
      this.writes++;
    };
    this.saving=(this.saving??Promise.resolve()).then(run,run);return this.saving;
  }
}
