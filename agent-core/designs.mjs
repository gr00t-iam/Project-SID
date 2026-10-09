// Building designs chosen by the citizens: before a public building starts, the town votes between three designs
// (grand, practical, cozy). Each citizen votes by its own values (from the cognition engine), a little by what the
// warehouse already holds, and a little by chance. The winning design sets the blueprint's materials and size.

// Blueprint defaults (width x depth) per shape, as in blueprints.mjs.
export const BASE_SIZE={tavern:[9,9],bank:[9,7],jail:[9,7],hall:[11,9],pavilion:[9,9],warehouse:[9,7],library:[9,7],forge:[7,7],house:[5,5],tower:[5,5],well:[3,3],windmill:[5,5]};
const FIXED_SIZE=new Set(['well','tower','windmill','jail','bank','tavern']);
export const STYLES={
  grand:{label:'grand',about:'stone brick with oak-log trim and a brick roof, two blocks larger',
    spec:{material:'STONE_BRICKS',trim:'STRIPPED_OAK_LOG',roof:'BRICKS',floor:'SPRUCE_PLANKS'},grow:2,
    appeal:v=>0.4*v.tradition+0.3*v.community+0.3*v.craftsmanship},
  practical:{label:'practical',about:'cobblestone with oak trim, standard size (cheap and sturdy)',
    spec:{material:'COBBLESTONE',trim:'OAK_LOG',roof:'SPRUCE_PLANKS',floor:'OAK_PLANKS'},grow:0,
    appeal:v=>0.45*v.selfPreservation+0.35*v.craftsmanship+0.2*v.community},
  cozy:{label:'cozy',about:'birch and spruce timber, two blocks smaller',
    spec:{material:'BIRCH_PLANKS',trim:'SPRUCE_LOG',roof:'SPRUCE_PLANKS',floor:'OAK_PLANKS'},grow:-2,
    appeal:v=>0.5*v.sociability+0.3*v.curiosity+0.2*v.community},
};
const clampSize=n=>Math.max(5,Math.min(15,n));

/** The design options for a shape, using only allowed materials (all three when `allowed` is empty). */
export function designOptions(shape,allowed=[]){
  const ok=new Set(allowed),[w,d]=BASE_SIZE[shape]??[5,5];
  return Object.entries(STYLES).filter(([,s])=>!ok.size||Object.values(s.spec).every(m=>ok.has(m))).map(([id,s])=>({
    id,label:s.label,about:s.about,
    spec:{...s.spec,...(FIXED_SIZE.has(shape)?{}:{width:clampSize(w+s.grow),depth:clampSize(d+s.grow)})},
  }));
}

/**
 * The vote. voters: [{id, values}] (values as in cognition.mjs, 0-1 each). stock: warehouse items (options whose
 * main material is on hand appeal a little more). Returns {winner, tally, ballots:{id: option}}; a tie goes to the
 * builder's choice when it is among the tied, otherwise the first.
 */
export function voteDesign(options,voters,{stock={},builder=null,random=Math.random}={}){
  if(!options.length)return null;
  const tally=Object.fromEntries(options.map(o=>[o.id,0])),ballots={};
  for(const v of voters){
    const vals=v.values??{};
    const score=o=>STYLES[o.id].appeal({selfPreservation:0.5,community:0.5,craftsmanship:0.5,curiosity:0.5,sociability:0.5,tradition:0.5,...vals})
      +((stock[o.spec.material]??0)>=64?0.08:0)+(random()-0.5)*0.12;
    const pick=options.reduce((a,b)=>score(b)>score(a)?b:a);
    ballots[v.id]=pick.id;tally[pick.id]++;
  }
  const top=Math.max(...Object.values(tally)),tied=options.filter(o=>tally[o.id]===top);
  const winner=tied.find(o=>o.id===ballots[builder])??tied[0];
  return {winner,tally,ballots};
}
