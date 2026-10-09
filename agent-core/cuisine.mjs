// The Master Chef's rules (Chef Antoine, roles/chef.mjs runs them): what he knows how to cook, how he learns more,
// what the town has been eating, and what to cook next. Pure functions and one class, testable without a server.
//
// The world's recipe registry (every food recipe the server knows - vanilla, datapacks and mods - from the plugin's
// "recipes" action) is the truth about what CAN be cooked; the RecipeKnowledgeGraph is what Antoine KNOWS. He starts
// with a few baseline dishes and learns the rest: from books in the warehouse chests, by experimenting with the
// ingredients at hand, and from what other citizens talk about.

export const STATES=Object.freeze({IDLE:'IDLE',INSPECT_INVENTORY:'INSPECT_INVENTORY',LEARN_RECIPES:'LEARN_RECIPES',PLAN_MENU:'PLAN_MENU',
  FETCH_INGREDIENTS:'FETCH_INGREDIENTS',COOK_MEAL:'COOK_MEAL',SERVE_CITIZENS:'SERVE_CITIZENS'});

/** Fuel a furnace, smoker or campfire burns, best first (logs and planks burn too). */
export const FUELS=['COAL','CHARCOAL','COAL_BLOCK','BLAZE_ROD','DRIED_KELP_BLOCK'];
export const isFuel=item=>FUELS.includes(item)||/_LOG$|_PLANKS$/.test(item);
export const fuelIn=pool=>Object.keys(pool??{}).filter(k=>isFuel(k)&&pool[k]>0).sort((a,b)=>FUELS.indexOf(a)>=0&&FUELS.indexOf(b)>=0?FUELS.indexOf(a)-FUELS.indexOf(b):FUELS.indexOf(a)>=0?-1:1)[0]??null;
/** Furnace fuel units (items cooked per piece), as the plugin counts them. */
const FUEL_UNITS={COAL:8,CHARCOAL:8,COAL_BLOCK:80,BLAZE_ROD:12,DRIED_KELP_BLOCK:20};
export const fuelFor=(item,cooks)=>Math.ceil(cooks/(FUEL_UNITS[item]??1.5));

const words=item=>String(item).toLowerCase().replace(/_/g,' ');

/** Recipes every chef knows on day one: the simple, filling baseline the town falls back on. */
export const BASELINE=[
  {result:'BREAD',count:1,heat:'none',inputs:{WHEAT:3},time:0,nutrition:5},
  {result:'BAKED_POTATO',count:1,heat:'furnace',inputs:{POTATO:1},time:200,nutrition:5},
  {result:'COOKED_BEEF',count:1,heat:'furnace',inputs:{BEEF:1},time:200,nutrition:8},
  {result:'COOKED_PORKCHOP',count:1,heat:'furnace',inputs:{PORKCHOP:1},time:200,nutrition:8},
  {result:'COOKED_CHICKEN',count:1,heat:'furnace',inputs:{CHICKEN:1},time:200,nutrition:6},
  {result:'COOKED_MUTTON',count:1,heat:'furnace',inputs:{MUTTON:1},time:200,nutrition:6},
  {result:'COOKED_COD',count:1,heat:'furnace',inputs:{COD:1},time:200,nutrition:5},
  {result:'COOKED_SALMON',count:1,heat:'furnace',inputs:{SALMON:1},time:200,nutrition:6},
  // The restorative broths (and the bowls for them): filling one-pot dishes he falls back on when the crops fail.
  {result:'BOWL',count:4,heat:'none',inputs:{OAK_PLANKS:3},time:0,nutrition:0},
  {result:'MUSHROOM_STEW',count:1,heat:'none',inputs:{BROWN_MUSHROOM:1,RED_MUSHROOM:1,BOWL:1},time:0,nutrition:6},
  {result:'BEETROOT_SOUP',count:1,heat:'none',inputs:{BEETROOT:6,BOWL:1},time:0,nutrition:6},
  {result:'RABBIT_STEW',count:1,heat:'none',inputs:{COOKED_RABBIT:1,CARROT:1,BAKED_POTATO:1,BROWN_MUSHROOM:1,BOWL:1},time:0,nutrition:10},
];
/** The restorative broths: served when the town is worn out; eating one restores energy and calms (civic eatFrom). */
export const RESTORATIVE=new Set(['MUSHROOM_STEW','BEETROOT_SOUP','RABBIT_STEW','SUSPICIOUS_STEW']);
/** Who in town supplies an ingredient the kitchen is short of (the rest: the farmers). */
export const SUPPLIER_OF=item=>/MUSHROOM/.test(item)?'herbalist':item==='APPLE'?'lumberjack':/^(COD|SALMON|TROPICAL_FISH)$/.test(item)?'fisher':/BEEF|PORK|MUTTON|CHICKEN|RABBIT/.test(item)?'farmer':'farmer';
const pairKey=(a,b)=>[a,b].sort().join('+');
export const BASELINE_DISHES=new Set(BASELINE.map(r=>r.result));

