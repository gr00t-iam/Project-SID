// Faith and hobbies demo: Sister Maren preaches to a room of five citizens with different skepticism, then talks
// with the most open holdout; afterwards the citizens pick hobbies in their idle time. Pure rules from
// agent-core/faith.mjs with a seeded random, so every run tells the same story.
//   npm run simulate:faith
import {FAITHS,seedProfile,sermon,persuade,chooseHobby,practice,conversionChance,census} from '../agent-core/faith.mjs';

let seed=7;const random=()=>((seed=(seed*16807)%2147483647)/2147483647);
const H=FAITHS.hearthlight,priest={charisma:0.8,religion:seedProfile('priest','priest',{}).religion};
const room=[
  {id:'hazel',name:'Hazel (farmer)',role:'farmer',values:{community:0.8,sociability:0.7,tradition:0.5,curiosity:0.3},morale:45,trust:70},
  {id:'wren',name:'Wren (scout)',role:'scout',values:{curiosity:0.95,sociability:0.6,tradition:0.2},morale:65,trust:55},
  {id:'quill',name:'Quill (scribe)',role:'scribe',values:{tradition:0.9,curiosity:0.7,community:0.6},morale:60,trust:60},
  {id:'dorn',name:'Dorn (miner)',role:'miner',values:{craftsmanship:0.8,selfPreservation:0.6,sociability:0.3,tradition:0.4},morale:30,trust:40},
  {id:'marlo',name:'Marlo (merchant)',role:'merchant',values:{sociability:0.9,community:0.6,curiosity:0.5},morale:75,trust:65},
].map(c=>({...c,profile:seedProfile(c.id,c.role,c.values)}));
const pct=x=>`${Math.round(x*100)}%`;

console.log('The room before the sermon:');
for(const c of room)console.log(`  ${c.name.padEnd(18)} faith ${String(c.profile.religion.deity_or_faith??'none').padEnd(14)} skepticism ${pct(c.profile.religion.skepticism).padStart(4)}  morale ${c.morale}  values ${c.profile.culture.core_values.join(', ')}`);

console.log('\nDawn sermon at the square (each listener decides for itself):');
const results=sermon(priest,room.map(c=>({id:c.id,profile:c.profile,morale:c.morale,trust:c.trust,believers:0})),H,{random});
for(const r of results)console.log(`  ${room.find(c=>c.id===r.id).name.padEnd(18)} ${r.outcome.padEnd(10)} (chance ${pct(r.chance)})`);

const holdouts=room.filter(c=>c.profile.religion.deity_or_faith!==H.name);
const open=holdouts.map(c=>({c,p:conversionChance(priest,c.profile,H,{morale:c.morale,trust:c.trust})})).sort((a,b)=>b.p-a.p)[0];
if(open){
  const r=persuade(priest,{profile:open.c.profile},H,{morale:open.c.morale,trust:open.c.trust},{random});
  console.log(`\nSister Maren visits the most open holdout, ${open.c.name} (chance ${pct(r.chance)}): ${r.outcome}${r.outcome==='resisted'?` - skepticism now ${pct(open.c.profile.religion.skepticism)}`:''}`);
}
console.log('\nTown faith:',JSON.stringify(census(room.map(c=>c.profile))));

console.log('\nIdle time, three rounds of an hour (hobbies chosen by weight, time since last practiced and mood):');
let now=Date.parse('2026-10-01T09:00:00Z');
for(let round=1;round<=3;round++){
  const lines=room.map(c=>{const h=chooseHobby(c.profile.hobbies,{morale:c.morale,now,phase:'day'});if(!h)return `${c.id}: rests`;
    const gain=practice(h,now);c.morale=Math.min(100,c.morale+gain);return `${c.id}: ${h.name} (skill ${pct(h.proficiency)}, morale +${gain})`;});
  console.log(`  hour ${round}: ${lines.join(' | ')}`);now+=3600000;
}
