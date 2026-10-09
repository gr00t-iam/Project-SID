// Building sites and farm plots, as pure functions (civic.mjs applies them to the world).
//
// Sites: before a public building starts, the builder surveys the planned spot and nearby alternatives and takes
// the flattest one that is open natural ground (not water, not a road or a farm, nothing a player or agent built).
// The blueprint then gets site preparation: natural ground inside the building's volume is cleared (top down),
// and dips under the floor get a foundation.
// Farm plots: farmland found in the town (usually plots a player made for the villagers) is grouped into plots,
// split into tiles of at most 10 x 10 (the plugin's tend area), each with the crop that grows there.
import Ajv from 'ajv';

/** Bounding box of blueprint blocks. */
export function footprintOf(blocks){
  const xs=blocks.map(b=>b.x),ys=blocks.map(b=>b.y),zs=blocks.map(b=>b.z);
  return {x1:Math.min(...xs),x2:Math.max(...xs),z1:Math.min(...zs),z2:Math.max(...zs),y1:Math.min(...ys),y2:Math.max(...ys)};
}
/** Candidate corners in rings around (x,z): the planned spot first, then outward. */
export function spiral(x,z,step=4,rings=2){
  const out=[[x,z]];
  for(let r=1;r<=rings;r++)for(let i=-r;i<=r;i++)for(let k=-r;k<=r;k++)if(Math.max(Math.abs(i),Math.abs(k))===r)out.push([x+i*step,z+k*step]);
  return out;
}
/** The survey value for column (x,z), or undefined outside the survey. */
export function cellOf(survey,x,z,key='heights'){
  const i=x-survey.x,k=z-survey.z;
  if(i<0||k<0||i>=survey.width||k>=survey.depth)return undefined;
  return survey[key]?.[k*survey.width+i];
}
/**
 * How good a footprint is as a building site, from a survey that covers it.
 * floor = the most common ground height (the building's floor goes one above it); cut = blocks of ground to
 * clear, fill = blocks of foundation to add. Water, unloaded ground and anything built reject the spot.
 */
export function scoreSite(survey,fp,{maxCut=40,maxFill=12,maxWork=2500,allowReclamation=false}={}){
  const hs=[],dry=[];
  for(let x=fp.x1;x<=fp.x2;x++)for(let z=fp.z1;z<=fp.z2;z++){
    const h=cellOf(survey,x,z);
    if(h==null)return {ok:false,reason:'not surveyed or not loaded'};
    const wet=cellOf(survey,x,z,'liquid'),water=wet&&cellOf(survey,x,z,'tops')==='WATER';
    if(wet&&!(allowReclamation&&water))return {ok:false,reason:'water'};
    if(survey.natural&&cellOf(survey,x,z,'natural')===false&&!(allowReclamation&&water))return {ok:false,reason:`built on (${cellOf(survey,x,z,'tops')?.toLowerCase()?.replace(/_/g,' ')??'something'} at ${x},${z})`};
    hs.push(h);
    if(!wet)dry.push(h);
  }
  if(allowReclamation&&!dry.length)return {ok:false,reason:'offshore site has no adjoining dry land'};
  const counts=new Map();(allowReclamation?dry:hs).forEach(h=>counts.set(h,(counts.get(h)??0)+1));
  const floor=[...counts].sort((a,b)=>b[1]-a[1]||b[0]-a[0])[0][0];
  const up=Math.max(...hs)-floor,down=floor-Math.min(...hs);
  if(up>maxCut)return {ok:false,reason:`too steep (${up} blocks of hill)`};
  if(down>maxFill)return {ok:false,reason:`too uneven (${down} deep)`};
  const cut=hs.reduce((s,h)=>s+Math.max(0,h-floor),0),fill=hs.reduce((s,h)=>s+Math.max(0,floor-h),0);
  if(cut+fill>maxWork)return {ok:false,reason:`too much earthwork (${cut+fill} blocks)`};
  return {ok:true,floor,cut,fill,score:cut+1.5*fill,maxHeight:Math.max(...hs)};
}
/**
 * Site preparation for a blueprint standing on base y (its lowest block): clear natural ground inside the
 * building's volume and lay a foundation under the floor where the ground dips. Survey must cover the footprint.
 */
