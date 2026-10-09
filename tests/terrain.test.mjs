import test from 'node:test';
import assert from 'node:assert/strict';
import {findPits,fillsFor,tilesOf} from '../agent-core/skills/terrain.mjs';

const flat=(h=68,w=16)=>({x:300,z:70,width:w,depth:w,heights:Array(w*w).fill(h),liquid:Array(w*w).fill(false),natural:Array(w*w).fill(true),tops:Array(w*w).fill('GRASS_BLOCK')});
const set=(sv,i,k,props)=>{const n=k*sv.width+i;for(const [key,v] of Object.entries(props))sv[key][n]=v;};
test('a crater in level ground is found and filled up to the level around it',()=>{
  const sv=flat();set(sv,5,5,{heights:65});set(sv,6,5,{heights:66});
  const pits=findPits(sv);
  assert.deepEqual(pits.map(p=>[p.x,p.z,p.top,p.level]),[[305,75,65,68],[306,75,66,68]]);
  assert.equal(fillsFor(pits).length,5,'3 + 2 blocks of dirt');assert.equal(fillsFor(pits)[0].y,66,'bottom up');
});
test('never: a house beside the ground, a tree, water, a ravine, a slope, or ground a player dug',()=>{
  const house=flat();for(let i=3;i<=7;i++)for(let k=3;k<=7;k++)set(house,i,k,{heights:74,natural:false,tops:'STONE_BRICKS'});
  assert.equal(findPits(house).length,0,'roofs are not ground: no "pit" beside the house');
  const water=flat();set(water,5,5,{heights:63,liquid:true});assert.equal(findPits(water).length,0);
  const ravine=flat();set(ravine,5,5,{heights:55});assert.equal(findPits(ravine).length,0);
  const slope=flat();for(let k=0;k<16;k++)for(let i=0;i<16;i++)set(slope,i,k,{heights:60+i});assert.equal(findPits(slope).length,0,'a hillside is not a crater');
  const dug=flat();set(dug,5,5,{heights:65});assert.equal(findPits(dug,{skip:(x,z)=>x===305&&z===75}).length,0,'a player dug it');
});
test('the sweep covers the whole town box in 16-block tiles',()=>{
  const t=tilesOf({x1:226,z1:50,x2:330,z2:170});assert.equal(t.length,7*8);assert.deepEqual(t[0],{x:226,z:50});
});
