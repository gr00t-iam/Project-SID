import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgePlan} from '../agent-core/town.mjs';

// Heights measured at the north crossing (x 282-285, z 64-88); "w" = water surface.
const RAW={
  282:'64:69 65:71 66:69 67:68 68:68 69:67 70:65 71:62w 72:62w 73:62w 74:62w 75:62w 76:62w 77:62w 78:62w 79:62w 80:62w 81:62 82:65 83:66 84:67 85:67 86:67 87:67 88:67',
  283:'64:69 65:69 66:68 67:68 68:67 69:66 70:64 71:62w 72:62 73:62 74:62 75:62 76:62 77:62 78:62 79:62 80:62 81:64 82:65 83:66 84:67 85:67 86:67 87:67 88:67',
  284:'64:69 65:68 66:68 67:68 68:67 69:65 70:62w 71:62w 72:62 73:62 74:62 75:62 76:62 77:62 78:62 79:62 80:62 81:64 82:65 83:66 84:67 85:67 86:67 87:67 88:67',
  285:'64:69 65:69 66:67 67:67 68:66 69:64 70:62w 71:62w 72:62w 73:62w 74:62w 75:62w 76:62w 77:62w 78:62w 79:65 80:63 81:65 82:65 83:66 84:67 85:67 86:67 87:67 88:67'};
const heights=new Map(),water=new Set();
for(const [x,row] of Object.entries(RAW))for(const cell of row.split(' ')){const [z,h]=cell.split(':');heights.set(`${x},${z}`,parseInt(h));if(h.endsWith('w'))water.add(`${x},${z}`);}

test('north bridge: raised deck, walkable ramps at both banks, railings and shore standing spots',()=>{
  const {blocks,deck}=bridgePlan({a:{x:283,z:86},b:{x:283,z:70},width:2},heights,water,new Set(['282,72','282,73']));
  const deckAt=(x,z)=>blocks.find(b=>b.x===x&&b.z===z&&b.block==='OAK_PLANKS')?.y;
  // Deck one above the water across the lake (the old water-level planks count as lake).
  for(let z=72;z<=80;z++)assert.equal(deckAt(283,z),63,`deck at z${z}`);
  // Ramps up to the higher north bank one block per step: z71 64, z70 65; north bank z69 stands at 67.
  assert.equal(deckAt(283,71),64);assert.equal(deckAt(284,70),65);
  // South bank z81 top 64 (stand 65) is one step above the deck (stand 64).
  assert.ok(!deck.has('283,81'));
  // Every step along the road is at most one block from the next.
  const stand=z=>deck.has(`283,${z}`)||deck.has(`284,${z}`)?Math.max(deckAt(283,z)??-1,deckAt(284,z)??-1)+1:heights.get(`283,${z}`)+1;
  for(let z=69;z<=81;z++)assert.ok(Math.abs(stand(z)-stand(z+1))<=1,`step z${z}->z${z+1}`);
  // Railings on both sides over the water, but the lane junction at x282 z72-73 stays open.
  assert.ok(blocks.some(b=>b.x===285&&b.z===75&&b.block==='OAK_FENCE'));
  assert.ok(blocks.some(b=>b.x===282&&b.z===76&&b.block==='OAK_FENCE'));
  assert.ok(!blocks.some(b=>b.x===282&&(b.z===72||b.z===73)));
  assert.ok(blocks.some(b=>b.block==='LANTERN'));
  // Nothing is placed on dry bank columns, and every block says where to stand: on a bank, not the water.
  assert.ok(!blocks.some(b=>b.block==='OAK_FENCE'&&b.x===284&&b.z===69));
  for(const b of blocks){assert.ok(b.stand,'has a standing spot');assert.ok(b.stand.z<=69.5||b.stand.z>=81.5,`stands on a bank (${b.stand.z})`);
    assert.ok(Math.hypot(b.x+0.5-b.stand.x,b.y+0.5-b.stand.y,b.z+0.5-b.stand.z)<=10.5,`reachable from the bank: ${b.x},${b.y},${b.z}`);}
});
test('no water: no bridge',()=>{
  assert.equal(bridgePlan({a:{x:0,z:0},b:{x:0,z:5},width:2},new Map([['0,0',64]]),new Set()).blocks.length,0);
});
test('a finished deck without railings gets only its railings',()=>{
  // As built: deck at 63 on x283-284 z71-80, planks (no fences) along x285 z70-78, open water along x282.
  const h=new Map(heights),w=new Set(water);
  for(let z=71;z<=80;z++)for(const x of [283,284]){h.set(`${x},${z}`,63);w.delete(`${x},${z}`);}
  h.set('284,70',63);w.delete('284,70');
  for(let z=70;z<=78;z++){h.set(`285,${z}`,63);w.delete(`285,${z}`);}
  const {blocks}=bridgePlan({a:{x:283,z:86},b:{x:283,z:70},width:2},h,w,new Set(['282,72','282,73']));
  assert.ok(!blocks.some(b=>(b.x===283||b.x===284)&&b.block==='OAK_PLANKS'),'deck left alone');
  for(let z=74;z<=80;z++)assert.ok(blocks.some(b=>b.x===282&&b.z===z&&b.block==='OAK_FENCE'),`west rail z${z}`);
  for(let z=72;z<=78;z++)assert.ok(blocks.some(b=>b.x===285&&b.z===z&&b.block==='OAK_FENCE'&&b.y===64),`east fence z${z}`);
  assert.ok(!blocks.some(b=>b.x===285&&b.block==='OAK_PLANKS'),'east planks already there');
});

test('live state: planks along both sides, water left only at z71-73: fences go on the whole run',()=>{
  const h=new Map(heights),w=new Set(water);
  for(let z=70;z<=80;z++)for(const x of [283,284]){if(z===70&&x===283)continue;h.set(`${x},${z}`,63);w.delete(`${x},${z}`);}
  for(let z=70;z<=78;z++){h.set(`285,${z}`,63);w.delete(`285,${z}`);}
  for(let z=74;z<=80;z++){h.set(`282,${z}`,63);w.delete(`282,${z}`);}
  const {blocks}=bridgePlan({a:{x:283,z:86},b:{x:283,z:70},width:2},h,w,new Set(['282,72','282,73']));
  for(let z=74;z<=80;z++)assert.ok(blocks.some(b=>b.x===282&&b.z===z&&b.block==='OAK_FENCE'&&b.y===64),`west fence z${z}`);
  for(let z=72;z<=78;z++)assert.ok(blocks.some(b=>b.x===285&&b.z===z&&b.block==='OAK_FENCE'),`east fence z${z}`);
  assert.ok(!blocks.some(b=>b.block==='OAK_PLANKS'&&b.x>=282&&b.x<=285&&b.z>=74),'no new planks');
});
