// The jury end to end, on the real order board, court, judge and bank, with a scripted town and a clock we move:
//   1. ESCALATION      Hazel paid Barnaby a 6-emerald advance for 64 cobblestone and got none: a high-value
//                      contract - the case goes to a jury, not the bench
//   2. SELECT_JURY     three jurors drawn from the town; the parties, the judge and the sheriff never serve, and
//                      Marlo (who adores Barnaby, affinity 0.9) is disqualified for a conflict of interest
//   3. SUMMONS         the jurors walk to the jury box; one does not come - an alternate takes the seat
//   4. EVIDENCE        the judge charges the jury with the record (0/64 delivered, the advance)
//   5. DELIBERATION    each juror speaks - only facts from the record and their own leaning - and votes by traits
//   6. VERDICT         two thirds decide: GUILTY; the judge announces it, the sentence runs through the bank, the
//                      chronicle gets the verdict, and every juror remembers the case
// plus the pure rules: a minor case stays a bench trial, a hung jury goes back once and then the court rules.
//   node agent-core/test-jury.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {openDatabase} from './intel/db.mjs';
import {createBoard} from './intel/orders.mjs';
import {createJustice} from './skills/justice.mjs';
import {needsJury,selectJury,jurorVote,tally} from './skills/jury.mjs';
import {createJudge,CALL_AHEAD,WAIT_LIMIT} from './roles/judge.mjs';
import {createBank,emptyBank} from './skills/banking.mjs';
import {courthouseLayout} from './blueprints.mjs';

const CONFIGS=[
  {id:'judge',role:'judge',name:'Judge Thaddeus'},{id:'sheriff',role:'sheriff',name:'Sheriff Wade Harlan'},
  {id:'farmer',role:'farmer',name:'Hazel the Farmer'},{id:'courier',role:'courier',name:'Barnaby the Runner'},
  {id:'merchant',role:'merchant',name:'Marlo the Trader'},{id:'smith',role:'smith',name:'Vulcan the Smith'},
  {id:'scout',role:'scout',name:'Wren the Scout'},{id:'chef',role:'chef',name:'Antoine the Chef'},
  {id:'miner',role:'miner',name:'Dorn the Miner'},{id:'visitor',role:'visitor',name:'a Traveller'},
];
// Strict, meticulous citizens and gentle, generous ones.
const TRAITS={smith:{craftsmanship:0.9,generosity:0.3,patience:0.4,risk_tolerance:0.3},scout:{craftsmanship:0.4,generosity:0.6,patience:0.6,risk_tolerance:0.8},
  chef:{craftsmanship:0.85,generosity:0.5,patience:0.5,risk_tolerance:0.4},miner:{craftsmanship:0.8,generosity:0.4,patience:0.7,risk_tolerance:0.5},merchant:{generosity:0.5}};