/**
 * What Antoine knows: recipes as nodes linking ingredients to dishes. Each recipe: {id, result, count, heat
 * ('none' = crafting table; 'furnace' | 'smoker' | 'campfire'), inputs {item:n}, time (ticks), nutrition,
 * saturation, source ('baseline' | 'book: <title>' | 'experiment' | 'talk with <name>'), learnedAt}.
 * Works with any item name, so foods added by datapacks or mods are handled like vanilla ones.
 */
export class RecipeKnowledgeGraph{
  constructor(recipes=[]){this.recipes=new Map();this.byIngredient=new Map();for(const r of recipes)this.add(r,r.source,r.learnedAt);}
  static idOf(r){return `${r.result}|${r.heat??'none'}|${Object.keys(r.inputs??{}).sort().join('+')}`;}
  /** Adds a recipe; true when it is new to him. */
  add(r,source='baseline',at=Date.now()){
    const id=RecipeKnowledgeGraph.idOf(r);if(this.recipes.has(id))return false;
    const rec={id,result:r.result,count:r.count??1,heat:r.heat??'none',inputs:{...r.inputs},time:r.time??0,nutrition:r.nutrition??null,saturation:r.saturation??null,source,learnedAt:at};
    this.recipes.set(id,rec);
    for(const item of Object.keys(rec.inputs)){if(!this.byIngredient.has(item))this.byIngredient.set(item,new Set());this.byIngredient.get(item).add(id);}
    return true;
  }
  knows(id){return this.recipes.has(id);}
  get size(){return this.recipes.size;}
  dishes(){return [...new Set([...this.recipes.values()].map(r=>r.result))];}
  recipesFor(result){return [...this.recipes.values()].filter(r=>r.result===result);}
  usesOf(item){return [...(this.byIngredient.get(item)??[])].map(id=>this.recipes.get(id));}
  /**
   * How to make `n` of a dish from a pool of items (his pockets plus the warehouse): the recipe to use, how many
   * times, the ingredients to gather, and what is missing. Intermediate ingredients he knows how to make (a bowl,
   * sugar) are made first, one level deep.
   */
  plan(result,n,pool={}){
    let best=null;
    for(const r of this.recipesFor(result)){
      const times=Math.ceil(n/r.count),need={},sub=[],missing={};
      for(const [item,per] of Object.entries(r.inputs)){
        const want=per*times,have=pool[item]??0;need[item]=want;
        if(have>=want)continue;
        // One level of sub-recipes (sugar from cane, bowls from planks).
        const s=this.recipesFor(item).find(sr=>Object.entries(sr.inputs).every(([k,m])=>(pool[k]??0)>=m*Math.ceil((want-have)/sr.count)));
        if(s){const t=Math.ceil((want-have)/s.count);sub.push({recipe:s,times:t});for(const [k,m] of Object.entries(s.inputs))need[k]=(need[k]??0)+m*t;}
        else missing[item]=want-have;
      }
      const candidate={recipe:r,times,need,steps:[...sub,{recipe:r,times}],missing};
      if(!best||Object.keys(candidate.missing).length<Object.keys(best.missing).length)best=candidate;
      if(!Object.keys(candidate.missing).length)break;
    }
    return best;
  }
  toJSON(){return [...this.recipes.values()];}
  static fromJSON(list){const g=new RecipeKnowledgeGraph();for(const r of list??[])g.add(r,r.source,r.learnedAt);return g;}
}
/** A new graph with the baseline dishes (nutrition taken from the registry when it is known). */
export function startingGraph(registry=[]){
  const g=new RecipeKnowledgeGraph();
  for(const b of BASELINE){const real=registry.find(r=>RecipeKnowledgeGraph.idOf(r)===RecipeKnowledgeGraph.idOf(b));g.add(real??b,'baseline',0);}
  return g;
}

// ---------- learning ----------
const mentions=(text,item)=>new RegExp(`\\b${words(item).replace(/\s+/g,'[\\s_-]*')}s?\\b`,'i').test(text);
/** Recipes a book (or any text) teaches: dishes it names, or recipes whose every ingredient it names. */
export function recipesInText(text,registry,graph){
  const t=String(text??'');if(!t.trim())return [];
  return registry.filter(r=>!graph.knows(RecipeKnowledgeGraph.idOf(r))&&(mentions(t,r.result)||Object.keys(r.inputs).length>1&&Object.keys(r.inputs).every(i=>mentions(t,i))));
}
/** Ingredients and dishes a chat line talks about (for learning from conversation and for cravings). */
export function foodsMentioned(text,registry){
  const names=new Set();for(const r of registry){names.add(r.result);for(const i of Object.keys(r.inputs))names.add(i);}
  return [...names].filter(n=>n.length>3&&mentions(text,n));
}
/**
 * An experiment in an idle moment: combine ingredients at hand and see whether they make something he does not know
 * yet. Returns {recipe} (a discovery) or {tried:[a,b]} (a pleasant failure).
 */
