// Module 1: spatial and semantic memory. Agents remember where things are: ore, trees, herbs, crops,
// chests (and what is in them), monster sightings and buildings. Observations come from what each agent
// sees around it (the plugin's snapshot of nearby blocks and entities) and from events (mining, farming,
// the warehouse stock check, finished buildings). Queries rank by distance and recency.
import {randomUUID} from 'node:crypto';
import {json} from './db.mjs';

const FLOWERS=['POPPY','DANDELION','CORNFLOWER','OXEYE_DAISY','AZURE_BLUET','ALLIUM','LILY_OF_THE_VALLEY','RED_TULIP','ORANGE_TULIP','WHITE_TULIP','PINK_TULIP','BLUE_ORCHID'];
const CROPS={WHEAT:'WHEAT',CARROTS:'CARROT',POTATOES:'POTATO',BEETROOTS:'BEETROOT',PUMPKIN:'PUMPKIN',MELON:'MELON'};
/** What a block means to a villager: {category, item} or null for uninteresting blocks. */
export function classifyBlock(type){
  const t=String(type).toUpperCase();
  if(/_ORE$/.test(t)||t==='ANCIENT_DEBRIS')return {category:'ore',item:t.replace(/^DEEPSLATE_/,'').replace(/_ORE$/,'')};
  if(/_LOG$/.test(t)&&!/^STRIPPED_/.test(t))return {category:'tree',item:t};
  if(FLOWERS.includes(t)||['SWEET_BERRY_BUSH','SUGAR_CANE','RED_MUSHROOM','BROWN_MUSHROOM','PUMPKIN','MELON'].includes(t))return {category:'plant',item:t};
  if(CROPS[t])return {category:'farm',item:CROPS[t]};
  if(['CHEST','BARREL','TRAPPED_CHEST'].includes(t))return {category:'chest',item:t};
  return null;
}
// How close two sightings must be to count as the same thing.
const SAME={ore:4,tree:5,plant:5,farm:8,chest:0,mob:12,structure:6};
// Words people use for things, mapped to categories and item patterns (SQL LIKE).
const WORDS=[
  [/\bcoal\b/,['ore'],['COAL']],[/\biron\b/,['ore','chest'],['IRON','RAW_IRON','IRON_INGOT']],[/\bcopper\b/,['ore','chest'],['COPPER']],[/\bgold\b/,['ore','chest'],['GOLD']],
  [/\bdiamonds?\b/,['ore','chest'],['DIAMOND']],[/\bredstone\b/,['ore','chest'],['REDSTONE']],[/\blapis\b/,['ore'],['LAPIS']],[/\bemeralds?\b/,['ore','chest'],['EMERALD']],
  [/\b(ores?|minerals?)\b/,['ore'],[]],[/\b(wood|logs?|trees?|timber|lumber)\b/,['tree','chest'],['%_LOG','%_PLANKS']],
  [/\bwheat\b/,['farm','chest'],['WHEAT']],[/\bcarrots?\b/,['farm','chest'],['CARROT']],[/\bpotato(es)?\b/,['farm','chest'],['POTATO']],[/\bbeet(root)?s?\b/,['farm'],['BEETROOT']],
  [/\b(crops?|farms?|fields?)\b/,['farm'],[]],[/\b(flowers?|herbs?)\b/,['plant'],FLOWERS],[/\bberr(y|ies)\b/,['plant','chest'],['SWEET_BERR%']],
  [/\b(cane|sugar)\b/,['plant','chest'],['SUGAR%']],[/\bmushrooms?\b/,['plant'],['%MUSHROOM']],[/\bpumpkins?\b/,['plant','farm'],['PUMPKIN']],
  [/\b(food|bread|meal)\b/,['chest'],['BREAD','COOKED_%','BAKED_POTATO']],[/\b(chests?|storage|stock|warehouse)\b/,['chest'],[]],
  [/\b(mobs?|monsters?|hostiles?|zombies?|skeletons?|creepers?|spiders?|danger)\b/,['mob'],[]],[/\b(buildings?|structures?|house|hall|tower)\b/,['structure'],[]],
  [/\b(cobble(stone)?|stone)\b/,['chest'],['COBBLESTONE','STONE%']],
];
/** Turns free text ("where can I find iron?") into categories and item patterns. */
export function parseQuery(text){
  const q=String(text??'').toLowerCase(),cats=new Set(),items=new Set();
  for(const [re,c,i] of WORDS)if(re.test(q)){c.forEach(x=>cats.add(x));i.forEach(x=>items.add(x));}
  // Exact item names (IRON_ORE, OAK_LOG) are taken literally.
  for(const w of String(text??'').toUpperCase().match(/\b[A-Z]+(_[A-Z]+)+\b/g)??[])items.add(w.replace(/_ORE$/,''));
  return {categories:[...cats],items:[...items],words:q.split(/\W+/).filter(w=>w.length>3)};
}
/** Rank: nearer and fresher is better; an agent trusts its own eyes a little more; seen often = reliable. */
export function score(m,{from,now,self}){
  const d=from?Math.hypot(m.x-from.x,m.z-from.z):0,ageMin=(now-m.timestamp)/60000;
  return d/8+ageMin/30-(m.observed_by===self?1:0)-Math.min(2,Math.log2(m.seen_count||1)*0.5);
}

