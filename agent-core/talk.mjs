// Conversation memory: what each agent has said, learned and discussed with whom, so conversations
// build on the past instead of repeating it. Pure helpers (unit-tested); life.mjs and main.mjs keep the state.

const STOP=new Set('the a an and or but to of in on at for with is are was were be been it its i you we they he she my your our their me us them this that these those so as by from not no yes do did have has had will would can could just too very all any some there here what when how who oh ah hey well'.split(' '));
const words=t=>String(t).toLowerCase().replace(/[^a-z0-9' ]+/g,' ').split(/\s+/).filter(Boolean);

/** Rough similarity of two sentences (share of distinct content words in common). */
export function similarity(a,b){
  const A=new Set(words(a).filter(w=>!STOP.has(w))),B=new Set(words(b).filter(w=>!STOP.has(w)));
  if(!A.size||!B.size)return 0;
  let common=0;for(const w of A)if(B.has(w))common++;
  return common/Math.min(A.size,B.size);
}
/** Adds a memory unless a near-duplicate is already there (then that one is refreshed); keeps the newest `max`. */
export function addMemory(list,item,max=20){
  const text=String(item.text??'').trim();if(text.length<4)return list;
  const dupe=list.findIndex(m=>similarity(m.text,text)>=0.7);
  const next=dupe>=0?[...list.slice(0,dupe),...list.slice(dupe+1),{...list[dupe],...item,text,time:item.time??Date.now()}]:[...list,{...item,text,time:item.time??Date.now()}];
  return next.slice(-max);
}
/**
 * Phrases (2 to 4 words) that keep turning up in recent lines, most used first: these read as stock phrases.
 * Phrases made only of filler words are ignored.
 */
export function overusedPhrases(lines,min=3,limit=12){
  const counts=new Map();
  for(const line of lines){
    const w=words(line),seen=new Set();
    for(const n of [2,3,4])for(let i=0;i+n<=w.length;i++){
      const gram=w.slice(i,i+n);
      if(gram.filter(x=>!STOP.has(x)).length<2)continue;
      const k=gram.join(' ');if(seen.has(k))continue;seen.add(k);
      counts.set(k,(counts.get(k)??0)+1);
    }
  }
  // Drop 3-word phrases already covered by a 4-word one that is just as common.
  const list=[...counts].filter(([,n])=>n>=min).sort((a,b)=>b[1]-a[1]||b[0].length-a[0].length);
  const out=[];
  for(const [k,n] of list)if(!out.some(o=>o.phrase.includes(k)&&o.n>=n))out.push({phrase:k,n});
  return out.slice(0,limit).map(o=>o.phrase);
}
/** How a line opens (first three words), to spot agents who start every conversation the same way. */
export const openerOf=line=>words(line).slice(0,3).join(' ');

// Everyday topics; role topics make a smith talk shop and a herbalist talk plants.
const EVERYDAY=['a memory from before the town was founded','something funny that happened recently','a small worry they have','what they would do with a free day',
  'a favourite spot in or around town','food they miss or crave','a dream they had','an opinion about how the town is run','a skill they want to learn',
  'something they noticed about a neighbour','the sounds of the town at night','a disagreement they had once and how it ended','a hobby or a collection',
  'what the season makes them think of','a place beyond the town they want to see','a small kindness someone did for them'];
const ROLE_TOPICS={builder:['a design idea for the next building','materials they wish they had'],guardian:['a close call on watch','how to keep the town safe'],
  miner:['something strange found underground','the deep tunnels'],farmer:['the crops and the soil','an animal on the farm'],merchant:['a bargain or a bad deal','prices at the warehouse'],
  crafter:['a clever contraption','a tool they are proud of'],governor:['a decision that was hard','what the council should vote on'],scribe:['an old story worth writing down','how the town has changed'],
  fisher:['the lake and the fish','a trip to the woods'],courier:['the fastest route through town','news picked up on the rounds'],smith:['the forge and good steel','a worn-out tool they fixed'],
  herbalist:['a plant and what it cures','someone who looked unwell']};
/**
 * Picks a topic for two agents: a follow-up on something left open, gossip one of them learned, fresh news few have
 * discussed, a role topic or an everyday one - never one this pair or the town talked about recently.
 */
export function pickTopic({a,b,pair={},recentTopics=[],news=[],newsUse={},learned=[],rand=Math.random}){
  const recent=[...(pair.topics??[]),...recentTopics.slice(-12)];
  const fresh=t=>!recent.some(r=>similarity(r,t)>=0.6);
  const options=[];
  if(pair.followUp&&fresh(pair.followUp))options.push({topic:`follow up on: ${pair.followUp}`,weight:4});
  for(const l of learned.slice(-4))if(fresh(l.text))options.push({topic:`something ${l.by} learned: ${l.text}`,weight:2});
  for(const n of news.slice(-10))if((newsUse[n]??0)<2&&fresh(n))options.push({topic:`town gossip: ${n}`,weight:1.5/(1+(newsUse[n]??0))});
  for(const t of [...(ROLE_TOPICS[a.role]??[]),...(ROLE_TOPICS[b.role]??[])])if(fresh(t))options.push({topic:t,weight:1.2});
  for(const t of EVERYDAY)if(fresh(t))options.push({topic:t,weight:1});
  if(!options.length)return EVERYDAY[Math.floor(rand()*EVERYDAY.length)];
  let r=rand()*options.reduce((s,o)=>s+o.weight,0);
  for(const o of options){r-=o.weight;if(r<=0)return o.topic;}
  return options.at(-1).topic;
}
/** A fresh per-agent conversation memory. */
export const newTalk=()=>({said:[],learned:[],pairs:{},players:{}});
/** What an agent brings into a conversation with `other` (another agent id or a player name). */
export function recall(talk,other,isPlayer=false){
  const t=talk??newTalk(),p=(isPlayer?t.players:t.pairs)[other]??{};
  return {
    pastTalks:(p.notes??[]).slice(-4).map(n=>n.text),
    openThread:p.followUp??undefined,
    learnedRecently:t.learned.slice(-5).map(l=>`${l.text}${l.from?` (from ${l.from})`:''}`),
    recentlySaid:t.said.slice(-8),
  };
}