export function experiment(registry,graph,pool,random=Math.random,failed=[]){
  pool=Object.fromEntries(Object.entries(pool??{}).filter(([k])=>!PRECIOUS.test(k)));   // never valuables
  const at=Object.keys(pool).filter(k=>(pool[k]??0)>0);
  const possible=registry.filter(r=>!graph.knows(RecipeKnowledgeGraph.idOf(r))&&Object.entries(r.inputs).every(([k,n])=>(pool[k]??0)>=n));
  // A dish he has never made beats a new way to make a known one.
  const fresh=possible.filter(r=>!graph.recipesFor(r.result).length),pick=fresh.length?fresh:possible;
  if(pick.length)return {recipe:pick[Math.floor(random()*pick.length)%pick.length]};
  // A pair he has already found does not combine (carrot and potato, 52 times in a day) is never tried again; when
  // every pair at hand has failed there is nothing to try. Nothing is used up by a failed attempt.
  const foods=at.filter(k=>registry.some(r=>k in r.inputs)),bad=new Set(failed);
  for(let i=0;i<foods.length;i++)for(let j=i+1;j<foods.length;j++)if(!bad.has(pairKey(foods[i],foods[j])))return {tried:[foods[i],foods[j]],pair:pairKey(foods[i],foods[j])};
  return {tried:[],exhausted:foods.length>=2};
}

// ---------- the town's diet ----------
/**
 * Variety of what the town ate recently: 0-100 (normalised Shannon entropy, scaled down when there are only a few
 * kinds of food), the most-eaten foods, and citizens with food fatigue (the same food 3 of their last 4 meals).
 */
export function dietStats(meals=[]){
  const counts={};for(const m of meals)counts[m.food]=(counts[m.food]??0)+1;
  const kinds=Object.keys(counts).length,total=meals.length;
  let h=0;for(const c of Object.values(counts)){const p=c/total;h-=p*Math.log(p);}
  const score=kinds<=1||!total?0:Math.round(100*(h/Math.log(kinds))*Math.min(1,kinds/6));
  const byAgent={};for(const m of meals)(byAgent[m.agent]??=[]).push(m.food);
  const fatigued=Object.entries(byAgent).filter(([,f])=>{const last=f.slice(-4);return last.length>=3&&last.filter(x=>x===last.at(-1)).length>=3;}).map(([a,f])=>({agent:a,food:f.at(-1)}));
  const top=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([food,n])=>({food,share:Math.round(100*n/total)}));
  return {score,kinds,meals:total,top,fatigued};
}
const share=(dish,meals)=>meals.length?meals.filter(m=>m.food===dish).length/meals.length:0;

/**
 * Today's menu: known dishes he can make from the pool (pockets + warehouse; dishes that need heat only with fuel),
 * scored by nutrition, novelty against recent meals (and food fatigue), and citizens' requests. Up to `size` dishes;
 * when nothing fancy is possible, the simplest baseline dish that is, plus the shortages to ask the farmers for.
 */
