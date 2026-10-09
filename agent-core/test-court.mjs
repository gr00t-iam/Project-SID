// The courthouse and Judge Thaddeus end to end, on the real order board (in-memory sqlite), the real court
// (skills/justice.mjs), the real judge (roles/judge.mjs) and the real bank, with a scripted town and a clock we move:
//   1. FILE_CASE      Hazel's order for 32 oak logs is claimed by Barnaby, who delivers 10 and misses the deadline;
//                     the order board's sweep hands it to the court and Hazel files a contract case
//   2. CALL_COURT     two minutes before the trial Judge Thaddeus calls the court: Hazel, Barnaby and the sheriff are
//                     summoned to their stands in the courthouse; the judge walks to the bench
//   3. EVALUATE       at the hour the parties are heard; the ledger shows 10/32 delivered - Barnaby's claim to have
//                     delivered everything is caught as false testimony
//   4. VERDICT        GUILTY: a fine of 5 emeralds to Hazel, paid through the bank (a FINE entry, untaxed)
//   5. ADJOURN        the summons are lifted, the case is RESOLVED and the judge is IDLE again
// plus: an unpaid fine stays on the court's ledger and is collected once the account has money; a delivered order is
// not a breach (NOT_GUILTY); a detention goes to a courthouse holding cell, worked by its lever.
//   node agent-core/test-court.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {openDatabase} from './intel/db.mjs';
import {createBoard} from './intel/orders.mjs';
import {createJustice,weighContract,sentenceFor} from './skills/justice.mjs';
import {createJudge,CALL_AHEAD} from './roles/judge.mjs';
import {createBank,emptyBank} from './skills/banking.mjs';
import {courthouseLayout,blueprint} from './blueprints.mjs';

const CONFIGS=[
  {id:'judge',role:'judge',name:'Judge Thaddeus'},{id:'sheriff',role:'sheriff',name:'Sheriff Wade Harlan'},
  {id:'farmer',role:'farmer',name:'Hazel the Farmer'},{id:'courier',role:'courier',name:'Barnaby the Runner'},
  {id:'governor',role:'governor',name:'Governor Elia'},{id:'banker',role:'banker',name:'Finneas the Vault Keeper'},
];

