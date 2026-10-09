// Judge Thaddeus: presides over the town court. The court itself - cases, evidence, verdicts, sentences, fines, the
// cells - is in ../skills/justice.mjs; this is the judge's working day, a small state machine:
//
//   IDLE              nothing on the docket: free time, near the courthouse by day
//   REVIEW_DOCKET     a trial is set but not yet near: he reads the case (the evidence count goes in the ledger)
//   SELECT_JURY       a serious or unclear case (skills/jury.mjs): an impartial panel of 3 or 5 is drawn
//   SUMMON_COURT      two minutes before the hour: the court is called - plaintiff, defendant, the sheriff and any
//                     jurors are summoned to their stands and the jury box (justice.summon; main's worker gives them a
//                     "court" job that pauses their routines) and the judge walks to the bench; halfway through the
//                     wait an absent juror is replaced by an alternate
//   CONDUCT_TRIAL     at the hour, everyone present (or three minutes late: tried in absentia): order in the court,
//                     the gavel, testimony from those present, the evidence weighed against the ledger
//   PRESENT_EVIDENCE  (jury trials) the judge charges the jury with the record
//   JURY_DELIBERATION (jury trials) each juror speaks and votes; two thirds decide; a hung jury goes back once,
//                     then the judge rules on the record (justice.deliberate)
//   DELIVER_SENTENCE  the verdict and sentence (fines through the bank), then the court adjourns
//
// Without a judge the governor sits as magistrate and trials run on their own (justice.tick), as before.

export const STATES=['IDLE','REVIEW_DOCKET','SELECT_JURY','SUMMON_COURT','CONDUCT_TRIAL','PRESENT_EVIDENCE','JURY_DELIBERATION','DELIVER_SENTENCE'];
export const CALL_AHEAD=120000;    // the court is called two minutes before the trial
export const WAIT_LIMIT=180000;    // past the hour the court waits three minutes for absentees, then tries in absentia

export const AGENT={id:'judge',role:'judge',name:'Judge Thaddeus',every:4,camp:true,post:[252,96],
  personality:'Formal, analytical and stoic; deeply committed to procedural fairness and the town ledger. Speaks with legal gravity ("Court is now in session." "The ledger does not lie." "Order in the court!"). Weighs only what is recorded - signed orders, chest records, timestamps - never feelings or hearsay.',
  goal:'Keep the town\'s justice. Your court runs on its own: cases are filed, you call the court, hear the parties and rule on the record. In your own turns, speak with people about fairness and the rules, and never claim a fact the ledger does not show.'};
export const PLUGIN_SETTINGS={'display-names':{judge:'Judge Thaddeus'},uniforms:{judge:'#1B1B1B'},'starter-items':{judge:['BREAD:6','PAPER:16','BOOK:2']}};

