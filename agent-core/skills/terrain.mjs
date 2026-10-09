// Terrain repair: craters in the town's ground (an enderman's missing grass, an old creeper blast) filled level.
//
// The plugin remembers blocks an explosion or a mob destroys and the repair crew puts them back (civic repairJob).
// Craters from before that, or that it never saw, stay - like the two east of the village street. A slow sweep of the
// town (one 16 x 16 survey tile at a time) finds pits: natural ground two or more blocks below the median of the
// ground around it. Each pit becomes dirt to place, up to the level around it, for the same repair crew.
// Never filled: water, anything built (by a player or an agent), the mine and excavation sites, and ground a player
// dug in the last day (a pond or a cellar the mayor is making is not a crater).

export const TILE=16,DEPTH=2;
const median=a=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};

/** The tiles that cover a box (x1..x2, z1..z2), in sweep order. */
export function tilesOf({x1,z1,x2,z2}){
  const out=[];for(let z=z1;z<=z2;z+=TILE)for(let x=x1;x<=x2;x+=TILE)out.push({x,z});return out;
}
/**
 * Pits in one survey ({x,z,width,depth,heights,liquid,natural}): [{x,z,top,level}] - fill from top+1 up to level.
 * skip(x,z) -> true for columns never to touch.
 */
export function findPits(survey,{skip=()=>false,depth=DEPTH}={}){
  const {x:x0,z:z0,width:w,depth:d,heights,liquid=[],natural=[],tops=[]}=survey,at=(i,k)=>i<0||k<0||i>=w||k>=d?null:k*w+i,out=[];
  for(let k=0;k<d;k++)for(let i=0;i<w;i++){
    const n=at(i,k),h=heights[n];
    const tree=t=>/_LOG$|_LEAVES$|_WOOD$/.test(t??"");
    if(!Number.isFinite(h)||liquid[n]||natural[n]===false||tree(tops[n])||skip(x0+i,z0+k))continue;
    const ring=[];
    for(let dk=-2;dk<=2;dk++)for(let di=-2;di<=2;di++){
      // Only natural ground around it counts: a house next to it reports its roof, a tree its trunk.
      if(!di&&!dk)continue;const m=at(i+di,k+dk);if(m==null||!Number.isFinite(heights[m])||liquid[m]||natural[m]===false||tree(tops[m]))continue;ring.push(heights[m]);
    }
    if(ring.length<8)continue;
    // A crater sits in level ground: not a slope or a valley (the ground around varies by 3 at most), and not a
    // ravine (6 or more deep).
    const level=median(ring),spread=Math.max(...ring)-Math.min(...ring);
    if(level-h>=depth&&level-h<=6&&spread<=3+Math.max(0,level-h-2)&&ring.filter(v=>v>h).length>=ring.length*0.75)out.push({x:x0+i,z:z0+k,top:h,level});
  }
  return out;
}
/** The dirt to place for a list of pits: [{x,y,z}] bottom up (each column from top+1 to level). */
export const fillsFor=pits=>pits.flatMap(p=>Array.from({length:p.level-p.top},(_,j)=>({x:p.x,y:p.top+1+j,z:p.z}))).sort((a,b)=>a.y-b.y);
