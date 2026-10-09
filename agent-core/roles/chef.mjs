// Chef Antoine, the Master Chef: the town's kitchen, run as a state machine (rules in ../cuisine.mjs).
//
//   (his kitchen is the bakery once Bram has built it - until then the tavern; he only calls at the warehouse counter,
//   where Jasper hands him ingredients and takes the meals: he does not hang about the warehouse)
//   INSPECT_INVENTORY  at the kitchen, from the warehouse ledger: what is in stock, what is fresh, what is missing
//   LEARN_RECIPES      the world's recipe registry (plugin "recipes": vanilla, datapacks, mods) is what can be cooked;
//                      he learns from written books in the warehouse chests, by experimenting with what is at hand,
//                      and from what citizens talk about (onChat)
//   PLAN_MENU          what the town has been eating (every meal is logged: onAte), food fatigue and cravings ->
//                      today's menu, announced to everyone nearby; shortages become requests to the farmers
//   FETCH_INGREDIENTS  ingredients and fuel from the warehouse (no fuel: coal, charcoal or wood; none at all: dishes
//                      that need no fire)
//   COOK_MEAL          craft or cook the dish in steps; the batch is saved after every step, so an interruption
//                      (an alert, a meeting, nightfall) resumes where it stopped
//   SERVE_CITIZENS     hungry citizens nearby get a plate; the rest goes into the warehouse food store
import {BASELINE,RESTORATIVE,SUPPLIER_OF,PRECIOUS} from '../cuisine.mjs';
import {STATES,RecipeKnowledgeGraph,startingGraph,recipesInText,foodsMentioned,experiment,dietStats,planMenu,nextState,masteryIndex,
  fuelIn,fuelFor,BASELINE_DISHES,line,dishName} from '../cuisine.mjs';
import {registerFood} from '../town.mjs';

export const AGENT={id:'chef',role:'chef',name:'Chef Antoine',every:3,camp:true,post:[323,119],   // the tavern until his bakery stands
  personality:'Passionate, perfectionist and gloriously dramatic about food. Critiques raw ingredients, swoons over rare spices, despairs at bland repetitive diets, and peppers his speech with French. Proud of his Culinary Mastery Index and of how varied the town eats.',
  goal:'Feed the town well and never the same thing twice in a row. Your learning, menu planning, cooking and serving run on their own; in your own turns, ask people what they crave, talk about the dishes you are discovering, praise good ingredients and scold monotony.'};
export const PLUGIN_SETTINGS={'display-names':{chef:'Chef Antoine'},uniforms:{chef:'#FFFFFF'},'starter-items':{chef:['BREAD:4','COAL:8']}};

const HEAR_FROM=new Set(['scout','farmer','merchant','fisher','herbalist','courier','lumberjack']);   // who knows foreign ingredients
const CRAVE=/\b(crav\w*|hungry for|fancy|wish (?:we|i) had|could (?:really )?(?:go for|use)|want(?:s|ed)? (?:some|a))\b/i;