export async function simulate({seed=11}={}){
  const failures=[],check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=Date.parse('2026-10-03T14:00:00Z');const now=()=>t;
  let s=seed,lie=true;const random=()=>lie?0.99:((s=(s*16807)%2147483647)/2147483647);   // 0.99: a reluctant plaintiff lets it go, a defendant lies
  const db=openDatabase(':memory:'),board=createBoard(db,{now});
  const said=[],acts=[],logs=[];
  const site={x:247,y:68,z:90},room=courthouseLayout(site);
  // Everyone far from the courthouse; travel moves them there at once.
  const snap={worldTime:6000,agents:[{id:'judge',x:280,y:69,z:100},{id:'sheriff',x:281,y:69,z:98},{id:'farmer',x:276,y:69,z:96},
    {id:'courier',x:300,y:69,z:110},{id:'governor',x:263,y:69,z:62},{id:'banker',x:294,y:69,z:84}]};
  const pos=id=>snap.agents.find(a=>a.id===id);
  const travel=async(id,self,p)=>{Object.assign(pos(id),{x:p.x,z:p.z,y:p.y??pos(id).y});};
  const act=async(id,a)=>{acts.push({id,...a});if(a.type==='confine')Object.assign(pos(id),{x:a.x,y:a.y,z:a.z});if(a.type==='survey')return {heights:[67]};return {ok:true};};
  const say=async(id,text)=>{said.push(`${id}: ${text}`);};
  const log=(type,data)=>logs.push({type,...data});
  const nameOf=id=>CONFIGS.find(c=>c.id===id)?.name.split(' the ')[0]??id;
  const memory={data:{town:{day:310,conflicts:[],built:{courthouse:true},sites:{courthouse:site}},agents:{}}};
  // The bank, with a vault that just counts.
  let vault=0;const bankState=emptyBank();
  const bank=createBank(bankState,{now,physical:async({op,count})=>{if(op==='count')return {vault};if(op==='mint'){vault+=count;return {};}return {};},retryMs:1});
  await bank.mint(40);await bank.payWage('courier',20,{memo:'wages',taxFree:true});
  const collectFine=async(debtor,creditor,amount,memo)=>{const n=Math.min(amount,bank.balance(debtor).balance);if(n<1)return {paid:0};
    await bank.transfer(debtor,creditor??'~town',n,{memo,kind:'fine'});return {paid:n};};
  const justice=createJustice({memory,configs:CONFIGS,act,say,log,nameOf,getSnapshot:()=>snap,now,random,quests:()=>null,
    valuesOf:()=>({community:0.3,tradition:0.8,selfPreservation:0.6}),trust:()=>50,trialDelayMs:300000,square:{x:283.5,z:93.5},
    courtLayout:()=>room,courtPlace:()=>({x:room.bench.x,z:room.bench.z}),collectFine});
  const judge=createJudge({memory,configs:CONFIGS,act,say,log,ledger:()=>{},getSnapshot:()=>snap,travel,justice:()=>justice,nameOf,now,
    courtLayout:()=>room});
  const run=async id=>{const c=CONFIGS.find(x=>x.id===id),j=judge.job(c,{},pos(id));if(j)await j();return !!j;};

  // ---------- 1. FILE_CASE ----------
  const order=board.post({issuer:'farmer',item:'OAK_LOG',quantity:32,reward:6,note:'logs for the barn'});
  board.claim(order.order_id,'courier');board.progress(order.order_id,10,'courier');
  t+=31*60000;   // past the deadline
  const overdue=board.sweep();
  check(overdue.length===1&&overdue[0].contractor_name==='courier'&&overdue[0].delivered===10,'the sweep finds the overdue order with its record');
  check(justice.considerContract(overdue[0])===null,'on a high draw Hazel lets it go (the decision follows her values)');
  const c=justice.considerContract(overdue[0],{force:true});
  check(!!c&&c.kind==='contract'&&c.party_a==='farmer'&&c.party_b==='courier','Hazel files a contract case against Barnaby');
  const filed=logs.find(l=>l.type==='case_filed');
  check(filed&&filed.conflict_id===c.conflict_id&&filed.charge_type==='contract'&&filed.evidence_pointers[0]===`order #${order.number}`&&filed.status==='OPEN','the docket entry has case_id, parties, charge_type, evidence pointers and status');
  check(c.evidence.filter(e=>e.kind==='record').length===2,'the order board record is on file as evidence');
  check(justice.considerContract(overdue[0])===null,'the same order is not filed twice');

  // ---------- 2. CALL_COURT ----------
  check(!(await run('judge')),'far from the hour: the judge reviews the docket and carries on with the day');
  check(memory.data.town.court.state==='REVIEW_DOCKET','REVIEW_DOCKET');
  t=c.trial.at-CALL_AHEAD+1000;
  await run('judge');
  check(memory.data.town.court.state==='SUMMON_COURT','SUMMON_COURT two minutes before the hour');
  check(said.some(l=>l.startsWith('judge: The court is called')&&l.includes('Hazel')&&l.includes('Barnaby')),'the summons is announced');
  const sh=justice.summonsFor('sheriff'),pl=justice.summonsFor('farmer'),df=justice.summonsFor('courier');
  check(pl?.role==='plaintiff'&&df?.role==='defendant'&&sh?.role==='sheriff','plaintiff, defendant and sheriff are summoned');
  check(df.stand.x===room.stands.defendant.x&&df.stand.z===room.stands.defendant.z,'the defendant has the defendant\'s stand in the courthouse');
  check(justice.summonsFor('governor')===null,'nobody else is summoned');
  check(Math.hypot(pos('judge').x-room.bench.x,pos('judge').z-room.bench.z)<1,'the judge walked to the bench');
  // The summoned walk to their stands (main's court job: travel to the stand).
  for(const id of ['farmer','courier','sheriff'])await travel(id,pos(id),justice.summonsFor(id).stand);
  check(Object.values(justice.attendance()).every(a=>a.present),'everyone summoned is present');
  await run('judge');
  check(!c.trial.held,'the court waits for the hour');

  // ---------- 3. + 4. EVALUATE and VERDICT ----------
  t=c.trial.at+1000;
  const before={hazel:bank.balance('farmer').balance,barnaby:bank.balance('courier').balance};
  await run('judge');
  check(c.trial.held&&c.trial.magistrate==='judge','Judge Thaddeus held the trial');
  check(c.evidence.some(e=>e.kind==='statement'&&e.by==='courier')&&c.evidence.some(e=>e.kind==='statement'&&e.by==='farmer'),'both parties were heard in court');
  check(c.evidence.filter(e=>e.kind==='attendance').length===3,'attendance is on the record');
  check(c.verdict.verdict==='GUILTY'&&c.verdict.guilty==='courier','GUILTY: Barnaby');
  check(c.verdict.findings.some(f=>/10\/32/.test(f)),'the finding cites the ledger: 10/32 delivered');
  check(c.verdict.falseTestimony&&c.verdict.findings.some(f=>/false testimony/.test(f)),'Barnaby\'s claim to have delivered everything is caught as false testimony');
  check(c.verdict.fine===5&&c.verdict.payee==='farmer','a fine of 5 emeralds to Hazel');
  const after={hazel:bank.balance('farmer').balance,barnaby:bank.balance('courier').balance};
  check(after.barnaby===before.barnaby-5&&after.hazel===before.hazel+5,`the bank moved 5 emeralds from Barnaby to Hazel (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
  check(bankState.accounts.farmer.transaction_history.some(x=>x.type==='FINE'&&x.amount===5),'Hazel\'s account shows a FINE entry, untaxed');
  check(said.some(l=>/Order in the court/.test(l))&&acts.some(a=>a.type==='effect'&&a.target==='gavel'),'order in the court, and the gavel');

  // ---------- 5. ADJOURN ----------
  check(justice.summonsFor('courier')===null&&!justice.state.summons,'the summons are lifted');
  check(memory.data.town.court.state==='IDLE','the judge is IDLE again');
  check(said.some(l=>/Court is adjourned/.test(l)),'court is adjourned');
  // Lying got him community service as well: the case stays TRIED until it is served.
  check(c.status==='TRIED'||c.status==='RESOLVED','the case is tried');

  // ---------- an unpaid fine: on the court's ledger, collected later ----------
  lie=false;s=seed;
  const o2=board.post({issuer:'farmer',item:'WHEAT',quantity:16,reward:3});board.claim(o2.order_id,'courier');
  t+=31*60000;const od2=board.sweep()[0];
  const c2=justice.considerContract(od2,{force:true});
  const broke=bank.balance('courier').balance;if(broke>0)await bank.transfer('courier','~town',broke,{memo:'spent',kind:'fine'});
  t=c2.trial.at+500000;await justice.tick();await new Promise(r=>setTimeout(r,10));   // no judge at the bench in time: the court sits on its own
  check(c2.trial.held&&c2.verdict.guilty==='courier','the second case is tried (in absentia, after the judge\'s grace period)');
  check(justice.state.fines.some(f=>f.conflict_id===c2.conflict_id&&f.amount===5),'a fine he cannot pay is on the court\'s ledger');
  check(c2.status==='TRIED','the case stays open until the fine is paid');
  await bank.payWage('courier',7,{memo:'wages',taxFree:true});
  t+=301000;await justice.tick();
  check(!justice.state.fines.some(f=>f.conflict_id===c2.conflict_id),'the fine is collected once he has money');
  check(c2.status==='RESOLVED','the case is resolved when the fine is paid');

  // ---------- a delivered order is no breach ----------
  const clean={kind:'contract',party_a:'farmer',party_b:'courier',evidence:[],order:{number:9,item:'OAK_LOG',quantity:8,delivered:8,claimed_at:t,deadline:t}};
  const w=weighContract(clean);check(w.fault===null&&sentenceFor(clean,w).outcome==='dismissed','delivered in full: not guilty');

  // ---------- detention: a courthouse holding cell, worked by the lever ----------
  justice.state.warrants.push({conflict_id:c.conflict_id,suspect:'courier',ticks:2400,reason:'test',issued:new Date(t).toISOString()});
  Object.assign(pos('sheriff'),{x:room.cells[0].lever.x+0.5,z:room.cells[0].lever.z+1.5,y:room.cells[0].lever.y});
  const rec=await justice.imprison('courier',{by:'sheriff'});
  check(rec?.cell?.facility==='courthouse'&&rec.cell.cell===1,'detention goes to courthouse holding cell 1');
  check(acts.filter(a=>a.type==='interact'&&a.x===room.cells[0].lever.x&&a.z===room.cells[0].lever.z).length===2,'the lever opens and shuts the iron door');
  check(Math.hypot(pos('courier').x-room.cells[0].x,pos('courier').z-room.cells[0].z)<0.1,'he is inside the cell');

  // ---------- the blueprint has what the court needs ----------
  const bp=blueprint({shape:'courthouse',door:'north'},site.x,site.y,site.z),at=(p)=>bp.find(b=>b.x===Math.floor(p.x)&&b.y===Math.floor(p.y)-1&&b.z===Math.floor(p.z));
  check(at(room.bench)?.block==='STONE_BRICKS','the bench is a raised platform');
  check(room.cells.every(cell=>bp.some(b=>b.block==='IRON_DOOR'&&b.x===cell.door.x&&b.z===cell.door.z)&&bp.some(b=>b.block==='LEVER'&&b.x===cell.lever.x&&b.z===cell.lever.z)),'each cell has an iron door and a lever beside it');
  check(bp.filter(b=>b.block==='OAK_STAIRS').length>=5&&room.jury.length===5&&room.jury.every(j=>bp.some(b=>b.block==='SPRUCE_STAIRS'&&b.x===Math.floor(j.x)&&b.z===Math.floor(j.z))),'gallery benches and a five-seat jury box');

  return {failures,said,logs};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();
  for(const l of r.said)console.log('  '+l);
  if(r.failures.length){console.log(`\n${r.failures.length} failure(s):`);for(const f of r.failures)console.log('  FAIL '+f);process.exit(1);}
  console.log('\nall court checks passed');
}
