// Gideon "Timber" Vance in a small simulated world: the real role module (agent-core/roles/lumberjack.mjs) runs
// against an in-memory forest, crafting table and warehouse instead of the Minecraft plugin. One full cycle:
//   no axe -> craft an axe from warehouse sticks and planks -> fell four oaks (apologising to each) -> clear a
//   canopy when no sapling drops -> replant every stump -> haul the timber to the warehouse.
//   npm run simulate:lumberjack
import {createLumberjack} from '../agent-core/roles/lumberjack.mjs';
import {netGreen} from '../agent-core/lumber.mjs';
import {pathToFileURL} from 'node:url';

/** Builds the world and runs ticks until the cycle completes (or maxTicks). Returns what happened. */
export async function simulate({maxTicks=400,quiet=true,trees=[[240,110],[246,114],[236,118],[250,106]],walledOff=null}={}){
  const blocks=new Map(),K=(x,y,z)=>`${x},${y},${z}`;
  const set=(x,y,z,t)=>t?blocks.set(K(x,y,z),t):blocks.delete(K(x,y,z));
  // Oaks: a five-log trunk on grass with a leafy crown.
  for(const [tx,tz] of trees){
    for(let x=tx-3;x<=tx+3;x++)for(let z=tz-3;z<=tz+3;z++)set(x,69,z,'GRASS_BLOCK');
    for(let y=70;y<75;y++)set(tx,y,tz,'OAK_LOG');
    for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(let y=73;y<=76;y++)if((dx||dz||y>74)&&!blocks.has(K(tx+dx,y,tz+dz)))set(tx+dx,y,tz+dz,'OAK_LEAVES');
  }
  const self={id:'lumberjack',x:255.5,y:70,z:104.5,held:'NONE',inventory:{},pathing:false};
  const warehouse={x:286,z:107},stock={STICK:10,OAK_PLANKS:6};
  const events=[],said=[],trace=[];let leafRoll=0;
  const inv=self.inventory,add=(k,n=1)=>{inv[k]=(inv[k]??0)+n;},take=(k,n=1)=>{if((inv[k]??0)<n)return false;inv[k]-=n;if(!inv[k])delete inv[k];return true;};
  const RECIPES={OAK_PLANKS:[{OAK_LOG:1},4],STICK:[{OAK_PLANKS:2},4],WOODEN_AXE:[{OAK_PLANKS:3,STICK:2},1],STONE_AXE:[{COBBLESTONE:3,STICK:2},1],IRON_AXE:[{IRON_INGOT:3,STICK:2},1]};
  const reach=(x,y,z)=>Math.hypot(x+0.5-self.x,y+0.5-self.y,z+0.5-self.z)<=10;
  const act=async(id,a)=>{
    switch(a.type){
      case 'find':{const out=[];for(const [k,t] of blocks)if(t===a.target){const [x,y,z]=k.split(',').map(Number);if(Math.hypot(x-self.x,z-self.z)<=24)out.push({x,y,z});}
        return out.sort((p,q)=>Math.hypot(p.x-self.x,p.z-self.z)-Math.hypot(q.x-self.x,q.z-self.z)).slice(0,12);}
      case 'scan':{const cells=[];for(let x=a.x;x<a.x+a.width;x++)for(let y=a.y;y<a.y+a.height;y++)for(let z=a.z;z<a.z+a.depth;z++){const t=blocks.get(K(x,y,z));if(t)cells.push([x,y,z,t,true,true,false]);}return {cells};}
      case 'mine':{const t=blocks.get(K(a.x,a.y,a.z));if(!t)throw Error('That block cannot be mined');if(!reach(a.x,a.y,a.z))throw Error('Target outside allowed range');
        set(a.x,a.y,a.z,null);
        if(t.endsWith('_LOG')){add(t);if(self.held.endsWith('_AXE')&&++self.axeUses>=12){take(self.held);events.push({type:'axe_wore_out'});self.held='NONE';}}
        // Leaves: like the game, saplings and sticks now and then (deterministic here).
        if(t.endsWith('_LEAVES')){leafRoll++;if(leafRoll%6===0)add('OAK_SAPLING');if(leafRoll%9===0)add('STICK');if(leafRoll%25===0)add('APPLE');}
        return {mined:t};}
      case 'craft':{const [ins,out]=RECIPES[a.target]??[];if(!ins)throw Error('Unknown recipe');let made=0;
        for(let i=0;i<(a.count??1);i++){if(!Object.entries(ins).every(([k,n])=>(inv[k]??0)>=n))break;for(const [k,n] of Object.entries(ins))take(k,n);add(a.target,out);made++;}
        if(!made)throw Error(`Missing ingredients for ${a.target}`);return {crafted:a.target,times:made};}
      case 'equip':if(!(inv[a.target]>0))throw Error('You do not have that');self.held=a.target;self.axeUses=0;return `holding ${a.target}`;
      case 'place':{if(blocks.has(K(a.x,a.y,a.z)))throw Error('Space occupied; place only into air or grass');if(!take(a.target))throw Error(`Out of ${a.target}`);set(a.x,a.y,a.z,a.target);return 'placed';}
      default:return 'ok';
    }
  };
  // walledOff: a tree nobody can get to (a cliff, a fence): walks toward it go nowhere.
  const travel=async(id,s,dest)=>{if(walledOff&&Math.hypot(dest.x-walledOff[0],dest.z-walledOff[1])<4)return;self.x=dest.x;self.z=dest.z;self.y=dest.y??self.y;trace.push(`walk ${Math.round(dest.x)},${Math.round(dest.z)}`);};
  const civic={stockItems:()=>stock,
    goToWarehouse:async(id,s)=>{if(Math.hypot(self.x-warehouse.x,self.z-warehouse.z)<=3)return true;await travel(id,s,{...warehouse,y:70});return false;},
    withdraw:async(id,item,n)=>{const k=Math.min(n,stock[item]??0);if(!k)return 0;stock[item]-=k;add(item,k);return k;},
    deposit:async(id,item,n)=>{const k=Math.min(n,inv[item]??0);if(!k)return 0;take(item,k);stock[item]=(stock[item]??0)+k;return k;}};
  const memory={data:{agents:{lumberjack:{}},town:{}},add(){}};
  let clock=Date.parse("2026-10-01T09:00:00Z");   // simulated time: each tick is two seconds
  const L=createLumberjack({now:()=>clock,memory,configs:[{id:'lumberjack',role:'lumberjack',post:[252,108]}],act,travel,civic:()=>civic,intel:()=>null,
    say:async(id,t)=>{said.push(t);if(!quiet)console.log(`  Gideon: "${t}"`);},log:(type,data)=>{events.push({type,...data});if(!quiet&&/lumber_state|tree_felled|sapling_planted|timber_delivered|lumber_axe|foliage_cleared|axe_broke/.test(type))console.log(`  [${type}] ${JSON.stringify(data)}`);},
    ledger:()=>{},random:(()=>{let s=3;return ()=>((s=(s*16807)%2147483647)/2147483647);})()});
  const cfg={id:'lumberjack',role:'lumberjack',post:[252,108]},state=memory.data.agents.lumberjack;
  let ticks=0;
  for(;ticks<maxTicks;ticks++){
    await L.job(cfg,state,self,false)();clock+=2000;
    if(events.some(e=>e.type==='timber_delivered')&&!state.lumber.stumps.length)break;
  }
  return {ticks,events,said,town:memory.data.town,self,ledger:state.lumber.ledger,stock,inventory:inv,saplingsInWorld:[...blocks.values()].filter(t=>t.endsWith('_SAPLING')).length,
    states:[...new Set(events.filter(e=>e.type==='lumber_state').map(e=>e.to))]};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log('Gideon "Timber" Vance wakes up with no axe, four oaks nearby and a warehouse holding 10 sticks and 6 oak planks.\n');
  const r=await simulate({quiet:false});
  console.log(`\nDone in ${r.ticks} ticks. States visited: ${r.states.join(' -> ')}`);
  console.log(`Ledger: ${r.ledger.trees_harvested} felled, ${r.ledger.seeds_replanted} replanted, ${r.ledger.total_logs_delivered} logs delivered, net green ${netGreen(r.ledger)}`);
  console.log(`Saplings growing in the world: ${r.saplingsInWorld}. Warehouse now: ${JSON.stringify(r.stock)}. Gideon carries: ${JSON.stringify(r.inventory)}`);
}
