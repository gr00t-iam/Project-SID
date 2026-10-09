import test from 'node:test';
import assert from 'node:assert/strict';
import {footprintOf,spiral,scoreSite,preparationOps,farmPlots,cellOf,SEED_FOR} from '../agent-core/sites.mjs';
import {nextBuildStep,newProject} from '../agent-core/worker.mjs';

// A survey like the plugin's: rows of depth, each `width` columns; heights, liquid, tops, natural.
function survey(x,z,w,d,fn){
  const heights=[],liquid=[],tops=[],natural=[];
  for(let k=0;k<d;k++)for(let i=0;i<w;i++){const c=fn(x+i,z+k);heights.push(c.h);liquid.push(!!c.water);tops.push(c.top??'GRASS_BLOCK');natural.push(c.natural??true);}
  return {x,z,width:w,depth:d,heights,liquid,tops,natural};
}
const fp={x1:10,z1:10,x2:14,z2:13};

test('reclamation joins existing dry land and rejects entirely offshore or built sites',()=>{
 const coast=survey(9,9,7,6,x=>x>=13?{h:62,water:true,top:'WATER',natural:false}:{h:66});
 const r=scoreSite(coast,fp,{allowReclamation:true});assert.equal(r.ok,true);assert.equal(r.floor,66);assert.ok(r.fill>0);
 assert.equal(scoreSite(survey(9,9,7,6,()=>({h:62,water:true})),fp,{allowReclamation:true}).ok,false);
 const built=survey(9,9,7,6,x=>x>=13?{h:62,water:true,top:'WATER',natural:false}:{h:66,top:'FARMLAND',natural:false});
 assert.equal(scoreSite(built,fp,{allowReclamation:true}).ok,false);
});

test('site scoring: flat open ground is ideal; built, wet or steep ground is refused',()=>{
  const flat=scoreSite(survey(9,9,7,6,()=>({h:64})),fp);
  assert.deepEqual([flat.ok,flat.floor,flat.cut,flat.fill,flat.score],[true,64,0,0,0]);
  const bump=scoreSite(survey(9,9,7,6,(x)=>({h:x>=13?66:64})),fp);
  assert.equal(bump.ok,true);assert.equal(bump.cut,16,'two columns of 2 blocks, 4 deep');
  assert.match(scoreSite(survey(9,9,7,6,(x,z)=>x===12&&z===11?{h:65,top:'OAK_PLANKS',natural:false}:{h:64}),fp).reason,/built on \(oak planks at 12,11\)/);
  assert.equal(scoreSite(survey(9,9,7,6,(x,z)=>({h:62,water:x===11})),fp).reason,'water');
  // Terraforming levels slopes: steep ground is accepted and priced by its earthwork; explicit limits still apply.
  const slope=scoreSite(survey(9,9,7,6,(x)=>({h:x>=12?72:64})),fp);assert.equal(slope.ok,true);assert.ok(slope.cut+slope.fill>0);
  assert.match(scoreSite(survey(9,9,7,6,(x)=>({h:x>=14?72:64})),fp,{maxCut:6}).reason,/too steep/);
  assert.match(scoreSite(survey(9,9,7,6,(x)=>({h:x>=14?100:64})),fp,{maxWork:100}).reason,/too much earthwork/);
  assert.equal(scoreSite(survey(12,9,7,6,()=>({h:64})),fp).ok,false,'survey must cover the footprint');
});
test('spiral: the planned spot first, then rings outward',()=>{
  const s=spiral(100,50,4,2);assert.deepEqual(s[0],[100,50]);assert.equal(s.length,25);
  assert.ok(s.slice(1,9).every(([x,z])=>Math.max(Math.abs(x-100),Math.abs(z-50))===4));
});
test('site preparation: clear natural ground inside the building, lay foundation under dips, never touch what is built',()=>{
  const blocks=[];for(let x=10;x<=12;x++)for(let z=10;z<=11;z++)for(let y=65;y<=67;y++)blocks.push({x,y,z,block:'OAK_PLANKS'});
  const sv=survey(10,10,3,2,(x,z)=>x===10?{h:66}:x===11?{h:62}:z===10?{h:66,top:'STONE_BRICKS',natural:false}:{h:64});
  const ops=preparationOps(blocks,sv);
  assert.deepEqual(ops.clear.map(b=>`${b.x},${b.y},${b.z}`),['10,66,10','10,65,10','10,66,11','10,65,11'],'top down, only natural columns');
  assert.deepEqual(ops.fill.map(b=>`${b.x},${b.y},${b.z}:${b.block}`),['11,63,10:COBBLESTONE','11,64,10:COBBLESTONE','11,63,11:COBBLESTONE','11,64,11:COBBLESTONE']);
  assert.equal(ops.blocked,1,'the stone-brick column is left alone');
  assert.equal(cellOf(sv,12,11),64);assert.deepEqual(footprintOf(blocks),{x1:10,x2:12,z1:10,z2:11,y1:65,y2:67});
});
test('building order: clearing first from the top down, then layers from the bottom up',()=>{
  const p=newProject('hall',[{x:0,y:65,z:0,block:'OAK_PLANKS'},{x:0,y:66,z:0,block:'CLEAR',clear:true},{x:0,y:65,z:0,block:'CLEAR',clear:true}]);
  const self={x:0.5,y:65,z:0.5};
  assert.deepEqual(nextBuildStep(p,self,10).blocks.map(b=>`${b.block}@${b.y}`),['CLEAR@66']);
  p.queue=p.queue.filter(b=>b.y!==66);assert.deepEqual(nextBuildStep(p,self,10).blocks.map(b=>`${b.block}@${b.y}`),['CLEAR@65']);
  p.queue=p.queue.filter(b=>!b.clear);assert.deepEqual(nextBuildStep(p,self,10).blocks.map(b=>b.block),['OAK_PLANKS']);
});
test('farm plots: farmland is grouped into plots, split into tiles of at most 10 x 10, each with its crop',()=>{
  const cells=[];
  for(let x=0;x<14;x++)for(let z=0;z<4;z++)cells.push([x,64,z,x<7?'WHEAT':'CARROTS',false]);   // one 14 x 4 plot
  for(let x=40;x<43;x++)for(let z=40;z<43;z++)cells.push([x,70,z,'AIR',false]);                  // a separate 3 x 3 plot, empty
  cells.push([90,64,90,'AIR',false]);                                                           // a stray tilled block
  const plots=farmPlots(cells);
  assert.equal(plots.length,2);
  const big=plots.find(p=>p.x1===0);assert.equal(big.cells,56);assert.equal(big.tiles.length,2);
  assert.deepEqual(big.tiles.map(t=>[t.w,t.d,t.crop,t.seed]),[[10,4,'WHEAT','WHEAT_SEEDS'],[4,4,'CARROTS','CARROT']]);
  assert.deepEqual([big.tiles[0].cx,big.tiles[0].cz],[5,2],'centre for the plugin tend area');
  assert.equal(plots.find(p=>p.x1===40).tiles[0].seed,'WHEAT_SEEDS','empty farmland gets wheat');
  assert.equal(SEED_FOR.POTATOES,'POTATO');
});

