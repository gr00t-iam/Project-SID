// Dwellings and private property. Every citizen has a dwelling: a house lot on the village street (config/village.json)
// with their own bed and a private chest beside it. Until the house is built the dwelling is a camp at the citizen's
// post (still their bed spot). Private chests are not the town's: the warehouse never counts them (plugin
// "property" registry), and opening someone else's is refused unless the sheriff searches under a court warrant -
// or it is a theft, which the court hears.

/** Bed and private chest positions inside a 5 x 5 house (blueprints.mjs 'house'): bed against the far wall, chest at its foot. */
export function dwellingOf(id,lot,{floorY=null,post=null}={}){
  if(!lot){
    return {dwelling_id:`D-${id}`,kind:'camp',bed_coordinates:post?{x:post[0],y:floorY,z:post[1]}:null,private_chest_coordinates:null};
  }
  const w=5,d=5,door=lot.door??'south';
  const bx=door==='east'?lot.x+1:door==='west'?lot.x+w-2:lot.x+1;
  const bz=door==='north'?lot.z+d-3:lot.z+1;
  const y=floorY!=null?floorY:null;
  return {dwelling_id:`D-${id}`,kind:'house',lot:{x:lot.x,z:lot.z,door},
    bed_coordinates:{x:bx,y,z:bz},
    // The bed is two blocks long (bz, bz+1); the chest goes at its foot end on the same side.
    private_chest_coordinates:{x:bx,y,z:door==='north'?bz-1:bz+2}};
}
/**
 * May `actor` open `owner`'s private chest? 'own' | 'search' (the sheriff with a warrant or an open investigation of
 * the owner) | 'theft' (anyone else: allowed physically, but it is a crime).
 */
export function accessOf(actor,owner,{role=null,warrantFor=[]}={}){
  if(actor===owner)return 'own';
  if(role==='sheriff'&&warrantFor.includes(owner))return 'search';
  return 'theft';
}
/** Nine more house lots continuing the village street south (west side x294, east side x304), for the newer citizens. */
export const NEW_LOTS=[
  {x:294,z:107,door:'east'},{x:304,z:117,door:'west'},{x:294,z:114,door:'east'},{x:304,z:124,door:'west'},{x:294,z:121,door:'east'},
  {x:304,z:131,door:'west'},{x:294,z:128,door:'east'},{x:304,z:138,door:'west'},{x:294,z:135,door:'east'},
  // Two more at the south end (for the Judge and the Warehouse Clerk), short of the library site (z 153).
  {x:294,z:142,door:'east'},{x:304,z:145,door:'west'},
];
const STYLES=[['OAK_PLANKS','OAK_LOG','SPRUCE_PLANKS','OAK_PLANKS','RED_BED'],['SPRUCE_PLANKS','STRIPPED_OAK_LOG','BRICKS','OAK_PLANKS','BLUE_BED'],
  ['BIRCH_PLANKS','SPRUCE_LOG','SPRUCE_PLANKS','OAK_PLANKS','GREEN_BED'],['COBBLESTONE','OAK_LOG','SPRUCE_PLANKS','SPRUCE_PLANKS','YELLOW_BED']];
/** Lots for the citizens without one, in order, never on a lot already taken. */
export function assignLots(homes,ids){
  const taken=new Set(Object.values(homes).map(h=>`${h.x},${h.z}`)),out={};
  const free=NEW_LOTS.filter(l=>!taken.has(`${l.x},${l.z}`));
  ids.filter(id=>!homes[id]).forEach((id,i)=>{const l=free[i];if(!l)return;const s=STYLES[i%STYLES.length];
    out[id]={...l,material:s[0],trim:s[1],roof:s[2],floor:s[3],bed:s[4],assigned:true};});
  return out;
}