export function createChef(d){
  const {memory,configs,act,say,log,ledger,getSnapshot,civic=()=>null,now=()=>Date.now(),random=Math.random}=d;
  const town=memory.data.town??={};
  const diet=town.diet??={meals:[],cravings:[]};
  let registry=d.registry??null,registryAt=0;   // the world's food recipes (refreshed hourly)
  const said=new Map(),ready=(k,ms)=>{const t=said.get(k)??0;if(now()-t<ms)return false;said.set(k,now());return true;};
  const quip=(id,kind,vars,ms=60000)=>ready(`${id}:${kind}`,ms)?say(id,line(kind,vars,random)):undefined;
  const stateOf=id=>memory.data.agents[id];
  const nameOf=id=>(configs.find(c=>c.id===id)?.name??id).split(' ')[0];
  // His saved state (memory.json) holds the recipes as a plain list; the graph is rebuilt from it once per run.
  const graphs=new WeakMap();
  const chefOf=s=>{
    const C=s.chef??={state:STATES.IDLE,recipes:null,cooked:{},batches:0,learned:[],books:{},mastery:0};
    if(!graphs.has(C)){const g=C.recipes?RecipeKnowledgeGraph.fromJSON(C.recipes):startingGraph(registry??[]);
      for(const b of BASELINE)g.add(b,'baseline',0);   // new baseline dishes (the broths) for a chef who started before them
      graphs.set(C,g);C.recipes=g.toJSON();}
    return Object.defineProperty(C,'graph',{get:()=>graphs.get(C),enumerable:false,configurable:true});
  };
  const save=C=>{C.recipes=C.graph.toJSON();};
  const day=()=>town.day??0;
  const poolOf=self=>{const p={...(civic()?.stockItems()??{})};for(const [k,n] of Object.entries(self.inventory??{}))p[k]=(p[k]??0)+n;return p;};

  function learn(c,C,recipe,how){
    if(!C.graph.add(recipe,how,now()))return false;
    C.learned.unshift({dish:recipe.result,how,at:now()});C.learned=C.learned.slice(0,30);save(C);
    log('recipe_learned',{agent:c.id,dish:recipe.result,heat:recipe.heat,inputs:recipe.inputs,how,known:C.graph.size});
    ledger(c.id,`learned to make ${dishName(recipe.result)} (${how})`);
    memory.add?.(c.id,{time:now(),kitchen:`learned ${dishName(recipe.result)} - ${how}`});
    quip(c.id,'learned',{dish:dishName(recipe.result),how},30000);
    return true;
  }

  async function loadRegistry(c){
    if(registry&&now()-registryAt<3600000)return;
    const r=await act(c.id,{type:'recipes',x:0,y:0,z:0}).catch(()=>null);
    if(!Array.isArray(r))return;
    registry=r;registryAt=now();let added=0;
    for(const x of r)if(x.nutrition>0&&registerFood(x.result,x.nutrition))added++;
    log('recipe_registry',{agent:c.id,recipes:r.length,newFoods:added});
  }
  // ---------- the kitchen ----------
  /** Where he cooks: the bakery's stove once built, else the tavern, else his post. */
  function kitchen(c){
    const b=civic()?.bakeryLayout?.();
    if(b){const p=[Math.floor(b.chef.x),Math.floor(b.chef.z)];if(c.post?.[0]!==p[0]||c.post?.[1]!==p[1])c.post=p;return b.chef;}
    return civic()?.tavernSpot?.()??(c.post?{x:c.post[0]+0.5,z:c.post[1]+0.5}:null);
  }
  /** At the kitchen (true), or on his way there (false). */
  async function atKitchen(c,self){
    const k=kitchen(c);if(!k||Math.hypot(self.x-k.x,self.z-k.z)<=2.5)return true;
    if(!self.pathing)await d.travel?.(c.id,self,{x:k.x,y:Math.round(k.y??self.y),z:k.z}).catch(()=>{});
    return false;
  }
  // ---------- states ----------
  async function inspect(c,C,self){
    await loadRegistry(c);
    if(!await atKitchen(c,self))return;   // the warehouse ledger tells him what is in stock; no need to stand in it
    const stock=civic().stockItems(),foods=Object.keys(stock).filter(k=>(stock[k]??0)>0&&(registry??[]).some(r=>k in r.inputs));
    C.inspectedAt=now();C.pantry=Object.fromEntries(foods.map(k=>[k,stock[k]]));
    log('kitchen_inspected',{agent:c.id,ingredients:Object.keys(C.pantry).length,fuel:fuelIn(poolOf(self))});
    if(foods.length&&random()<0.3)quip(c.id,'critique',{item:dishName(foods[Math.floor(random()*foods.length)])},600000);
  }
  async function learnRecipes(c,C,self){
    await loadRegistry(c);
    C.learnedAt=now();
    if(!registry)return;
    // 1. Books and notes in the warehouse chests (one reading per book).
    const books=await act(c.id,{type:'books',x:0,y:0,z:0}).catch(()=>[]);
    for(const b of books??[]){
      const key=`${b.title}|${b.author}|${(b.pages??[]).join('').length}`;if(C.books[key])continue;C.books[key]=now();
      const found=recipesInText(`${b.title}\n${(b.pages??[]).join('\n')}`,registry,C.graph);
      for(const r of found.slice(0,5))learn(c,C,r,`from the book "${b.title}"${b.author?` by ${b.author}`:''}`);
      log('book_read',{agent:c.id,title:b.title,author:b.author,recipes:found.length});
    }
    // 2. An experiment with what is at hand (at most every 10 minutes).
    if(ready(`experiment:${c.id}`,(town.policy?.varietyUntil??0)>now()?120000:600000)){
      const e=experiment(registry,C.graph,poolOf(self),random,C.failedPairs??=[]);
      if(e.recipe)learn(c,C,e.recipe,'by experimenting in the kitchen');
      else if(e.tried?.length===2){C.failedPairs=[...C.failedPairs,e.pair].slice(-200);log('experiment_failed',{agent:c.id,tried:e.tried,remembered:true});quip(c.id,'failed',{a:dishName(e.tried[0]),b:dishName(e.tried[1])},900000);}
    }
  }
  function plan(c,C,self){
    const meals=diet.meals.slice(-60),stats=dietStats(meals);
    const requests=diet.cravings.filter(r=>now()-r.at<6*3600000);
    // A worn-out town gets the restorative broth (average energy under 50).
    const energies=configs.map(x=>memory.data.agents[x.id]?.needs?.energy).filter(Number.isFinite),tired=energies.length&&energies.reduce((a,b)=>a+b,0)/energies.length<50;
    const p=planMenu({graph:C.graph,pool:poolOf(self),meals,requests,restorative:tired});
    if(tired&&p.menu.some(m=>RESTORATIVE.has(m.dish)))log('broth_planned',{agent:c.id,dishes:p.menu.filter(m=>RESTORATIVE.has(m.dish)).map(m=>m.dish)});
    C.menu={day:day(),dishes:p.menu.map(m=>({...m,done:false})),fallback:p.fallback,variety:stats.score};
    log('menu_planned',{agent:c.id,menu:p.menu.map(m=>`${m.dish} x${m.times}`),variety:stats.score,fatigued:stats.fatigued,shortages:p.shortages,fuel:p.fuel});
    // Monotony upsets him; shortages go to the farmers (and whoever else grows or catches food).
    if(stats.top[0]?.share>=45&&stats.meals>=8)quip(c.id,'bland',{food:dishName(stats.top[0].food),pct:stats.top[0].share},1800000);
    for(const s of p.shortages.slice(0,2))if(ready(`ask:${s.item}`,3600000)){
      // Each ingredient from whoever supplies it: mushrooms from Rosa, apples from the lumberjack, fish from the fisher.
      const from=configs.find(x=>x.role===SUPPLIER_OF(s.item));
      civic().postQuest?.(c.id,s.item,Math.min(32,s.count),'for the kitchen',from?{preferred:from.id}:{})?.catch?.(()=>{});
      log('ingredient_requested',{agent:c.id,item:s.item,count:s.count,from:from?.id??null});
    }
    if(p.fallback&&p.shortages[0])quip(c.id,'fallback',{item:dishName(p.shortages[0].item)},1800000);
    if(!p.menu.length)return;
    // The daily announcement to everyone nearby.
    if(C.announcedDay!==day()){
      C.announcedDay=day();
      const [first,...rest]=p.menu;
      say(c.id,line('menu',{dish:dishName(first.dish),also:rest.length?`, with ${rest.map(m=>dishName(m.dish)).join(' and ')}`:''},random));
    }
  }
  /** What the next menu dish still needs fetched (ingredients and, for the stove, fuel). */
  function needsFor(C,self){
    const next=C.menu?.dishes.find(m=>!m.done);if(!next)return {};
    // Plan against the whole pantry: what to carry from the warehouse, raw (cane, not sugar - sugar is made here).
    const p=C.graph.plan(next.dish,next.times*(C.graph.recipes.get(next.recipe)?.count??1),poolOf(self));
    if(!p)return {};
    const inv=self.inventory??{},need={};
    for(const [k,v] of Object.entries(p.need)){const short=v-(inv[k]??0);if(short>0)need[k]=short;}
    for(const st of p.steps.slice(0,-1))delete need[st.recipe.result];
    if(p.steps.some(s=>s.recipe.heat!=="none")&&!fuelIn(inv)){const cooks=p.steps.filter(s=>s.recipe.heat!=="none").reduce((n,s)=>n+s.times,0);need.__fuel=cooks;}
    return need;
  }
  async function fetch(c,C,self,need){
    if(now()<(C.fetchWait??0))return;
    if(!await civic().goToWarehouse(c.id,self))return;
    C.fetchWait=now()+4000;
    const next=C.menu.dishes.find(m=>!m.done);let missing=false;
    for(const [item,n] of Object.entries(need)){
      if(item==='__fuel'){
        const stock=civic().stockItems(),fuel=fuelIn(stock);
        if(fuel){await civic().withdraw(c.id,fuel,fuelFor(fuel,n));}
        else{quip(c.id,'fuel',{},600000);log('kitchen_no_fuel',{agent:c.id,dish:next.dish});civic().postQuest?.(c.id,'COAL',16,'fuel for the kitchen').catch?.(()=>{});missing=true;}
        continue;
      }
      const got=await civic().withdraw(c.id,item,n);if(got<n)missing=true;
    }
    // Could not get everything: cook what can be cooked of it, or drop the dish for today.
    if(missing){next.fetchTries=(next.fetchTries??0)+1;if(next.fetchTries>=2){next.done=true;next.skipped=true;log('dish_skipped',{agent:c.id,dish:next.dish,reason:'ingredients or fuel ran out'});}}
  }
  async function cook(c,C,self){
    if(!await atKitchen(c,self))return;   // cooking happens at the bakery stove
    let b=C.batch;
    if(!b){
      const next=C.menu?.dishes.find(m=>!m.done);if(!next)return;
      const p=C.graph.plan(next.dish,next.times*(C.graph.recipes.get(next.recipe)?.count??1),self.inventory??{});
      if(!p||Object.keys(p.missing).length){next.fetchTries=(next.fetchTries??0)+1;if(next.fetchTries>=3){next.done=true;next.skipped=true;}return;}
      b=C.batch={dish:next.dish,steps:p.steps.map(s=>({item:s.recipe.result,heat:s.recipe.heat,input:Object.keys(s.recipe.inputs)[0],times:s.times,done:0})),started:now(),lastStep:now(),made:0};
      log('cooking_started',{agent:c.id,dish:b.dish,steps:b.steps.map(s=>`${s.item} x${s.times} (${s.heat})`)});
    }else if(now()-b.lastStep>30000){
      // Picking up a batch an interruption left half-done (it was saved after every step).
      log('batch_resumed',{agent:c.id,dish:b.dish,pausedFor:Math.round((now()-b.lastStep)/1000)});
      memory.add?.(c.id,{time:now(),kitchen:`went back to the ${dishName(b.dish)} I had to leave`});
    }
    const step=b.steps.find(s=>s.done<s.times);
    if(!step){
      const menuItem=C.menu?.dishes.find(m=>m.dish===b.dish&&!m.done);if(menuItem)menuItem.done=true;
      C.cooked[b.dish]=(C.cooked[b.dish]??0)+b.made;C.batches++;C.batch=null;C.serving={dish:b.dish,count:b.made};
      C.mastery=masteryIndex({known:C.graph.size,dishesCooked:Object.keys(C.cooked).length,batches:C.batches,variety:dietStats(diet.meals.slice(-60)).score});
      log('meal_cooked',{agent:c.id,dish:b.dish,portions:b.made,mastery:C.mastery});
      ledger(c.id,`cooked ${b.made} ${dishName(b.dish)} (Culinary Mastery ${C.mastery})`);
      return;
    }
    // One step at a time: craft up to 16, cook up to 64 - and save after each.
    const n=Math.min(step.heat==='none'?16:64,step.times-step.done);
    act(c.id,{type:'sound',x:0,y:0,z:0,target:step.heat==='none'?'block.wood.place':step.heat==='smoker'?'block.smoker.smoke':'block.furnace.fire_crackle',count:1}).catch(()=>{});
    const r=await act(c.id,step.heat==='none'?{type:'craft',x:0,y:0,z:0,target:step.item,count:n}:{type:'smelt',x:0,y:0,z:0,target:step.input,count:n})
      .catch(error=>({error:error.message}));
    if(r?.error){
      // No fuel mid-batch: fetch some and come back to this very step.
      if(/fuel/i.test(r.error)){C.batch=b;b.lastStep=now();const fuel=fuelIn(civic().stockItems());if(fuel&&await civic().goToWarehouse(c.id,self))await civic().withdraw(c.id,fuel,fuelFor(fuel,step.times-step.done));else{log('kitchen_no_fuel',{agent:c.id,dish:b.dish});b.failed=(b.failed??0)+1;}}
      else{log('cooking_failed',{agent:c.id,dish:b.dish,item:step.item,error:r.error});b.failed=(b.failed??0)+1;}
      if((b.failed??0)>=3){const m=C.menu?.dishes.find(x=>x.dish===b.dish);if(m){m.done=true;m.skipped=true;}C.batch=null;log('batch_abandoned',{agent:c.id,dish:b.dish});}
      return;
    }
    const done=step.heat==='none'?(r?.times??n):(r?.count??n);
    step.done+=step.heat==='none'?done:done;b.lastStep=now();
    if(step.item===b.dish)b.made+=step.heat==='none'?done*(C.graph.recipesFor(b.dish)[0]?.count??1):done;
  }
  async function serve(c,C,self){
    const dish=C.serving?.dish,have=self.inventory?.[dish]??0;
    if(!dish||have<=0){C.serving=null;return;}
    // Hungry citizens within a few steps get a plate first.
    const snap=getSnapshot(),hungry=(snap?.agents??[]).filter(a=>a.id!==c.id&&Math.hypot(a.x-self.x,a.z-self.z)<=4&&(stateOf(a.id)?.needs?.hunger??20)<14);
    let given=0;
    for(const a of hungry.slice(0,4)){
      if(given+2>have)break;
      if(await act(c.id,{type:'give',x:0,y:0,z:0,target:dish,count:2,to:a.id}).then(()=>true).catch(()=>false)){given+=2;log('meal_served',{agent:c.id,to:a.id,dish});quip(c.id,'serve',{name:nameOf(a.id),dish:dishName(dish)},20000);}
    }
    // The rest to the food store, where everyone eats from.
    if(!await civic().goToWarehouse(c.id,self))return;
    const stored=await civic().deposit(c.id,dish,have-given);
    log('meals_stored',{agent:c.id,dish,stored});
    if(stored)quip(c.id,'done',{n:stored+given,dish:dishName(dish)},120000);
    C.serving=stored||given?null:{...C.serving,tries:(C.serving.tries??0)+1};
    if(C.serving?.tries>=3)C.serving=null;
  }

  async function step(c,s,self){
    const C=chefOf(s);
    // One-time: today's menu or a batch with golden dishes (planned before gold was ruled out) is dropped.
    if(!C.goldFixV1){C.goldFixV1=true;if(C.menu?.dishes?.some(m=>/^GOLDEN_/.test(m.dish)))C.menu=null;if(/^GOLDEN_/.test(C.batch?.dish??''))C.batch=null;}
    if(self.pathing||['moving','loading'].includes(self.navigation?.status))return;
    if(C.menu&&C.menu.day!==day())C.menu=null;   // a new day, a new menu
    const need=C.menu?needsFor(C,self):{};
    // Valuables in his pack (gold from the quests for golden apples): back to the warehouse first.
    const precious=Object.entries(self.inventory??{}).filter(([k,n])=>n>0&&PRECIOUS.test(k));
    if(precious.length){
      if(!await civic().goToWarehouse(c.id,self))return;
      for(const [k,n] of precious){const put=await civic().deposit(c.id,k,n).catch(()=>0);if(put)log('chef_returned',{agent:c.id,item:k,count:put});}
      if(ready(`gold-back:${c.id}`,3600000))say(c.id,"Gold is not an ingredient, mes amis - I have returned it to the warehouse.").catch(()=>{});
      return;
    }
    const st=nextState({batch:C.batch,carrying:C.serving?.count?1:0,inspectedAt:C.inspectedAt,learnedAt:C.learnedAt,menu:C.menu?.dishes,needs:need,now:now()});
    if(st!==C.state){log('chef_state',{agent:c.id,from:C.state,to:st});C.state=st;}
    switch(st){
      case STATES.INSPECT_INVENTORY:return inspect(c,C,self);
      case STATES.LEARN_RECIPES:return learnRecipes(c,C,self);
      case STATES.PLAN_MENU:return plan(c,C,self);
      case STATES.FETCH_INGREDIENTS:return fetch(c,C,self,need);
      case STATES.COOK_MEAL:return cook(c,C,self);
      case STATES.SERVE_CITIZENS:return serve(c,C,self);
      case STATES.IDLE:
        // Nothing left on today's menu: an experiment now and then, otherwise the day's work is done.
        if(ready(`idle-learn:${c.id}`,600000))C.learnedAt=0;
        await atKitchen(c,self);   // between meals he keeps to his kitchen
        return;
    }
  }

  return {
    /** Daytime kitchen work (role job). An unfinished batch is kept in his memory and resumed later. */
    job(c,s,self,night){
      if((c.role??c.id)!=='chef'||night||s.resting)return null;
      return ()=>step(c,s,self);
    },
    /** Every meal anyone eats (the town's diet; drives variety and food fatigue). */
    onAte(data){if(!data?.agent||!data.food)return;diet.meals.push({agent:data.agent,food:data.food,at:now()});if(diet.meals.length>200)diet.meals=diet.meals.slice(-150);},
    /** Chat: cravings ("I'm craving pumpkin pie") and, from those who travel, farm and trade, new ingredients. */
    onChat(from,text){
      if(!registry||!text||from==='chef')return;
      const foods=foodsMentioned(text,registry);if(!foods.length)return;
      if(CRAVE.test(text))for(const f of foods.filter(f=>registry.some(r=>r.result===f))){diet.cravings.push({agent:from,food:f,at:now()});diet.cravings=diet.cravings.slice(-30);log('craving_heard',{from,food:f});}
      const id=configs.find(c=>c.id===from||c.name===from)?.id;
      const chefState=stateOf('chef');if(!chefState||!HEAR_FROM.has(id))return;
      const C=chefOf(chefState),c=configs.find(x=>x.id==='chef');if(!c)return;
      const r=registry.find(r=>!C.graph.knows(RecipeKnowledgeGraph.idOf(r))&&foods.some(f=>f===r.result||f in r.inputs));
      if(r&&ready('talk-learn',300000))learn(c,C,r,`talking with ${nameOf(id)} about ${dishName(foods[0])}`);
    },
    context(c,s){
      if((c.role??c.id)!=='chef')return {};
      const C=chefOf(s),stats=dietStats(diet.meals.slice(-60));
      return {kitchen:{state:C.state,recipesKnown:C.graph.size,dishes:C.graph.dishes().map(dishName),masteryIndex:C.mastery,todaysMenu:C.menu?.dishes.map(m=>`${dishName(m.dish)}${m.done?' (served)':''}`),
        townVariety:stats.score,mostEaten:stats.top,foodFatigue:stats.fatigued,cravings:diet.cravings.slice(-5).map(r=>`${nameOf(r.agent)} wants ${dishName(r.food)}`),recentlyLearned:C.learned.slice(0,3)},
        roleGuide:'You are Chef Antoine. Learning, menus, cooking and serving run on their own. In your turns be dramatic about food: ask what people crave, celebrate new recipes, complain about monotony (kitchen.townVariety), mention your Culinary Mastery Index.'};
    },
    agentView(id){const s=stateOf(id);if(!s?.chef)return {};const C=chefOf(s);return {kitchen:{state:C.state,known:C.graph.size,mastery:C.mastery,menu:C.menu?.dishes.map(m=>({dish:m.dish,done:m.done})),batch:C.batch?{dish:C.batch.dish}:null,cooked:C.cooked}};},
    view(){const st=dietStats(diet.meals.slice(-60));return {variety:st.score,kinds:st.kinds,top:st.top,fatigued:st.fatigued,cravings:diet.cravings.slice(-6)};},
    status(c,s){const C=s.chef;if(!C)return null;return ({COOK_MEAL:C.batch?`cooking ${dishName(C.batch.dish)}`:'at the stove',SERVE_CITIZENS:'serving the meal',FETCH_INGREDIENTS:'fetching ingredients',
      PLAN_MENU:'planning the menu',LEARN_RECIPES:'studying recipes',INSPECT_INVENTORY:'inspecting the pantry'})[C.state]??'resting in the kitchen';},
  };
}
