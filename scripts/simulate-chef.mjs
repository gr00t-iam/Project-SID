// Chef Antoine in a small simulated town: the real role module (agent-core/roles/chef.mjs) runs against an in-memory
// kitchen instead of the Minecraft plugin. One full cycle:
//   inspect the pantry -> discover recipes (a book in the warehouse, an experiment) -> plan a menu against a town
//   that has eaten nothing but bread -> fetch ingredients -> cook (sugar first, then pie) -> serve a hungry citizen
//   and store the rest.
//   npm run simulate:chef
import {createChef} from '../agent-core/roles/chef.mjs';
import {pathToFileURL} from 'node:url';

// A slice of the server's recipe registry (what the plugin's "recipes" action returns).
export const REGISTRY=[
  {result:'BREAD',count:1,heat:'none',inputs:{WHEAT:3},time:0,nutrition:5},
  {result:'BAKED_POTATO',count:1,heat:'furnace',inputs:{POTATO:1},time:200,nutrition:5},
  {result:'BAKED_POTATO',count:1,heat:'smoker',inputs:{POTATO:1},time:100,nutrition:5},
  {result:'COOKED_BEEF',count:1,heat:'furnace',inputs:{BEEF:1},time:200,nutrition:8},
  {result:'PUMPKIN_PIE',count:1,heat:'none',inputs:{PUMPKIN:1,SUGAR:1,EGG:1},time:0,nutrition:8},
  {result:'SUGAR',count:1,heat:'none',inputs:{SUGAR_CANE:1},time:0},
  {result:'BOWL',count:4,heat:'none',inputs:{OAK_PLANKS:3},time:0},
  {result:'MUSHROOM_STEW',count:1,heat:'none',inputs:{BROWN_MUSHROOM:1,RED_MUSHROOM:1,BOWL:1},time:0,nutrition:6},
  {result:'COOKIE',count:8,heat:'none',inputs:{WHEAT:2,COCOA_BEANS:1},time:0,nutrition:2},
];

