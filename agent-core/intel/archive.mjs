// Conversation archive: every conversation (citizens with each other, players with citizens) becomes a
// structured record, is summarised and tagged by the utility model (offload server first), and is stored in
// settlement_intelligence.db (conversations + conversation_lines) and as one JSON file per conversation under
// <logDir>/conversations/YYYY-MM-DD/<id>.json.
// Record: {conversation_id, timestamp (ISO), tick {day, worldTime}, participants [names], participant_ids,
//          location [x,y,z], topic_tags [snake_case], transcript [{speaker, message, timestamp}], summary}
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {json} from './db.mjs';

const PROMPT='You archive conversations in a Minecraft settlement. Read the transcript and return ONLY JSON '+
  '{"summary":"1-2 sentences: the key outcome, agreement or news","topic_tags":["up to 5 short snake_case topics, e.g. wheat_supply, building_town_hall"]}. Use the names in the transcript.';
const STOP=new Set('the a an and or but to of in on at for with is are was were be it i you we they he she my your our this that so as by from not do did have has had will would can just very all some there here what when how who about get got'.split(' '));
export function normalizeTags(tags){
  const out=[];
  for(const t of Array.isArray(tags)?tags:[]){
    const tag=String(t).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40);
    if(tag.length>=3&&!out.includes(tag))out.push(tag);
    if(out.length>=5)break;
  }
  return out;
}
/** Used when the model cannot help: frequent words as tags, the opening line as the summary. */
export function fallbackSummary(record){
  const counts=new Map();
  for(const m of record.transcript)for(const w of String(m.message).toLowerCase().replace(/[^a-z ]+/g,' ').split(/\s+/))if(w.length>3&&!STOP.has(w))counts.set(w,(counts.get(w)??0)+1);
  const first=record.transcript[0];
  return {summary:first?`${record.participants.join(', ')} talked; ${first.speaker} opened with "${String(first.message).slice(0,120)}"`:'An empty conversation.',
    topic_tags:normalizeTags([...counts].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([w])=>w))};
}
function parseSummary(text){
  const body=String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g,'').replace(/```(?:json)?/g,'');
  const r=JSON.parse(body.slice(body.indexOf('{'),body.lastIndexOf('}')+1));
  const summary=typeof r.summary==='string'?r.summary.replace(/\s+/g,' ').trim().slice(0,400):'';
  if(summary.length<8)throw Error('no summary');
  return {summary,topic_tags:normalizeTags(r.topic_tags??r.tags)};
}
const iso=t=>new Date(t).toISOString();

export function createArchive(db,{logDir,lm,log=()=>{},getSnapshot=()=>null,getTick=()=>({}),nameOf=id=>id,isAgent=()=>false,playerPos=()=>null,
  idleMs=30000,awayBlocks=16,now=()=>Date.now(),isOffline=e=>!!e?.offline}={}){
  const open=new Map(),byKey=new Map();let busy=false;
  const locationOf=ids=>{
    const snap=getSnapshot(),pts=[];
    for(const id of ids){const a=snap?.agents?.find(x=>x.id===id);if(a)pts.push(a);else{const p=playerPos(id);if(p&&Number.isFinite(p.x))pts.push(p);}}
    if(!pts.length)return null;const avg=k=>Math.round(pts.reduce((s,p)=>s+p[k],0)/pts.length);return [avg('x'),avg('y'),avg('z')];
  };
  const join=(c,id)=>{if(!c.participant_ids.includes(id)){c.participant_ids.push(id);c.participants.push(nameOf(id));}};
  function start({kind,participants,key}){
    const t=now(),c={conversation_id:randomUUID(),timestamp:iso(t),tick:getTick(),participants:[],participant_ids:[],location:locationOf(participants),transcript:[],kind,startedAt:t,lastAt:t,key:key??null};
    for(const p of participants)join(c,p);
    open.set(c.conversation_id,c);if(key)byKey.set(key,c.conversation_id);return c.conversation_id;
  }
  function add(id,speaker,message){
    const c=open.get(id);if(!c||!String(message??'').trim())return;
    join(c,speaker);const t=now();
    c.transcript.push({speaker:nameOf(speaker),message:String(message).slice(0,500),timestamp:iso(t)});c.lastAt=t;
    if(!c.location)c.location=locationOf(c.participant_ids);
  }
  /** Ends a conversation and queues it (in the database, so a restart does not lose it) for summarising. */
  function end(id,reason='ended'){
    const c=open.get(id);if(!c)return;
    open.delete(id);if(c.key&&byKey.get(c.key)===id)byKey.delete(c.key);
    if(!c.transcript.length)return;
    const {startedAt,lastAt,key,...record}=c;
    db.run('INSERT OR REPLACE INTO conversation_queue(conversation_id,record_json,tries,queued) VALUES(?,?,0,?)',record.conversation_id,JSON.stringify({...record,ended:iso(lastAt),end_reason:reason}),now());
  }
  const playerKey=p=>`player:${p}`;
  function playerSaid(player,text){let id=byKey.get(playerKey(player));if(!id)id=start({kind:'player',participants:[player],key:playerKey(player)});add(id,player,text);}
  function agentSaidTo(agent,player,text){let id=byKey.get(playerKey(player));if(!id)id=start({kind:'player',participants:[agent,player],key:playerKey(player)});add(id,agent,text);}
  /** Player conversations end after idleMs of silence or when the player and the citizens walk apart. */
  function tick(){
    const t=now(),snap=getSnapshot();
    for(const c of [...open.values()]){
      if(c.kind!=='player')continue;
      if(t-c.lastAt>idleMs){end(c.conversation_id,'inactivity');continue;}
      const player=c.participant_ids.find(p=>!isAgent(p)),pos=player&&playerPos(player);
      const agents=c.participant_ids.filter(isAgent).map(id=>snap?.agents?.find(a=>a.id===id)).filter(Boolean);
      if(pos&&Number.isFinite(pos.x)&&agents.length&&t-c.lastAt>5000&&agents.every(a=>Math.hypot(a.x-pos.x,a.z-pos.z)>awayBlocks))end(c.conversation_id,'walked_away');
    }
  }
  /** Summarises and files the oldest waiting conversation. Returns true when one was filed. */
  async function processOne(){
    if(busy)return false;
    const item=db.get('SELECT * FROM conversation_queue ORDER BY queued LIMIT 1');if(!item)return false;
    if(lm&&lm.online===false)return false;
    busy=true;
    try{
      const record=json(item.record_json);let result,source='model';
      try{result=parseSummary(await lm.callUtilityTask('chat_log_json_parsing',PROMPT,{participants:record.participants,location:record.location,transcript:record.transcript.map(m=>`${m.speaker}: ${m.message}`)}));}
      catch(error){
        if(isOffline(error))return false;
        if(item.tries+1<3){db.run('UPDATE conversation_queue SET tries=tries+1,queued=? WHERE conversation_id=?',now(),item.conversation_id);return false;}
        result=fallbackSummary(record);source='fallback';log('archive_fallback',{id:record.conversation_id,message:error.message});
      }
      const full={...record,...result};
      let file=null;
      if(logDir){
        file=path.join('conversations',full.timestamp.slice(0,10),`${full.conversation_id}.json`);
        const abs=path.join(logDir,file);await mkdir(path.dirname(abs),{recursive:true});
        await writeFile(abs+'.tmp',JSON.stringify(full,null,1),{mode:0o640});await rename(abs+'.tmp',abs);
      }
      db.tx(()=>{
        db.run(`INSERT OR REPLACE INTO conversations(conversation_id,timestamp,day,world_time,kind,participants_json,participant_ids_json,location_json,topic_tags_json,summary,ended,end_reason,lines,file,summary_source)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,full.conversation_id,full.timestamp,full.tick?.day??null,full.tick?.worldTime??null,full.kind,JSON.stringify(full.participants),JSON.stringify(full.participant_ids),
          JSON.stringify(full.location),JSON.stringify(full.topic_tags),full.summary,full.ended,full.end_reason,full.transcript.length,file,source);
        full.transcript.forEach((m,i)=>db.run('INSERT OR REPLACE INTO conversation_lines(conversation_id,seq,speaker,message,timestamp) VALUES(?,?,?,?,?)',full.conversation_id,i,m.speaker,m.message,m.timestamp));
        db.run('DELETE FROM conversation_queue WHERE conversation_id=?',full.conversation_id);
      });
      log('conversation_archived',{id:full.conversation_id,participants:full.participants,tags:full.topic_tags});
      return true;
    }finally{busy=false;}
  }
  const toEntry=r=>({conversation_id:r.conversation_id,timestamp:r.timestamp,day:r.day,kind:r.kind,participants:json(r.participants_json,[]),participant_ids:json(r.participant_ids_json,[]),
    location:json(r.location_json),topic_tags:json(r.topic_tags_json,[]),summary:r.summary,lines:r.lines});
  const involves=(e,who)=>{const w=String(who).toLowerCase();return e.participant_ids.some(p=>String(p).toLowerCase()===w)||e.participants.some(n=>{const l=n.toLowerCase();return l===w||l.split(' ')[0]===w;});};
  /** get_recent_conversations: newest summaries involving a participant, optionally on a topic or keyword. */
  function getRecentConversations(participant,limit=5,{topic,q}={}){
    const kw=q?`%${String(q).toLowerCase()}%`:null,tag=topic?`%"${normalizeTags([topic])[0]??''}"%`:null;
    const rows=db.all(`SELECT * FROM conversations WHERE 1=1 ${participant?"AND (lower(participants_json) LIKE ? OR lower(participant_ids_json) LIKE ?)":''} ${tag?'AND topic_tags_json LIKE ?':''} ${kw?'AND (lower(summary) LIKE ? OR topic_tags_json LIKE ?)':''} ORDER BY timestamp DESC LIMIT ?`,
      ...(participant?[`%${String(participant).toLowerCase()}%`,`%${String(participant).toLowerCase()}%`]:[]),...(tag?[tag]:[]),...(kw?[kw,kw]:[]),limit*3);
    return rows.map(toEntry).filter(e=>!participant||involves(e,participant)).slice(0,limit);
  }
  /** Dashboard and export search: participant, date range (YYYY-MM-DD, inclusive), keyword or tag. */
  function query({participant,from,to,q,limit=50,offset=0}={}){
    const where=[],p=[];
    if(from){where.push('timestamp>=?');p.push(`${from}T00:00:00.000Z`);}
    if(to){where.push('timestamp<=?');p.push(`${to}T23:59:59.999Z`);}
    if(q){where.push('(lower(summary) LIKE ? OR lower(topic_tags_json) LIKE ? OR lower(participants_json) LIKE ?)');const k=`%${String(q).toLowerCase()}%`;p.push(k,k,k);}
    if(participant){where.push('(lower(participants_json) LIKE ? OR lower(participant_ids_json) LIKE ?)');const k=`%${String(participant).toLowerCase()}%`;p.push(k,k);}
    const sql=`FROM conversations ${where.length?'WHERE '+where.join(' AND '):''}`;
    let rows=db.all(`SELECT * ${sql} ORDER BY timestamp DESC`,...p).map(toEntry);
    if(participant)rows=rows.filter(e=>involves(e,participant));
    return {total:rows.length,conversations:rows.slice(offset,offset+limit)};
  }
  function get(id){
    const r=db.get('SELECT * FROM conversations WHERE conversation_id=?',id);if(!r)return null;
    return {...toEntry(r),transcript:db.all('SELECT speaker,message,timestamp FROM conversation_lines WHERE conversation_id=? ORDER BY seq',id)};
  }
  const people=()=>[...new Set(db.all('SELECT participants_json FROM conversations').flatMap(r=>json(r.participants_json,[])))].sort();
  const stats=()=>({archived:db.get('SELECT count(*) n FROM conversations').n,queued:db.get('SELECT count(*) n FROM conversation_queue').n,open:open.size});
  const hasOpen=player=>byKey.has(playerKey(player));
  return {start,add,end,playerSaid,agentSaidTo,hasOpen,tick,processOne,getRecentConversations,query,get,people,stats};
}