export function preparationOps(blocks,survey,{foundation='COBBLESTONE',maxFill=4}={}){
  const fp=footprintOf(blocks),clear=[],fill=[];let blocked=0;
  for(let x=fp.x1;x<=fp.x2;x++)for(let z=fp.z1;z<=fp.z2;z++){
    const h=cellOf(survey,x,z);if(h==null)continue;
    if(h>=fp.y1){
      if(cellOf(survey,x,z,'natural')===false){blocked++;continue;}
      for(let y=Math.min(h,fp.y2);y>=fp.y1;y--)clear.push({x,y,z,block:'CLEAR',clear:true});
    }else for(let y=Math.max(h+1,fp.y1-maxFill);y<fp.y1;y++)fill.push({x,y,z,block:foundation});
  }
  return {clear,fill,blocked};
}

// ---------------------------------------------------------------- terraforming (3D)
/**
 * Levels a building site from a 3D scan (plugin `scan` cells: [x,y,z,type,solid,natural,liquid], air omitted).
 * - Inside the building's volume (footprint, floor+1 .. top) and a walkway ring around it (floor+1 .. floor+3):
 *   natural blocks are dug out, top down (hills, trees, boulders); anything built is left and reported.
 * - Under the footprint: every column is made solid from the highest solid ground up to the floor (dips, ponds,
 *   overhangs), with dirt below and the given surface block on top. Columns with no ground in the scanned depth
 *   are reported (a cave or a cliff edge) instead of being bridged blindly.
 * Returns {clear, fill, blocked, unsupported}; clear ops carry `expected` so the plugin skips a block that changed.
 */
export function planTerrain3D(cells,fp,floorY,topY,{ring=1,clearance=3,foundation='COBBLESTONE',deep='COBBLESTONE',maxDepth=12}={}){
  const at=new Map(cells.map(c=>[`${c[0]},${c[1]},${c[2]}`,c]));
  const clear=[],fill=[];let blocked=0,unsupported=0;
  const inFp=(x,z)=>x>=fp.x1&&x<=fp.x2&&z>=fp.z1&&z<=fp.z2;
  for(let x=fp.x1-ring;x<=fp.x2+ring;x++)for(let z=fp.z1-ring;z<=fp.z2+ring;z++){
    const inside=inFp(x,z),top=inside?topY:floorY+clearance;
    for(let y=top;y>floorY;y--){
      const c=at.get(`${x},${y},${z}`);if(!c||c[6])continue;           // air or liquid
      if(c[5])clear.push({x,y,z,block:'CLEAR',clear:true,expected:c[3]});else blocked++;
    }
    if(!inside)continue;
    let ground=null;
    for(let y=floorY;y>=floorY-maxDepth;y--){const c=at.get(`${x},${y},${z}`);if(c&&c[4]&&!c[6]){ground=y;break;}}
    if(ground===null){unsupported++;continue;}
    for(let y=ground+1;y<=floorY;y++){const c=at.get(`${x},${y},${z}`);fill.push({x,y,z,block:y===floorY?foundation:deep,...(c?.[3]==='WATER'?{reclaim:true}:{})});}
  }
  return {clear,fill,blocked,unsupported};
}

// ---------------------------------------------------------------- validation of planned world edits
const EDIT_SCHEMA={type:'object',required:['x','y','z','block'],properties:{
  x:{type:'integer',minimum:-29999984,maximum:29999984},y:{type:'integer',minimum:-64,maximum:319},z:{type:'integer',minimum:-29999984,maximum:29999984},
  block:{type:'string',pattern:'^[A-Z][A-Z0-9_]{1,63}$'},clear:{type:'boolean'},expected:{type:'string',pattern:'^[A-Z][A-Z0-9_]{1,63}$'},
  facing:{type:'string',maxLength:16},stand:{type:'object'},tries:{type:'integer'},reclaim:{type:'boolean'}}};
const validEdit=new Ajv({allErrors:true}).compile(EDIT_SCHEMA);
/**
 * Keeps only well-formed edits that lie inside `box` ({x1,x2,y1,y2,z1,z2}, inclusive): a bad coordinate or a block
 * outside the planned site never reaches the world. Returns {ok, rejected:[{op,why}]}.
 */