export async function simulate({quiet=true,maxTicks=200}={}){
  let clock=Date.parse('2026-10-01T09:00:00Z');
  const self={id:'chef',x:279.5,y:70,z:104.5,inventory:{},held:'NONE'};
  const farmer={id:'farmer',x:288,y:70,z:107,inventory:{}};
  const warehouse={x:286,z:107};
  const stock={WHEAT:30,POTATO:20,PUMPKIN:14,SUGAR_CANE:20,EGG:16,BROWN_MUSHROOM:6,RED_MUSHROOM:6,OAK_PLANKS:12,COAL:10};
  const book={title:"Grandmother's Kitchen",author:'jrmym1981',pages:['Pumpkin pie: one pumpkin, sugar from cane, and a fresh egg. Bake with love.']};
  const events=[],said=[],quests=[];
  const inv=self.inventory,add=(k,n)=>{inv[k]=(inv[k]??0)+n;},take=(k,n)=>{if((inv[k]??0)<n)return false;inv[k]-=n;if(!inv[k])delete inv[k];return true;};
  const act=async(id,a)=>{
    switch(a.type){
      case 'recipes':return REGISTRY;
      case 'books':return [book];
      case 'craft':{const r=REGISTRY.find(x=>x.result===a.target&&x.heat==='none');if(!r)throw Error('Unknown recipe');let times=0;
        for(let i=0;i<(a.count??1);i++){if(!Object.entries(r.inputs).every(([k,n])=>(inv[k]??0)>=n))break;for(const [k,n] of Object.entries(r.inputs))take(k,n);add(r.result,r.count);times++;}
        if(!times)throw Error(`Missing ingredients for ${a.target}`);return {crafted:a.target,times};}
      case 'smelt':{const r=REGISTRY.find(x=>x.heat==='furnace'&&a.target in x.inputs);if(!r)throw Error('That cannot be smelted');
        const n=Math.min(a.count??1,inv[a.target]??0),fuel=Math.ceil(n/8);
        if(n<1||(inv.COAL??0)<fuel)throw Error('Need the input and fuel (coal, charcoal, planks, logs or sticks)');
        take(a.target,n);take('COAL',fuel);add(r.result,n);return {smelted:a.target,into:r.result,count:n};}
      case 'give':{if(!take(a.target,a.count))throw Error('Not enough');farmer.inventory[a.target]=(farmer.inventory[a.target]??0)+a.count;return 'given';}
      default:return 'ok';
    }
  };
  const civic={stockItems:()=>stock,
    goToWarehouse:async()=>{if(Math.hypot(self.x-warehouse.x,self.z-warehouse.z)<=3)return true;self.x=warehouse.x;self.z=warehouse.z;return false;},
    withdraw:async(id,item,n)=>{const k=Math.min(n,stock[item]??0);if(!k)return 0;stock[item]-=k;add(item,k);return k;},
    deposit:async(id,item,n)=>{const k=Math.min(n,inv[item]??0);if(!k)return 0;take(item,k);stock[item]=(stock[item]??0)+k;return k;},
    postQuest:async(id,item,count,note)=>{quests.push({item,count,note});}};
  const memory={data:{agents:{chef:{},farmer:{needs:{hunger:9}}},town:{day:12}},add(){}};
  const chef=createChef({memory,configs:[{id:'chef',role:'chef',name:'Chef Antoine'},{id:'farmer',name:'Tink the Farmer'}],act,civic:()=>civic,now:()=>clock,
    getSnapshot:()=>({agents:[self,farmer]}),
    say:async(id,t)=>{said.push(t);if(!quiet)console.log(`  Antoine: "${t}"`);},
    log:(type,data)=>{events.push({type,...data});if(!quiet&&/chef_state|recipe_learned|book_read|menu_planned|cooking_started|meal_cooked|meal_served|meals_stored|batch_resumed/.test(type))console.log(`  [${type}] ${JSON.stringify(data)}`);},
    ledger:()=>{},random:(()=>{let s=11;return ()=>((s=(s*16807)%2147483647)/2147483647);})()});
  // The town has been eating bread, bread and more bread.
  for(let i=0;i<24;i++)chef.onAte({agent:['farmer','scout','miner','courier'][i%4],food:i%6===5?'BAKED_POTATO':'BREAD'});
  const cfg={id:'chef',role:'chef'},state=memory.data.agents.chef;
  let ticks=0;
  for(;ticks<maxTicks;ticks++){
    // Halfway through the first pie batch an alarm sounds: the kitchen is left for a minute (an interruption).
    if(state.chef?.batch&&!state.interrupted&&state.chef.batch.steps.some(s=>s.done>0)){state.interrupted=true;clock+=60000;continue;}
    await chef.job(cfg,state,self,false)();clock+=2000;
    if(events.some(e=>e.type==='meals_stored')&&state.chef.menu?.dishes.every(m=>m.done))break;
  }
  return {ticks,events,said,quests,stock,state:state.chef,farmer,inventory:inv,
    states:[...new Set(events.filter(e=>e.type==='chef_state').map(e=>e.to))]};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log('Chef Antoine arrives in a town that has eaten bread for days. The warehouse holds wheat, potatoes, pumpkins, sugar cane,');
  console.log("eggs, mushrooms, planks and coal - and a book, \"Grandmother's Kitchen\". Tink the farmer is hungry.\n");
  const r=await simulate({quiet:false});
  const C=r.state;
  console.log(`\nDone in ${r.ticks} ticks. States: ${r.states.join(' -> ')}`);
  console.log(`Recipes known: ${C.recipes.length} · cooked: ${JSON.stringify(C.cooked)} · Culinary Mastery Index: ${C.mastery}`);
  console.log(`Tink received: ${JSON.stringify(r.farmer.inventory)} · warehouse now holds ${['PUMPKIN_PIE','MUSHROOM_STEW','BAKED_POTATO','BREAD'].map(k=>`${k} ${r.stock[k]??0}`).join(', ')}`);
}