export function createJudge(d){
  const {memory,configs,act,say=async()=>{},log=()=>{},ledger=()=>{},getSnapshot=()=>null,travel,now=()=>Date.now()}=d;
  const justice=()=>d.justice();
  const town=memory.data.town??={};
  const court=town.court??={state:'IDLE',case:null,since:now(),reviewed:[]};
  const conf=id=>configs.find(c=>c.id===id);
  const nameOf=id=>d.nameOf?.(id)??conf(id)?.name?.split(' the ')[0]??id;
  const moving=self=>self.pathing||['moving','loading'].includes(self.navigation?.status);
  const flat=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
  const said=new Map(),ready=(k,ms)=>{const t=said.get(k)??0;if(now()-t<ms)return false;said.set(k,now());return true;};
  /** Where the judge sits: the courthouse bench, or the head of the court place (the town hall) before it is built. */
  const bench=()=>d.courtLayout?.()?.bench??d.courtSpots?.()?.bench??(p=>({x:p.x,y:null,z:p.z-2}))(d.courtPlace?.()??{x:283.5,z:93.5});
  function set(state,extra={}){
    if(court.state===state)return;
    log('court_state',{from:court.state,to:state,case:court.case,...extra});
    court.state=state;court.since=now();
  }
  const walkTo=(c,self,p)=>travel(c.id,self,{x:p.x,y:Math.round(p.y??self.y),z:p.z}).catch(()=>{});

  /** CONDUCT_TRIAL and DELIVER_SENTENCE: at the bench, with the court assembled (or the wait over). */
  async function conduct(c,self,next){
    const j=justice(),att=j.attendance(),absent=Object.values(att).filter(a=>!a.present).map(a=>nameOf(a.id));
    set('CONDUCT_TRIAL',{absent});
    await say(c.id,absent.length?`Order in the court! ${absent.join(' and ')} did not answer the summons; the court proceeds on the record.`:'Order in the court! Court is now in session.').catch(()=>{});
    const g=d.courtLayout?.()?.gavel;
    act(c.id,{type:'effect',x:g?.x??self.x,y:g?.y??self.y,z:g?.z??self.z,target:'gavel'}).catch(()=>{});
    const verdict=await j.holdTrial(next,{present:att});
    set('DELIVER_SENTENCE',{verdict:verdict?.verdict??null});
    if(verdict)await say(c.id,verdict.verdict==='GUILTY'?'The ledger does not lie. Sentence will be carried out. Court is adjourned.':'The record stands. Court is adjourned.').catch(()=>{});
    j.adjourn();court.case=null;set('IDLE');
  }

  return {
    /** The judge's job this tick, or null (free time). */
    job(c,s,self){
      if((c.role??c.id)!=='judge')return null;
      const j=justice();
      if(j.inSession())return async()=>{};   // the court is sitting: stay put
      const next=j.nextTrial();
      if(!next){if(court.state!=='IDLE'){court.case=null;set('IDLE');}return null;}
      const until=next.trial.at-now();
      if(until>CALL_AHEAD){
        // REVIEW_DOCKET: read the case once, then carry on with the day.
        if(!court.reviewed.includes(next.conflict_id)){
          court.reviewed=[...court.reviewed,next.conflict_id].slice(-50);set('REVIEW_DOCKET',{case:next.conflict_id});
          ledger(c.id,`reviewed ${next.conflict_id} (${next.reason}): ${next.evidence.length} entries on the record; trial at ${next.trial.scheduled_at.slice(11,16)} UTC`);
        }
        return null;
      }
      // SUMMON_COURT: call the court once, then walk to the bench and wait for the hour and the parties.
      if(court.case!==next.conflict_id){
        court.case=next.conflict_id;set('SUMMON_COURT',{case:next.conflict_id});
        const sm=j.summon(next),who=Object.entries(sm.people).filter(([role])=>!role.startsWith('juror')).map(([role,id])=>`${nameOf(id)} (${role})`).join(', ');
        if(next.jury){set('SELECT_JURY',{jurors:next.jury.jurors,reasons:next.jury.reasons});
          say(c.id,`This case goes before a jury (${next.jury.reasons.join('; ')}). Jurors: ${next.jury.jurors.map(nameOf).join(', ')}.`).catch(()=>{});set('SUMMON_COURT');}
        say(c.id,`The court is called: ${next.conflict_id}, ${nameOf(next.party_a)} versus ${nameOf(next.party_b)}, ${next.reason}. ${who}: to the courthouse.`).catch(()=>{});
      }
      return async()=>{
        const b=bench();
        if(flat(self,b)>2.5){if(!moving(self))await walkTo(c,self,b);return;}
        if(now()<next.trial.at)return;                                     // the court sits at the hour it was set for
        // Halfway through the wait, an absent juror's seat goes to an alternate.
        if(next.jury&&now()>=next.trial.at+WAIT_LIMIT/2&&j.replaceAbsentJurors())await say(c.id,'An alternate juror is called to take the empty seat.').catch(()=>{});
        const att=j.attendance(),all=Object.values(att).every(a=>a.present);
        if(!all&&now()<next.trial.at+WAIT_LIMIT){                          // late parties: a short wait
          if(ready(`wait:${next.conflict_id}`,60000))await say(c.id,`The court waits for ${Object.values(att).filter(a=>!a.present).map(a=>nameOf(a.id)).join(' and ')}.`).catch(()=>{});
          return;
        }
        await conduct(c,self,next);
      };
    },
    context(c){
      if((c.role??c.id)!=='judge')return {};
      return {bench:{state:court.state,case:court.case}};
    },
    // During a trial the court's own phase (PRESENT_EVIDENCE, JURY_DELIBERATION, ...) is the judge's state.
    view:()=>({state:justice().state.session?.phase??court.state,case:court.case,since:new Date(court.since).toISOString()}),
  };
}
