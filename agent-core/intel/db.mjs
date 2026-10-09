// settlement_intelligence.db: one SQLite database (Node's built-in node:sqlite) for the intelligence stack:
// spatial memories, goal trees, work orders, the social trust matrix, reflections and the conversation archive.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

// node:sqlite is marked experimental in Node 22; keep its one-time warning out of the service log.
const emitWarning=process.emitWarning;
process.emitWarning=(warning,...rest)=>{if(String(warning).includes('SQLite is an experimental feature'))return;return emitWarning.call(process,warning,...rest);};

const SCHEMA=`
CREATE TABLE IF NOT EXISTS spatial_memories(
  memory_id TEXT PRIMARY KEY, observed_by TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  category TEXT NOT NULL, item TEXT, details_json TEXT, text_summary TEXT, tick INTEGER, day INTEGER,
  timestamp INTEGER NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1, stale INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS spatial_by_item ON spatial_memories(category,item);
CREATE INDEX IF NOT EXISTS spatial_by_time ON spatial_memories(timestamp);

CREATE TABLE IF NOT EXISTS agent_goals(
  goal_id TEXT PRIMARY KEY, agent TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, spec_json TEXT, source TEXT, attempts INTEGER NOT NULL DEFAULT 0, replans INTEGER NOT NULL DEFAULT 0,
  failure TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS goals_by_agent ON agent_goals(agent,status);
CREATE INDEX IF NOT EXISTS goals_by_parent ON agent_goals(parent_id,seq);

CREATE TABLE IF NOT EXISTS work_orders(
  order_id TEXT PRIMARY KEY, number INTEGER NOT NULL, issuer_name TEXT NOT NULL, contractor_name TEXT, order_type TEXT NOT NULL,
  target_item TEXT, quantity INTEGER NOT NULL DEFAULT 1, delivered INTEGER NOT NULL DEFAULT 0, target_location TEXT,
  reward_emeralds INTEGER NOT NULL DEFAULT 0, upfront_paid INTEGER NOT NULL DEFAULT 0, priority TEXT NOT NULL, status TEXT NOT NULL,
  note TEXT, goal_id TEXT, created INTEGER NOT NULL, claimed_at INTEGER, deadline INTEGER, updated INTEGER NOT NULL, history_json TEXT);
CREATE INDEX IF NOT EXISTS orders_by_status ON work_orders(status);

CREATE TABLE IF NOT EXISTS social_matrix(
  source_agent TEXT NOT NULL, target_agent TEXT NOT NULL, trust_score REAL NOT NULL, reliability_score REAL NOT NULL,
  affinity_label TEXT NOT NULL, last_updated INTEGER NOT NULL, PRIMARY KEY(source_agent,target_agent));
CREATE TABLE IF NOT EXISTS social_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_agent TEXT, target_agent TEXT, kind TEXT, trust_delta REAL, reliability_delta REAL, note TEXT, time INTEGER);

CREATE TABLE IF NOT EXISTS reflections(
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, subject TEXT, action_json TEXT, error_type TEXT, error TEXT, goal TEXT,
  attempt INTEGER, reflection TEXT, corrective_json TEXT, outcome TEXT, source TEXT, time INTEGER);

CREATE TABLE IF NOT EXISTS conversations(
  conversation_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, day INTEGER, world_time INTEGER, kind TEXT,
  participants_json TEXT NOT NULL, participant_ids_json TEXT NOT NULL, location_json TEXT, topic_tags_json TEXT, summary TEXT,
  ended TEXT, end_reason TEXT, lines INTEGER, file TEXT, summary_source TEXT);
CREATE INDEX IF NOT EXISTS conversations_by_time ON conversations(timestamp);
CREATE TABLE IF NOT EXISTS conversation_lines(
  conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, speaker TEXT, message TEXT, timestamp TEXT, PRIMARY KEY(conversation_id,seq));
CREATE TABLE IF NOT EXISTS conversation_queue(conversation_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, queued INTEGER NOT NULL);

-- Intrinsic motivation engine (motivation.mjs)
CREATE TABLE IF NOT EXISTS novelty(
  agent TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, x INTEGER, z INTEGER,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(agent,kind,key));
CREATE INDEX IF NOT EXISTS novelty_by_key ON novelty(kind,key);
CREATE TABLE IF NOT EXISTS forward_model(
  agent TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, p REAL NOT NULL, ms REAL, updated INTEGER NOT NULL, PRIMARY KEY(agent,key));
CREATE TABLE IF NOT EXISTS social_bonds(
  source TEXT NOT NULL, target TEXT NOT NULL, familiarity REAL NOT NULL DEFAULT 0, shared_history REAL NOT NULL DEFAULT 0,
  alignment REAL NOT NULL DEFAULT 0, updated INTEGER NOT NULL, PRIMARY KEY(source,target));
CREATE TABLE IF NOT EXISTS bond_votes(proposal TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY(proposal,a,b));
CREATE TABLE IF NOT EXISTS memes(
  agent TEXT NOT NULL, meme_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, strength REAL NOT NULL,
  origin TEXT, via TEXT, first_at INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(agent,meme_id));
CREATE INDEX IF NOT EXISTS memes_by_id ON memes(meme_id);
CREATE TABLE IF NOT EXISTS motivation_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, drive TEXT, kind TEXT, detail TEXT, utility REAL, time INTEGER);

CREATE TABLE IF NOT EXISTS relationship_marks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_agent TEXT NOT NULL, target_agent TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT, impact REAL NOT NULL, time INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS marks_by_pair ON relationship_marks(source_agent,target_agent);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

/** Opens (and creates or upgrades) the database; ':memory:' for tests. */
export function openDatabase(file){
  if(file!==':memory:')mkdirSync(path.dirname(file),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');
  db.exec(SCHEMA);
  const cache=new Map();
  const prep=sql=>{let s=cache.get(sql);if(!s){s=db.prepare(sql);cache.set(sql,s);}return s;};
  return {
    raw:db,
    run:(sql,...p)=>prep(sql).run(...p),
    get:(sql,...p)=>prep(sql).get(...p),
    all:(sql,...p)=>prep(sql).all(...p),
    tx(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
    meta(key,value){if(value===undefined)return prep('SELECT value FROM meta WHERE key=?').get(key)?.value;prep('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));},
    close:()=>db.close(),
  };
}
export const json=(v,fallback=null)=>{if(v==null)return fallback;try{return JSON.parse(v);}catch{return fallback;}};
