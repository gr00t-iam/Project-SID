// Finneas the Vault Keeper, the town's Banker. Keeps everyone's emeralds (skills/banking.mjs) and the payroll
// (skills/economy.mjs). His loop:
//
//   issue_payroll + collect_taxes   every tax interval: work becomes pay (income tax withheld), sales tax into the
//                                   reserves, and the treasury float topped up from the reserves for quests and projects
//   audit_accounts                  counts the vault and checks it against every balance plus the reserves
//   appraise_labor                  each dawn: wage rates follow what the town needs
//   process_deposit/withdrawal      by day he keeps the counter (the bank, or the warehouse door until the bank
//                                   stands); a citizen walking past with a heavy purse banks the surplus
import {dayPhase} from '../town.mjs';

export const AGENT={id:'banker',role:'banker',name:'Finneas the Vault Keeper',every:3,camp:true,post:[280,101],
  personality:'Meticulous, highly organized and risk-averse. Precise with numbers to the last emerald, proud of the public trust placed in the vault, polite but firm on tax deadlines.',
  goal:'Keep the town\'s money honest. Payroll, taxes, audits and the counter run on their own: you pay wages for work (tax withheld), keep the vault matching the books and help citizens deposit and withdraw. In your own turns, explain balances and taxes plainly and encourage saving.'};
export const PLUGIN_SETTINGS={'display-names':{banker:'Finneas the Vault Keeper'},uniforms:{banker:'#2E7D32'},'starter-items':{banker:['BREAD:4','PAPER:8']}};
const FLOAT=24;   // emeralds the treasury should hold for quest rewards and council projects

export function createBanker(d){
  const {act,say,log,ledger,getSnapshot,travel,bank,economy,now=()=>Date.now()}=d;
  const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const moving=self=>self.pathing||['moving','loading'].includes(self.navigation?.status);
  let lastAudit=0,lastServe=0,lastAppraiseDay=null;
  const nameOf=id=>d.nameOf?.(id)??id;

  async function payrollRun(c){return bank().withLock('~finance',()=>payrollUnlocked(c));}
  async function payrollUnlocked(c){
    await economy().recirculate(d.citizens?.()??[]).catch(e=>log('recirculation_error',{message:e.message}));
    const r=await economy().payroll({mint:n=>bank().mint(n),multiplier:d.wageMultiplier?.()??1,dailyCap:d.mintCap??256});
    // collect_taxes: the treasury float for quests and projects comes out of the reserves.
    const treasury=d.treasury?.()??0;
    if(treasury<FLOAT)await bank().toTreasury(FLOAT-treasury,{memo:'float for quests and projects'}).then(n=>{if(n)ledger(c.id,`moved ${n} emeralds of tax reserves into the treasury for quests and projects`);}).catch(e=>log('bank_transfer_failed',{message:e.message}));
    if(r.total)await say(c.id,`Payroll is out: ${r.total} emeralds to ${r.paid.length} citizens, tax withheld. Balances are at the counter.`).catch(()=>{});
    bank().state.municipal_vault.treasury_balance=d.treasury?.()??treasury;
    return r;
  }
  async function audit(c){return bank().withLock('~finance',()=>bank().withLock('~vault',()=>auditUnlocked(c)));}
  async function auditUnlocked(c){
    const r=await d.physical({op:'count',count:1}).catch(e=>({error:e.message}));
    if(r?.error||!Number.isFinite(r?.vault)){log('bank_audit_failed',{message:r?.error});return null;}
    const a=bank().audit(r.vault);
    if(!a.ok)ledger(c.id,`audit: the vault holds ${a.vault} emeralds but the books owe ${a.owed} (${a.diff>0?'+':''}${a.diff})`);
    return a;
  }
  /** process_deposit for a citizen at the counter carrying more than they need. */
  async function serve(c,self){
    lastServe=now();
    const near=(getSnapshot()?.agents??[]).filter(a=>a.id!==c.id&&d.isCitizen?.(a.id)&&dist(a,self)<=6&&(a.inventory?.EMERALD??0)>16&&!d.restricted?.(a.id));
    const who=near[0];if(!who)return false;
    const amount=who.inventory.EMERALD-8;
    try{const r=await bank().deposit(who.id,amount,{memo:'banked the surplus at the counter'});
      await say(c.id,`${nameOf(who.id)}, I've banked ${amount} emeralds for you. Balance: ${r.balance}.`).catch(()=>{});}
    catch(e){log('bank_deposit_failed',{agent:who.id,message:e.message});}
    return true;
  }
  function job(c,s,self,night){
    if((c.role??c.id)!=='banker')return null;
    const t=now();
    if(economy().due())return ()=>payrollRun(c).catch(e=>log('payroll_error',{message:e.message}));
    if(t-lastAudit>600000){lastAudit=t;return ()=>audit(c);}
    const phase=dayPhase(getSnapshot()?.worldTime);
    if(phase==='dawn'&&lastAppraiseDay!==d.day?.()){lastAppraiseDay=d.day?.();return async()=>{const ch=economy().appraise(d.needs?.()??{});if(ch.length)ledger(c.id,`set new wage rates: ${ch.map(k=>`${k.toLowerCase()} ${bank().state.wage_rates[k]}`).join(', ')}`);};}
    if(night)return null;
    const counter=d.counter?.();
    if(counter&&dist(self,counter)>3){if(moving(self))return null;return ()=>travel(c.id,self,{x:counter.x,y:Math.round(self.y),z:counter.z}).catch(()=>{});}
    if(t-lastServe>20000)return ()=>serve(c,self);
    return null;
  }
  const context=c=>(c.role??c.id)==='banker'?{bank:{vault:bank().state.municipal_vault,lastAudit:bank().state.lastAudit,wageRates:bank().state.wage_rates,taxes:bank().state.tax_config,
    owed:economy().view().owed,how:'Payroll, taxes and audits run on their own. Citizens deposit/withdraw with you at the counter.'}}:{};
  return {job,context,payrollRun,audit};
}