import {planTerrain3D,validateEdits,scanPages} from '../agent-core/sites.mjs';
test('3D terraforming: dig out the hill and trees in the volume, fill dips and ponds to the floor, leave built blocks',()=>{
  // Footprint 2 x 1 at x 0-1, z 0; floor at y 64 (building from 65 up to 67).
  const cells=[
    [0,63,0,'DIRT',true,true,false],[0,64,0,'DIRT',true,true,false],[0,65,0,'DIRT',true,true,false],[0,66,0,'OAK_LOG',true,true,false],   // a hill with a tree stump
    [1,61,0,'STONE',true,true,false],[1,62,0,'WATER',false,false,true],                                                                    // a pond: ground at 61
    [2,65,0,'OAK_PLANKS',true,false,false],                                                                                               // someone's fence post in the walkway ring
  ];
  const p=planTerrain3D(cells,{x1:0,x2:1,z1:0,z2:0},64,67,{deep:'DIRT'});
  assert.deepEqual(p.clear.map(o=>`${o.y}:${o.expected}`),['66:OAK_LOG','65:DIRT'],'top down, expected state recorded');
  assert.deepEqual(p.fill.map(o=>`${o.x},${o.y}:${o.block}`),['1,62:DIRT','1,63:DIRT','1,64:COBBLESTONE'],'water replaced, foundation on top');
  assert.equal(p.blocked,1,'the planks are left alone');
  const cave=planTerrain3D([],{x1:0,x2:0,z1:0,z2:0},64,66);assert.equal(cave.unsupported,1,'no ground in reach: reported, not bridged');
});
test('edit validation: malformed or out-of-site edits never reach the world',()=>{
  const box={x1:0,x2:10,z1:0,z2:10,y1:60,y2:80};
  const {ok,rejected}=validateEdits([{x:1,y:64,z:1,block:'CLEAR',clear:true,expected:'DIRT'},{x:11,y:64,z:1,block:'DIRT'},{x:1.5,y:64,z:1,block:'DIRT'},
    {x:1,y:400,z:1,block:'DIRT'},{x:1,y:64,z:1,block:'dirt;rm -rf'}],box);
  assert.equal(ok.length,1);assert.deepEqual(rejected.map(r=>r.why.includes('outside')?'outside':'schema'),['outside','schema','schema','schema']);
});
test('scan pages cover a region in boxes of at most 8 x 16 x 8',()=>{
  const pages=scanPages({x1:0,x2:12,z1:0,z2:10,y1:50,y2:80});
  assert.equal(pages.length,2*2*2);assert.ok(pages.every(p=>p.width<=8&&p.depth<=8&&p.height<=16));
  assert.equal(pages.reduce((n,p)=>n+p.width*p.depth*p.height,0),13*11*31,'no gaps or overlaps');
});