// Valuables are never cooking ingredients (golden apples and carrots ate 150+ gold ingots and 140+ nuggets the town
// fetched for the chef on quests): no dish that needs them is planned, requested or experimented with.
export const PRECIOUS=/^(GOLD_INGOT|GOLD_NUGGET|GOLD_BLOCK|RAW_GOLD|DIAMOND|DIAMOND_BLOCK|EMERALD|EMERALD_BLOCK|NETHERITE_INGOT|NETHERITE_SCRAP|NETHERITE_BLOCK|IRON_BLOCK|LAPIS_BLOCK|AMETHYST_SHARD)$/;
const needsPrecious=p=>!!p&&[...Object.keys(p.need??{}),...(p.steps??[]).flatMap(s=>Object.keys(s.recipe?.inputs??{}))].some(k=>PRECIOUS.test(k));
export function planMenu({graph,pool={},meals=[],requests=[],size=3,batch=12,restorative=false}){
  const fuel=!!fuelIn(pool),candidates=[];
  const fatigue=new Set(dietStats(meals).fatigued.map(f=>f.food));
  const shortages={};
  // Only real meals go on the menu: sugar and bowls are made along the way, never served.
  const meal=dish=>graph.recipesFor(dish).some(r=>(r.nutrition??0)>0)||BASELINE_DISHES.has(dish);
  for(const dish of graph.dishes().filter(meal)){
    const p=graph.plan(dish,batch,pool);if(!p||needsPrecious(p))continue;
    const heat=p.steps.some(s=>s.recipe.heat!=='none');
    if(Object.keys(p.missing).length||(heat&&!fuel)){
      for(const [k,n] of Object.entries(p.missing))shortages[k]=Math.max(shortages[k]??0,n);
      // Half a batch is still a meal.
      const half=graph.plan(dish,Math.ceil(batch/2),pool);
      if(!half||Object.keys(half.missing).length||(heat&&!fuel))continue;
      candidates.push({dish,plan:half,times:half.times});continue;
    }
    candidates.push({dish,plan:p,times:p.times});
  }
  for(const c of candidates){
    const nut=c.plan.recipe.nutrition??4,requested=requests.filter(r=>r.food===c.dish).length;
    c.score=Math.round((nut*1.5+(1-share(c.dish,meals))*12+(fatigue.has(c.dish)?-10:0)+requested*8+(BASELINE_DISHES.has(c.dish)&&!RESTORATIVE.has(c.dish)?0:4)+(restorative&&RESTORATIVE.has(c.dish)?20:0))*10)/10;
  }
  candidates.sort((a,b)=>b.score-a.score);
  const menu=candidates.slice(0,size).map(c=>({dish:c.dish,times:c.times,score:c.score,recipe:c.plan.recipe.id}));
  const fallback=!menu.some(m=>!BASELINE_DISHES.has(m.dish)||RESTORATIVE.has(m.dish));
  return {menu,fallback,shortages:Object.entries(shortages).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([item,count])=>({item,count})),fuel};
}

// ---------- the state machine ----------
/**
 * The next state. ctx: {batch (a dish in progress), carrying (cooked dishes on him), inspectedAt, learnedAt,
 * menu (today's, with done flags), needs (ingredients still to fetch for the next dish), now}.
 * An unfinished batch always comes first (it was interrupted), then serving what is cooked, then the day's routine.
 */
export function nextState(ctx){
  const now=ctx.now??Date.now();
  if(ctx.batch)return STATES.COOK_MEAL;
  if(ctx.carrying>0)return STATES.SERVE_CITIZENS;
  if(!ctx.inspectedAt||now-ctx.inspectedAt>10*60000)return STATES.INSPECT_INVENTORY;
  if(!ctx.learnedAt||now-ctx.learnedAt>15*60000)return STATES.LEARN_RECIPES;
  if(!ctx.menu)return STATES.PLAN_MENU;
  const next=ctx.menu.find(m=>!m.done);
  if(!next)return STATES.IDLE;
  if(Object.keys(ctx.needs??{}).length)return STATES.FETCH_INGREDIENTS;
  return STATES.COOK_MEAL;
}

/** Culinary Mastery Index: recipes known, dishes actually cooked, batches served, and the town's variety. */
export function masteryIndex({known=0,dishesCooked=0,batches=0,variety=0}){
  return Math.round(10*Math.sqrt(known)+3*dishesCooked+0.5*batches+0.3*variety);
}

// ---------- his voice ----------
export const LINES={
  menu:['Bon appétit, citizens! Today\'s specialty is {dish}{also}. Come and eat while it is hot!','Attention, mes amis! The kitchen presents: {dish}{also}. Magnifique!',
    'Today\'s menu, prepared with love: {dish}{also}. Bon appétit!'],
  bland:['{food} again? {pct}% of every meal this week! Such a bland, repetitive diet - non, non, non. Tonight we change that.',
    'I see {food} on every plate. Where is the adventure? Where is the soul? I will fix this.'],
  learned:['Sacré bleu! {dish} - {how}. A new recipe for the book!','Ah! {dish}! I learned it {how} and I am already in love.'],
  failed:['{a} with {b}? A daring idea... and a disaster. Back to the drawing board.','Hmm, {a} and {b} do not wish to be friends. Noted.'],
  critique:['This {item} is... adequate. I have seen better, but I have also seen worse.','Look at this {item}! It deserves a chef who respects it.'],
  serve:['For you, {name}: {dish}, fresh from the kitchen. You look hungry - eat!','{name}! Sit, eat. {dish}, my own hands made it.'],
  fallback:['The fields have failed us today - baked and simple it is. I have asked the farmers for {item}.'],
  fuel:['No fire, no cooking! I must fetch fuel for the stove.'],
  done:['{n} portions of {dish}, perfect. Into the dining chest they go.'],
};
export function line(kind,vars={},random=Math.random){
  const list=LINES[kind]??[''];const t=list[Math.floor(random()*list.length)%list.length];
  return t.replace(/\{(\w+)\}/g,(_,k)=>String(vars[k]??''));
}
export const dishName=item=>words(item);
