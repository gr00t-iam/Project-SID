import test from 'node:test';
import assert from 'node:assert/strict';
import {blueprint,MAX_BLOCKS} from '../agent-core/blueprints.mjs';
const at=(blocks,x,y,z)=>blocks.find(b=>b.x===x&&b.y===y&&b.z===z)?.block;
const unique=blocks=>new Set(blocks.map(b=>`${b.x},${b.y},${b.z}`)).size===blocks.length;

test('floor fills the rectangle once',()=>{
  const b=blueprint({shape:'floor',width:3,depth:2,material:'stone_bricks'},10,64,20);
  assert.equal(b.length,6);assert.ok(unique(b));assert.equal(at(b,12,64,21),'STONE_BRICKS');
});
test('walls are hollow, leave a 1x2 doorway and use trim on corners',()=>{
  const b=blueprint({shape:'walls',width:5,depth:5,height:3,material:'COBBLESTONE',trim:'OAK_LOG',door:'south'},0,64,0);
  assert.ok(unique(b));
  assert.equal(at(b,2,64,2),undefined,'interior stays empty');
  assert.equal(at(b,2,64,4),undefined);assert.equal(at(b,2,65,4),undefined,'doorway two high');
  assert.equal(at(b,2,66,4),'COBBLESTONE','lintel above door');
  assert.equal(at(b,0,64,0),'OAK_LOG');assert.equal(b.length,16*3-2);
});
test('house has floor, walls, windows, pyramid roof and a lantern, ordered bottom-up',()=>{
  const b=blueprint({shape:'house',width:7,depth:7,height:4,material:'STONE_BRICKS',roof:'SPRUCE_PLANKS'},100,70,100);
  assert.ok(unique(b));
  for(let i=1;i<b.length;i++)assert.ok(b[i].y>=b[i-1].y,'bottom-up order');
  assert.equal(at(b,103,70,103),'STONE_BRICKS','floor');
  assert.equal(at(b,103,71,103),'LANTERN');
  assert.ok(b.some(x=>x.block==='GLASS_PANE'),'windows');
  assert.equal(at(b,99,75,99),'SPRUCE_PLANKS','roof overhang starts above the walls');
  assert.equal(Math.max(...b.map(x=>x.y)),75+4,'roof rises to a peak');
});
test('path connects both ends at the requested width',()=>{
  const b=blueprint({shape:'path',x2:6,z2:0,width:1},0,64,0);
  assert.equal(b.length,7);assert.equal(at(b,6,64,0),'GRAVEL');
});
test('bad shapes and oversized plans are rejected; sizes are clamped',()=>{
  assert.throws(()=>blueprint({shape:'castle'},0,0,0),/Unknown shape/);
  assert.throws(()=>blueprint({shape:'house',width:3,depth:3},0,0,0),/at least 5/);
  assert.equal(blueprint({shape:'floor',width:99,depth:99},0,0,0).length,225);
  assert.throws(()=>blueprint({shape:'box',width:15,depth:15,height:8},0,0,0),/too large/);
  assert.ok(blueprint({shape:'box',width:9,depth:9,height:4},0,0,0).length<=MAX_BLOCKS);
});
test('house beds sit opposite the door and never block the doorway or lantern',()=>{
  for(const door of ['east','west','north','south']){
    const b=blueprint({shape:'house',width:5,depth:5,height:3,door,bed:true},0,64,0);
    const bed=b.find(x=>x.block==='RED_BED');
    assert.ok(bed,`bed with ${door} door`);assert.equal(bed.facing,'SOUTH');
    const head={x:bed.x,z:bed.z+1};
    for(const p of [bed,head])assert.ok(p.x>=1&&p.x<=3&&p.z>=1&&p.z<=3,'inside the walls');
    const lantern=b.find(x=>x.block==='LANTERN');
    assert.ok(!(lantern.x===head.x&&lantern.z===head.z)&&!(lantern.x===bed.x&&lantern.z===bed.z));
    const doorway={east:[4,2],west:[0,2],north:[2,0],south:[2,4]}[door];
    assert.ok(Math.abs(bed.x-doorway[0])+Math.min(Math.abs(bed.z-doorway[1]),Math.abs(head.z-doorway[1]))>=2,'not right inside the door');
  }
});
test('public building shapes are well formed and furnished',()=>{
  for(const shape of ['well','tower','pavilion','hall','warehouse','library','forge','windmill']){
    const b=blueprint({shape},0,64,0);
    assert.ok(b.length>8,`${shape} has blocks`);
    assert.ok(new Set(b.map(x=>`${x.x},${x.y},${x.z}`)).size===b.length,`${shape} has no duplicate positions`);
    for(let i=1;i<b.length;i++)assert.ok(b[i].y>=b[i-1].y,`${shape} bottom-up`);
  }
  assert.equal(blueprint({shape:'warehouse'},0,64,0).filter(x=>x.block==='CHEST').length,8);
  assert.ok(blueprint({shape:'library'},0,64,0).some(x=>x.block==='BOOKSHELF'));
  assert.ok(blueprint({shape:'forge'},0,64,0).some(x=>x.block==='ANVIL'));
  assert.ok(blueprint({shape:'windmill'},0,64,0).some(x=>x.block==='WHITE_WOOL'));
  assert.ok(blueprint({shape:'well'},0,64,0).some(x=>x.block==='CAULDRON'));
});
