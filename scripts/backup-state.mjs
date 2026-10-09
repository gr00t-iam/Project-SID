#!/usr/bin/env node
// Backs up everything the agent runtime needs to come back as it was:
//   memory.json                     the town, citizens, bank, court, life sim (written with debounced saves)
//   settlement_intelligence.db      SQLite (WAL mode): goals, work orders, trust, grudges, conversations, motivation
//   data/logs/                      conversation transcripts
//   config/ (without runtime.env)   agents, village lots, plugin config copy
// The database is copied with VACUUM INTO, a consistent snapshot of a live WAL database (a plain cp of the .db file
// misses whatever is still in the -wal file), and the copy is checked with PRAGMA integrity_check before it is kept.
// Output: <dest>/sid-state-YYYYMMDD-HHMMSS.tgz; the newest KEEP archives are kept.
//   node scripts/backup-state.mjs [--dest /root/sid-backups] [--keep 28]
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,copyFileSync,mkdirSync,readdirSync,rmSync,existsSync,statSync,cpSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const STATE=process.env.STATE_DIR||'/var/lib/sid-local',APP=process.env.APP_DIR||'/opt/sid-local';
const DEST=arg('--dest','/root/sid-backups'),KEEP=Number(arg('--keep',28));
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
const work=mkdtempSync(path.join(os.tmpdir(),'sid-backup-')),root=path.join(work,'sid-state');
mkdirSync(root,{recursive:true});mkdirSync(DEST,{recursive:true,mode:0o700});
try{
  // 1. The database: a consistent snapshot, verified.
  const dbFile=path.join(STATE,'settlement_intelligence.db'),dbCopy=path.join(root,'settlement_intelligence.db');
  const db=new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`VACUUM INTO '${dbCopy.replace(/'/g,"''")}'`);
  db.close();
  const check=new DatabaseSync(dbCopy,{readOnly:true});
  const ok=check.prepare('PRAGMA integrity_check').get();const orders=check.prepare('SELECT count(*) n FROM work_orders').get().n;
  check.close();
  if(Object.values(ok)[0]!=='ok')throw Error(`database copy failed integrity_check: ${JSON.stringify(ok)}`);
  // 2. memory.json (copied after the database: both are within seconds of each other).
  copyFileSync(path.join(STATE,'memory.json'),path.join(root,'memory.json'));
  const memory=JSON.parse(readFileSync(path.join(root,'memory.json'),'utf8'));if(!memory.agents||!memory.town)throw Error('memory.json copy is not a town state');
  // 3. Conversation logs and config (never the secrets in runtime.env).
  if(existsSync(path.join(STATE,'data')))cpSync(path.join(STATE,'data'),path.join(root,'data'),{recursive:true});
  cpSync(path.join(APP,'config'),path.join(root,'config'),{recursive:true,filter:src=>!/runtime\.env/.test(path.basename(src))});
  // 4. One archive, then retention.
  const out=path.join(DEST,`sid-state-${stamp}.tgz`);
  execFileSync('tar',['czf',out,'-C',work,'sid-state']);
  const kept=readdirSync(DEST).filter(f=>/^sid-state-\d{8}-\d{6}\.tgz$/.test(f)).sort().reverse();
  for(const f of kept.slice(KEEP))rmSync(path.join(DEST,f));
  console.log(JSON.stringify({ok:true,archive:out,bytes:statSync(out).size,workOrders:orders,kept:Math.min(kept.length,KEEP)}));
}finally{rmSync(work,{recursive:true,force:true});}
