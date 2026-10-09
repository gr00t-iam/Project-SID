// Intrinsic Motivation Engine demo: 3 citizens, 10 time steps, the real engine (agent-core/intel/motivation.mjs)
// with the real goal trees and trust matrix on an in-memory database, and a small simulated world instead of Minecraft.
//   npm run simulate:motivation
// Story: Bram (builder) is working on a player's watchtower when a zombie mauls him -> survival preempts the goal
// (suspended with its context), he retreats and warns the guard. Wren (scout) spots a fox she has never seen ->
// curiosity starts an investigation. Hazel (farmer), who trusts Bram, notices his distress -> altruism: she brings
// him bread. Bram recovers and resumes the watchtower where he left it. Meanwhile Hazel's bread recipe spreads.
import {openDatabase} from '../agent-core/intel/db.mjs';
import {createSocial} from '../agent-core/intel/social.mjs';
import {createGoals} from '../agent-core/intel/goals.mjs';
import {createMotivation} from '../agent-core/intel/motivation.mjs';

const HOSTILE=new Set(['ZOMBIE','SKELETON','CREEPER']);
const clock={now:Date.parse('2026-09-29T12:00:00Z')};
const db=openDatabase(':memory:'),social=createSocial(db,{now:()=>clock.now}),goals=createGoals(db,{lm:null,now:()=>clock.now});
const configs=[{id:'hazel',name:'Hazel the Farmer',role:'farmer'},{id:'bram',name:'Bram the Builder',role:'builder'},{id:'wren',name:'Wren the Scout',role:'scout'}];
const memory={data:{agents:Object.fromEntries(configs.map(c=>[c.id,{needs:{hunger:17,energy:85}}])),town:{},charter:{rules:[],proposals:[]}}};
const snap={worldTime:6000,agents:[
  {id:'hazel',x:280,y:70,z:100,health:20,inventory:{BREAD:6,WHEAT:9},entities:[]},
  {id:'bram',x:285,y:70,z:103,health:20,inventory:{OAK_PLANKS:40,STONE_BRICKS:20},entities:[]},
  {id:'wren',x:300,y:70,z:118,health:20,inventory:{EMERALD:3},entities:[]}]};
const lines=[];
const note=(who,text)=>lines.push(`    ${who.padEnd(6)} ${text}`);
const self=id=>snap.agents.find(a=>a.id===id),state=id=>memory.data.agents[id],conf=id=>configs.find(c=>c.id===id);

// The engine, wired to the simulated world.
const ime=createMotivation({db,social,goals,configs,memory,getSnapshot:()=>snap,hostile:HOSTILE,now:()=>clock.now,rng:()=>0.2,
  nameOf:id=>conf(id)?.name.split(' the ')[0]??id,roleOf:id=>conf(id)?.role??id,
  log:(type,d)=>{if(type==='motivation')note(d.agent,`[${d.drive}] ${d.kind}: ${d.detail}`);},
  say:async(id,text)=>note(id,`says "${text}"`),
  act:async(id,a)=>{if(a.type==='eat'){const s=self(id);s.inventory[a.target]--;state(id).needs.hunger=Math.min(20,state(id).needs.hunger+6);s.health=Math.min(20,s.health+2);note(id,`eats ${a.target.toLowerCase()}`);}},
  travel:async(id,s,dest)=>{Object.assign(s,{x:Math.round(dest.x),z:Math.round(dest.z)});note(id,`moves to ${Math.round(dest.x)},${Math.round(dest.z)}`);},
  civic:()=>({stockItems:()=>({}),eatJob:async(c,s,me)=>{const food=Object.keys(me.inventory).find(k=>k==='BREAD'&&me.inventory[k]>0);if(food)await ime_act(c.id,food);}}),
  postOrder:(issuer,item,n)=>note(issuer,`posts an emergency order for ${n} ${item.toLowerCase()}`),
  restSpot:id=>({hazel:{x:276,z:98},bram:{x:290,z:100},wren:{x:302,z:115}})[id]});
const ime_act=(id,food)=>{const s=self(id);s.inventory[food]--;state(id).needs.hunger=Math.min(20,state(id).needs.hunger+6);s.health=Math.min(20,s.health+2);note(id,`eats ${food.toLowerCase()}`);};