export async function simulate({seed=5}={}){
  const failures=[],check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=Date.parse('2026-10-03T16:00:00Z');const now=()=>t;
  let s=seed;const random=()=>((s=(s*16807)%2147483647)/2147483647);
  const db=openDatabase(':memory:'),board=createBoard(db,{now});
  const said=[],logs=[],chronicle=[],memories=[],trust=[];
  const site={x:247,y:68,z:90},room=courthouseLayout(site);
  const snap={worldTime:6000,agents:CONFIGS.map((c,i)=>({id:c.id,x:270+i*3,y:69,z:100+i}))};
  const pos=id=>snap.agents.find(a=>a.id===id);
  const travel=async(id,self,p)=>{Object.assign(pos(id),{x:p.x,z:p.z,y:p.y??pos(id).y});};
  const act=async(id,a)=>{if(a.type==='confine')Object.assign(pos(id),{x:a.x,y:a.y,z:a.z});return {ok:true};};
  const say=async(id,text)=>{said.push(`${id}: ${text}`);};
  const log=(type,data)=>logs.push({type,...data});
  const nameOf=id=>CONFIGS.find(c=>c.id===id)?.name.split(' the ')[0]??id;
  const relation=(a,b)=>a==='merchant'&&b==='courier'?{trust:0.6,affinity:0.9}:{trust:0,affinity:0};
  const memory={data:{town:{day:311,conflicts:[],built:{courthouse:true},sites:{courthouse:site}},agents:{}}};
  let vault=0;const bankState=emptyBank();
  const bank=createBank(bankState,{now,physical:async({op,count})=>{if(op==='count')return {vault};if(op==='mint'){vault+=count;return {};}return {};},retryMs:1});
  await bank.mint(40);await bank.payWage('courier',30,{memo:'wages',taxFree:true});
  const collectFine=async(debtor,creditor,amount,memo)=>{const n=Math.min(amount,bank.balance(debtor).balance);if(n<1)return {paid:0};await bank.transfer(debtor,creditor??'~town',n,{memo,kind:'fine'});return {paid:n};};
  const justice=createJustice({memory,configs:CONFIGS,act,say,log,nameOf,getSnapshot:()=>snap,now,random,quests:()=>null,relation,
    valuesOf:id=>({community:0.4,tradition:id==='smith'?0.9:0.5,selfPreservation:0.5}),trust:()=>50,trialDelayMs:300000,square:{x:283.5,z:93.5},
    courtLayout:()=>room,courtPlace:()=>({x:room.bench.x,z:room.bench.z}),collectFine,traitsOf:id=>TRAITS[id]??{},
    remember:(id,m)=>memories.push({id,...m}),adjustTrust:(a,b,delta,why)=>trust.push({a,b,delta,why}),chronicle:text=>chronicle.push(text)});
  const judge=createJudge({memory,configs:CONFIGS,act,say,log,ledger:()=>{},getSnapshot:()=>snap,travel,justice:()=>justice,nameOf,now,courtLayout:()=>room});
  const runJudge=async()=>{const j=judge.job(CONFIGS[0],{},pos('judge'));if(j)await j();};

  // ---------- 1. ESCALATION ----------
  const o=board.post({issuer:'farmer',item:'COBBLESTONE',quantity:64,reward:12});
  board.claim(o.order_id,'courier',{upfront:6});board.recordUpfront(o.order_id,6);
  t+=31*60000;const od=board.sweep()[0];
  const c=justice.considerContract(od,{force:true});
  check(c&&c.order.upfront===6,'the case is filed with the advance on record');
  const need=needsJury(c,{priors:{}});
  check(need.jury&&need.size===3&&need.reasons.some(r=>/high-value contract/.test(r)),`a high-value contract goes to a jury of 3 (${need.reasons})`);

  // ---------- 2. SELECT_JURY + 3. SUMMONS ----------
  t=c.trial.at-CALL_AHEAD+1000;await runJudge();
  check(!!c.jury&&c.jury.jurors.length===3,'three jurors are drawn');
  const sel=logs.find(l=>l.type==='jury_selected');
  check(sel&&!c.jury.jurors.some(id=>['farmer','courier','judge','sheriff','visitor'].includes(id)),'no party, judge, sheriff or visitor on the jury');
  check(!c.jury.jurors.includes('merchant')&&c.jury.disqualified.some(x=>x.id==='merchant'&&/too close/.test(x.why)),'Marlo is disqualified: conflict of interest with Barnaby');
  check(said.some(l=>/goes before a jury/.test(l)),'the judge announces a jury trial');
  check(memory.data.town.court.state==='SUMMON_COURT','SUMMON_COURT after SELECT_JURY');
  for(let i=1;i<=3;i++){const sm=justice.summonsFor(c.jury.jurors[i-1]);check(sm?.role===`juror${i}`&&sm.stand.x===room.jury[i-1].x&&sm.stand.z===room.jury[i-1].z,`juror ${i} is summoned to seat ${i} of the jury box`);}
  // Everyone walks in - except the third juror, who never comes.
  const noShow=c.jury.jurors[2];
  for(const id of ['farmer','courier','sheriff',...c.jury.jurors.slice(0,2)])await travel(id,pos(id),justice.summonsFor(id).stand);
  t=c.trial.at+1000;await runJudge();
  check(!c.trial.held,'the court waits for the missing juror');
  t=c.trial.at+WAIT_LIMIT/2+1000;await runJudge();
  const alt=c.jury.jurors[2];
  check(alt!==noShow&&logs.some(l=>l.type==='juror_replaced'&&l.absent===noShow&&l.alternate===alt),'an alternate takes the empty seat');
  check(justice.summonsFor(noShow)===null,'the absent juror is released from the summons');
  await travel(alt,pos(alt),justice.summonsFor(alt).stand);
  // Court duty pauses their work: the worker records it (simulated here from the state main keeps).
  check(Object.values(justice.attendance()).every(a=>a.present),'the court is assembled, the jury box full');

  // ---------- 4. EVIDENCE + 5. DELIBERATION + 6. VERDICT ----------
  const before={hazel:bank.balance('farmer').balance,barnaby:bank.balance('courier').balance};
  await runJudge();
  check(c.trial.held&&c.trial.jury===true,'a jury trial was held');
  check(said.some(l=>/^judge: Members of the jury: .*0\/64 cobblestone/.test(l)),'the judge charges the jury with the record (0/64)');
  const jurorLines=said.filter(l=>c.jury.seated.some(id=>l.startsWith(`${id}: `)));
  check(jurorLines.length>=3,'each juror speaks in deliberation');
  check(jurorLines.every(l=>/The ledger shows 0 of 64 cobblestone delivered by the deadline/.test(l)),'jurors only cite the record (no invented facts)');
  check(c.jury.votes.length===3&&c.jury.votes.every(v=>['GUILTY','NOT_GUILTY','ABSTAIN'].includes(v.vote)),'three ballots cast');
  check(c.jury.result==='GUILTY'&&c.verdict.verdict==='GUILTY'&&c.jury.tally.guilty>=2,`a two-thirds verdict: GUILTY (${JSON.stringify(c.jury.tally)})`);
  check(said.some(l=>/^judge: The jury finds Barnaby guilty/.test(l)),'Judge Thaddeus announces the jury\'s verdict');
  const after={hazel:bank.balance('farmer').balance,barnaby:bank.balance('courier').balance};
  check(after.hazel-before.hazel===11&&before.barnaby-after.barnaby===11,`the fine (5) and the advance (6) go to Hazel through the bank (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
  check(chronicle.some(x=>x.includes(c.conflict_id)&&/GUILTY/.test(x)),'the verdict is recorded in the town chronicle');
  check(c.jury.seated.every(id=>memories.some(m=>m.id===id&&m.tags.includes('jury')&&/Served on the jury/.test(m.text)&&m.who.includes('courier'))),'every juror remembers serving, with the defendant in the memory');
  check(trust.some(x=>x.b==='courier'&&x.delta<0)&&trust.some(x=>x.why==='served on a jury together'),'votes colour trust in the defendant and among the jurors');
  check(!justice.state.summons,'the court adjourned');

  // ---------- the pure rules ----------
  const minor={kind:'contract',party_a:'farmer',party_b:'courier',evidence:[],order:{quantity:8,delivered:4,upfront:0,reward:2,item:'WHEAT'}};
  check(!needsJury(minor,{priors:{}}).jury,'a small shortfall stays a bench trial');
  check(needsJury(minor,{priors:{courier:1}}).jury,'a repeat offender gets a jury');
  check(needsJury({...minor,kind:'theft',order:null},{priors:{courier:2}}).size===5,'the gravest cases get five jurors');
  const pick=selectJury({party_a:'a',party_b:'b',evidence:[{kind:'sighting',by:'w'}]},{candidates:['a','b','w','x','y','z'],relation:(j,p)=>j==='y'&&p==='a'?{affinity:-0.9}:null,random:()=>0.5});
  check(!pick.jurors.includes('w')&&!pick.jurors.includes('y')&&pick.disqualified.some(d=>d.id==='w')&&pick.disqualified.some(d=>d.id==='y'),'witnesses and sworn enemies of a party never serve');
  const ev={fault:'b',defendant:'b',confidence:0.6,partial:true};
  const kind=jurorVote({evidence:ev,traits:{generosity:0.95,risk_tolerance:0.9,patience:0.9,craftsmanship:0.1},fact:'x',random:()=>0.5});
  const hard=jurorVote({evidence:ev,traits:{generosity:0.1,risk_tolerance:0.1,patience:0.1,craftsmanship:0.95},values:{tradition:0.9},fact:'x',random:()=>0.5});
  check(kind.score<hard.score&&hard.vote==='GUILTY'&&kind.vote!=='GUILTY','the same evidence: a generous, patient juror is lenient, a meticulous one strict');
  check(tally([{vote:'GUILTY'},{vote:'NOT_GUILTY'},{vote:'ABSTAIN'}]).result==='HUNG'&&tally([{vote:'GUILTY'},{vote:'GUILTY'},{vote:'NOT_GUILTY'}]).result==='GUILTY'
    &&tally([{vote:'GUILTY'},{vote:'GUILTY'},{vote:'NOT_GUILTY'},{vote:'NOT_GUILTY'},{vote:'GUILTY'}]).result==='HUNG','two thirds decide; a 3-2 split is hung');
  return {failures,said,logs};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();
  for(const l of r.said)console.log('  '+l);
  if(r.failures.length){console.log(`\n${r.failures.length} failure(s):`);for(const f of r.failures)console.log('  FAIL '+f);process.exit(1);}
  console.log('\nall jury checks passed');
}