export function validateEdits(ops,box){
  const ok=[],rejected=[];
  for(const op of ops){
    if(!validEdit(op)){rejected.push({op,why:validEdit.errors.map(e=>`${e.instancePath||'/'} ${e.message}`).join('; ')});continue;}
    if(op.x<box.x1||op.x>box.x2||op.z<box.z1||op.z>box.z2||op.y<box.y1||op.y>box.y2){rejected.push({op,why:'outside the site'});continue;}
    ok.push(op);
  }
  return {ok,rejected};
}
/** Boxes of at most 8 x 16 x 8 covering a region, for the plugin's scan action. */
export function scanPages(box){
  const out=[];
  for(let x=box.x1;x<=box.x2;x+=8)for(let z=box.z1;z<=box.z2;z+=8)for(let y=box.y1;y<=box.y2;y+=16)
    out.push({x,y,z,width:Math.min(8,box.x2-x+1),height:Math.min(16,box.y2-y+1),depth:Math.min(8,box.z2-z+1)});
  return out;
}

// ---------------------------------------------------------------- farm plots
export const SEED_FOR={WHEAT:'WHEAT_SEEDS',CARROTS:'CARROT',POTATOES:'POTATO',BEETROOTS:'BEETROOT_SEEDS'};
export const TILE=10;
/**
 * Groups farmland cells ([x,y,z,cropAbove,agentCrop]) into plots (4-neighbour, within 1 block of height) and
 * splits each into tiles of at most TILE x TILE. Plots smaller than minCells are ignored (a stray tilled block).
 */
export function farmPlots(cells,{minCells=4}={}){
  const at=new Map(cells.map(c=>[`${c[0]},${c[2]}`,c])),seen=new Set(),plots=[];
  for(const c of cells){
    const k0=`${c[0]},${c[2]}`;if(seen.has(k0))continue;
    const group=[],stack=[c];seen.add(k0);
    while(stack.length){
      const cur=stack.pop();group.push(cur);
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const k=`${cur[0]+dx},${cur[2]+dz}`,n=at.get(k);
        if(n&&!seen.has(k)&&Math.abs(n[1]-cur[1])<=1){seen.add(k);stack.push(n);}
      }
    }
    if(group.length<minCells)continue;
    const xs=group.map(g=>g[0]),zs=group.map(g=>g[2]);
    const x1=Math.min(...xs),x2=Math.max(...xs),z1=Math.min(...zs),z2=Math.max(...zs);
    const tiles=[];
    for(let tx=x1;tx<=x2;tx+=TILE)for(let tz=z1;tz<=z2;tz+=TILE){
      const mine=group.filter(g=>g[0]>=tx&&g[0]<tx+TILE&&g[2]>=tz&&g[2]<tz+TILE);if(!mine.length)continue;
      const mx1=Math.min(...mine.map(g=>g[0])),mx2=Math.max(...mine.map(g=>g[0])),mz1=Math.min(...mine.map(g=>g[2])),mz2=Math.max(...mine.map(g=>g[2]));
      const w=mx2-mx1+1,d=mz2-mz1+1;
      const crops=new Map();for(const g of mine)if(SEED_FOR[g[3]])crops.set(g[3],(crops.get(g[3])??0)+1);
      const crop=[...crops].sort((a,b)=>b[1]-a[1])[0]?.[0]??'WHEAT';
      // The plugin tends width x depth around a centre block: centre = x1 + floor(w/2).
      tiles.push({x1:mx1,z1:mz1,x2:mx2,z2:mz2,w,d,cx:mx1+Math.floor(w/2),cz:mz1+Math.floor(d/2),y:Math.round(mine.reduce((s,g)=>s+g[1],0)/mine.length),
        crop,seed:SEED_FOR[crop],cells:mine.length});
    }
    plots.push({id:`plot:${x1},${z1}`,x1,z1,x2,z2,cells:group.length,tiles,cellList:group.map(g=>[g[0],g[2]])});
  }
  return plots;
}