// A tiny stand-in for the goal executor: one milestone step per time step.
async function runGoal(id){
  const cur=goals.current(id);if(!cur||!cur.milestone)return;
  const m=cur.milestone,spec=m.spec;
  if(cur.goal.status==='PENDING')goals.setStatus(cur.goal.goal_id,'IN_PROGRESS');
  if(spec.type==='BUILD'){const st=spec.state??{placed:0};st.placed+=12;goals.setSpec(m.goal_id,{...spec,state:st});note(id,`builds the ${spec.site} (${st.placed}/60 blocks)`);if(st.placed<60)return;note(id,'finishes the watchtower');}
  if(spec.type==='GOTO'){Object.assign(self(id),{x:spec.x,z:spec.z});note(id,`walks to ${spec.x},${spec.z} (${m.title})`);}
  if(spec.type==='SAY')note(id,`says "${spec.text}"`);
  if(spec.type==='DELIVER'){const to=self(spec.to),me=self(id);me.inventory[spec.item]-=spec.quantity;to.inventory[spec.item]=(to.inventory[spec.item]??0)+spec.quantity;
    social.apply(spec.to,id,'food_shared',`${spec.quantity} ${spec.item}`);note(id,`hands ${spec.quantity} ${spec.item.toLowerCase()} to ${spec.to}`);}
  goals.completeMilestone(m.goal_id);goals.finishIfDone(cur.goal.goal_id);
}

// Scenario setup: Bram is building a player's watchtower; Hazel has known Bram for a long time.
ime.tick();   // first look around: the baseline (nothing is a surprise yet)
const tower=goals.create('bram','Build the watchtower',{source:'player:jrmym1981',milestones:[{type:'BUILD',site:'watchtower',title:'Raise the watchtower'}]});
social.adjust('hazel','bram',{trust:30,reliability:20},'old_friends','years of shared harvests');
ime.seedMeme('hazel','recipe','recipe:BREAD','how to make bread',1);

const EVENTS={
  2:()=>{Object.assign(self('bram'),{health:5,entities:[{type:'ZOMBIE',x:288,z:104,uuid:'z1'}]});lines.push('  ! a zombie attacks Bram (health 5/20)');},
  3:()=>{self('wren').entities=[{type:'FOX',x:312,z:128,uuid:'f1'}];lines.push('  ! a fox appears near Wren (never seen before)');},
  4:()=>{self('bram').entities=[];lines.push('  ! the guard kills the zombie');},
  6:()=>{social.adjustPair('hazel','bram',{trust:2},'conversation','lunch at the farm');lines.push('  ! Hazel and Bram chat over lunch (a dialogue: bonds and culture pass along it)');},
};
const pct=v=>String(Math.round(v*100)).padStart(3)+'%';
for(let t=1;t<=10;t++){
  clock.now+=20000;lines.length=0;
  EVENTS[t]?.();
  // World physics: hunger and energy drain; a fed citizen out of danger heals.
  for(const c of configs){const s=state(c.id),me=self(c.id);s.needs.hunger=Math.max(0,s.needs.hunger-0.4);s.needs.energy=s.motivation?.nap?Math.min(100,s.needs.energy+15):Math.max(0,s.needs.energy-1);
    if(!me.entities.some(e=>HOSTILE.has(e.type))&&s.needs.hunger>=10&&me.health<20)me.health=Math.min(20,me.health+(me.inventory.BREAD>0?4:2));}
  ime.tick();
  for(const c of configs){
    const s=state(c.id),me=self(c.id);
    const job=ime.job(c,s,me,{busy:false});
    if(job)await job();
    else await runGoal(c.id);
  }
  console.log(`\n=== step ${t} ===`);
  for(const l of lines)console.log(l);
  for(const c of configs){
    const dr=ime.drives(c.id),s=state(c.id),cur=goals.current(c.id);
    console.log(`  ${c.name.padEnd(18)} D_s${pct(dr.D.survival)} D_c${pct(dr.D.curiosity)} D_so${pct(dr.D.social)} | health ${String(Math.round(dr.vector.health)).padStart(3)} food ${String(Math.round(dr.vector.hunger)).padStart(3)} danger ${pct(dr.vector.threat)} | `+
      `${s.motivation?.mode?`SURVIVAL (${s.motivation.need})`:dr.dominant.padEnd(9)} | goal: ${cur?`${cur.goal.title} [${cur.goal.source}]`:'-'}${s.motivation?.stack?.length?` · on hold: ${s.motivation.stack.map(e=>e.title).join(', ')}`:''}`);
  }
}
console.log(`\nWatchtower goal: ${goals.get(tower.goal_id).status}, history: ${JSON.stringify(JSON.parse(goals.get(tower.goal_id).spec_json).history)}`);
console.log('Beliefs:',configs.map(c=>`${c.id}: ${ime.beliefs(c.id).map(b=>b.content).join(', ')||'-'}`).join(' | '));
console.log('Bonds:',ime.dashboard().bonds.map(b=>`${b.source}->${b.target} affinity ${b.affinity} (familiarity ${b.familiarity}, history ${b.shared_history})`).join('; '));
