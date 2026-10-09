// A live window into the citizens' minds: when each one is thinking (waiting on its model), why it started, how long
// it took and what it concluded (reflection, plan, the action it chose, or the words it said). The dashboard shows a
// pulsing brain while a citizen thinks and a running feed of thoughts; the map (BlueMap, via the plugin's "mind"
// action) shows the same brain over the citizen's head.

const REASONS={addressed:'someone spoke to them',heard:'heard something nearby',message:'got a message',heartbeat:'a quiet moment to take stock',
  failure:'something went wrong',goal:'working on a goal',reply:'answering someone','phase:dawn':'dawn','phase:dusk':'dusk',
  'phase:night':'nightfall','phase:day':'daybreak',always:'thinking it over'};
export const reasonText=why=>{const w=String(why??'');if(REASONS[w])return REASONS[w];if(w.startsWith('encounter:'))return `meeting ${w.slice(10)}`;
  if(w.startsWith('phase:'))return w.slice(6);return w.replace(/[_:]/g,' ');};

export function createMinds({act=async()=>{},log=()=>{},names=id=>id,now=()=>Date.now(),keep=60}={}){
  const minds=new Map(),feed=[];
  const of=id=>{let m=minds.get(id);if(!m)minds.set(id,m={thinking:false,since:0,why:null,kind:null,last:null,count:0});return m;};
  const tell=(id,target,text)=>act(id,{type:'mind',x:0,y:0,z:0,target,text:String(text??'').slice(0,290)}).catch(()=>{});
  return {
    /** A citizen starts thinking: kind is 'plan' (deciding what to do), 'reply' (answering someone) or a task name. */
    start(id,why,kind='plan'){
      const m=of(id);m.thinking=true;m.since=now();m.why=why;m.kind=kind;
      tell(id,'thinking',`${kind==='reply'?'Answering':'Thinking'}: ${reasonText(why)}`);
    },
    /** What the thought came to. thought: {reflection, plan, action:{type,text,to,target}, result, said, error}. */
    end(id,thought={}){
      const m=of(id);if(!m.thinking&&!Object.keys(thought).length)return;
      const ms=m.since?now()-m.since:0,entry={id,name:names(id),at:now(),ms,why:m.why,reason:reasonText(m.why),kind:m.kind,...thought};
      m.thinking=false;m.last=entry;m.count++;
      if(thought.reflection||thought.plan||thought.said||thought.action||thought.error){feed.unshift(entry);if(feed.length>keep)feed.length=keep;}
      const gist=thought.said?`Said: ${thought.said}`:thought.plan?`Plan: ${thought.plan}`:thought.reflection??thought.error??'';
      tell(id,'idle',gist);
    },
    /** A turn that ended without a recorded thought (an error elsewhere) still stops the brain. */
    stop(id){const m=minds.get(id);if(m?.thinking)this.end(id,{});},
    thinking:id=>!!minds.get(id)?.thinking,
    view(ids=[...minds.keys()]){
      const t=now();
      return {agents:Object.fromEntries(ids.map(id=>{const m=minds.get(id);return [id,m?{thinking:m.thinking,for:m.thinking?Math.round((t-m.since)/1000):0,
        why:m.thinking?reasonText(m.why):null,kind:m.kind,thoughts:m.count,last:m.last}:{thinking:false,thoughts:0,last:null}];})),
        feed:feed.slice(0,40),thinkingNow:[...minds.entries()].filter(([,m])=>m.thinking).map(([id])=>id)};
    },
  };
}