export function createSpatial(db,{now=()=>Date.now(),log=()=>{},getTick=()=>({}),HOSTILE=new Set()}={}){
  let lastScan=new Map();
  /** Records (or refreshes) an observation; near-identical sightings are merged. */
  function record({observed_by,x,y,z,category,item=null,details=null,summary=null}){
    if(![x,y,z].every(Number.isFinite))return null;
    x=Math.floor(x);y=Math.floor(y);z=Math.floor(z);
    const r=SAME[category]??4,t=now(),tick=getTick();
    const near=db.get(`SELECT * FROM spatial_memories WHERE category=? AND ${item?'item=?':'item IS NULL'} AND abs(x-?)<=? AND abs(z-?)<=? AND abs(y-?)<=8 ORDER BY abs(x-?)+abs(z-?) LIMIT 1`,
      ...[category,...(item?[item]:[]),x,r,z,r,y,x,z]);
    const text=summary??`${category}${item?` ${item.toLowerCase().replace(/_/g,' ')}`:''} at ${x},${y},${z}`;
    if(near){
      const merged=details?JSON.stringify({...json(near.details_json,{}),...details}):near.details_json;
      db.run('UPDATE spatial_memories SET timestamp=?,tick=?,day=?,seen_count=seen_count+1,stale=0,details_json=?,text_summary=?,observed_by=? WHERE memory_id=?',
        t,tick.worldTime??null,tick.day??null,merged,text,observed_by,near.memory_id);
      return near.memory_id;
    }
    const id=randomUUID();
    db.run('INSERT INTO spatial_memories(memory_id,observed_by,x,y,z,category,item,details_json,text_summary,tick,day,timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id,observed_by,x,y,z,category,item,details?JSON.stringify(details):null,text,tick.worldTime??null,tick.day??null,t);
    return id;
  }
  /** Looks at what each agent can see (nearby blocks and entities), at most every 15 s per agent. */
  function observeSnapshot(snap,{built=()=>[]}={}){
    const inBuilding=(x,z)=>built().some(f=>x>=f.x1&&x<=f.x2&&z>=f.z1&&z<=f.z2);
    if(!snap?.agents)return 0;
    let n=0;const t=now();
    for(const a of snap.agents){
      if(t-(lastScan.get(a.id)??0)<15000)continue;lastScan.set(a.id,t);
      const found=new Map();
      for(const b of a.blocks??[]){if(b.placed)continue;const c=classifyBlock(b.type);if(!c||c.category==='chest')continue;if(c.category==='tree'&&inBuilding(b.x,b.z))continue;const k=`${c.category}:${c.item}`;if(!found.has(k))found.set(k,b);}
      for(const [k,b] of found){const c=classifyBlock(b.type);record({observed_by:a.id,x:b.x,y:b.y,z:b.z,...c});n++;}
      const mobs=(a.entities??[]).filter(e=>HOSTILE.has(e.type));
      for(const m of mobs.slice(0,3)){record({observed_by:a.id,x:m.x,y:m.y,z:m.z,category:'mob',item:m.type,details:{lastSeen:new Date(t).toISOString()},
        summary:`${m.type.toLowerCase()} seen at ${Math.floor(m.x)},${Math.floor(m.y)},${Math.floor(m.z)}`});n++;}
    }
    return n;
  }
  /** Warehouse chests and their contents (from the stock check). */
  function observeChests(observer,chests){
    for(const c of chests??[]){
      const top=Object.entries(c.items??{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
      record({observed_by:observer,x:c.x,y:c.y,z:c.z,category:'chest',item:c.name?c.name.toUpperCase().replace(/\W+/g,'_'):'CHEST',details:{items:c.items??{},free:c.free??null,name:c.name??null},
        summary:`${c.name?`"${c.name}" `:''}chest at ${c.x},${c.y},${c.z}: ${top.map(([k,v])=>`${v} ${k.toLowerCase()}`).join(', ')||'empty'}`});
    }
  }
  /** A resource used up where it was remembered (walked there, nothing left). */
  const markStale=id=>db.run('UPDATE spatial_memories SET stale=1 WHERE memory_id=?',id);
  /**
   * query_spatial_memory: the best matches for free text (e.g. "coal", "wood", "food chest"), nearest and
   * freshest first. from = where the asker stands; radius limits the distance.
   */
  function query(agent,queryText,maxResults=3,radius=null,{from=null,category=null}={}){
    const q=parseQuery(queryText),cats=category?[category]:q.categories;
    const where=['stale=0'],params=[];
    if(cats.length){where.push(`category IN (${cats.map(()=>'?').join(',')})`);params.push(...cats);}
    if(q.items.length){
      const likes=q.items.map(()=>'(item LIKE ? OR (category=\'chest\' AND details_json LIKE ?))');
      where.push(`(${likes.join(' OR ')})`);for(const i of q.items)params.push(i,`%"${i.replace(/%/g,'')}%`);
    }else if(!cats.length&&q.words.length){
      where.push(`(${q.words.map(()=>'text_summary LIKE ?').join(' OR ')})`);params.push(...q.words.map(w=>`%${w}%`));
    }
    let rows=db.all(`SELECT * FROM spatial_memories WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT 400`,...params);
    if(radius&&from)rows=rows.filter(m=>Math.hypot(m.x-from.x,m.z-from.z)<=radius);
    // Chests only count if they actually hold one of the asked-for items.
    if(q.items.length)rows=rows.filter(m=>m.category!=='chest'||Object.entries(json(m.details_json,{}).items??{}).some(([k,v])=>v>0&&q.items.some(i=>new RegExp(`^${i.replace(/%/g,'.*')}`).test(k))));
    const t=now();
    return rows.map(m=>({...m,score:score(m,{from,now:t,self:agent})})).sort((a,b)=>a.score-b.score).slice(0,maxResults).map(m=>({
      memory_id:m.memory_id,category:m.category,item:m.item,x:m.x,y:m.y,z:m.z,observed_by:m.observed_by,seen:m.seen_count,
      distance:from?Math.round(Math.hypot(m.x-from.x,m.z-from.z)):null,age_minutes:Math.round((t-m.timestamp)/60000),summary:m.text_summary,details:json(m.details_json)}));
  }
  const all=({category,limit=500}={})=>db.all(`SELECT memory_id,observed_by,x,y,z,category,item,text_summary,seen_count,timestamp FROM spatial_memories WHERE stale=0 ${category?'AND category=?':''} ORDER BY timestamp DESC LIMIT ?`,...(category?[category,limit]:[limit]));
  const counts=()=>db.all('SELECT category,count(*) n FROM spatial_memories WHERE stale=0 GROUP BY category');
  /** Forget mob sightings after a day and anything unseen for a week. */
  function prune(){db.run("DELETE FROM spatial_memories WHERE (category='mob' AND timestamp<?) OR timestamp<?",now()-86400000,now()-7*86400000);}
  /** One-time clean-up of tree memories recorded before placed blocks were flagged (logs in walls). */
  function resetTrees(){if(db.meta('trees_reset_v2'))return 0;const n=db.run("DELETE FROM spatial_memories WHERE category='tree'").changes;db.meta('trees_reset_v2','1');return n;}
  return {record,observeSnapshot,observeChests,markStale,query,all,counts,prune,resetTrees};
}