/** The Excel workbook: "Summary Index" and "Full Transcripts". */
export function buildWorkbook(records,ExcelJS){
  const wb=new ExcelJS.Workbook();wb.creator='Project SID';wb.created=new Date();
  const index=wb.addWorksheet('Summary Index',{views:[{state:'frozen',ySplit:1}]});
  index.columns=[{header:'Date/Time',key:'time',width:21},{header:'ID',key:'id',width:38},{header:'Participants',key:'who',width:34},
    {header:'Location',key:'where',width:16},{header:'Topic Tags',key:'tags',width:36},{header:'Summary',key:'summary',width:90}];
  const lines=wb.addWorksheet('Full Transcripts',{views:[{state:'frozen',ySplit:1}]});
  lines.columns=[{header:'Conversation ID',key:'id',width:38},{header:'Timestamp',key:'time',width:21},{header:'Speaker',key:'speaker',width:22},{header:'Message',key:'message',width:100}];
  for(const r of records){
    index.addRow({time:new Date(r.timestamp),id:r.conversation_id,who:r.participants.join(', '),where:Array.isArray(r.location)?r.location.join(', '):'',tags:(r.topic_tags??[]).join(', '),summary:r.summary??''});
    for(const m of r.transcript??[])lines.addRow({id:r.conversation_id,time:new Date(m.timestamp),speaker:m.speaker,message:m.message});
  }
  for(const ws of [index,lines]){
    ws.getRow(1).font={bold:true};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE3EAF2'}};
    ws.autoFilter={from:{row:1,column:1},to:{row:1,column:ws.columns.length}};
  }
  index.getColumn('time').numFmt='yyyy-mm-dd hh:mm:ss';lines.getColumn('time').numFmt='yyyy-mm-dd hh:mm:ss';
  index.getColumn('summary').alignment={wrapText:true,vertical:'top'};lines.getColumn('message').alignment={wrapText:true,vertical:'top'};
  return wb;
}
