import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lampPlan,lampSiteSafe} from '../agent-core/lighting.mjs';
test('street post has supported hanging lights and clear walking height',()=>{
 const p=lampPlan({x:10,y:70,z:10});
 assert.equal(p.filter(b=>b.block==='LANTERN').length,2);
 assert.ok(p.filter(b=>b.block==='LANTERN').every(b=>b.y>=73&&p.some(s=>s.x===b.x&&s.z===b.z&&s.y===b.y+1)));
 assert.equal(p.filter(b=>b.block==='CHISELED_STONE_BRICKS').length,5);
});
test('posts never overwrite fixtures, crops, door approaches or nearby lights',()=>{
 const p={x:10,y:70,z:10},cells=[[10,69,10,'GRASS_BLOCK',true]];
 assert.equal(lampSiteSafe(p,cells,[]),true);
 for(const [x,y,z,type] of [[10,70,10,'LANTERN'],[12,70,10,'SPRUCE_DOOR'],[9,69,10,'FARMLAND'],[11,72,10,'STONE']])
  assert.equal(lampSiteSafe(p,[...cells,[x,y,z,type,true]],[]),false,type);
 assert.equal(lampSiteSafe(p,cells,[{x:16,z:10}]),false);
 assert.equal(lampSiteSafe(p,null,[]),false);
 assert.equal(lampSiteSafe(p,cells,[],new Set(['11,10'])),false,'keep future road space clear');
});
test('arms can follow a narrow street without replacing the adjacent roof',()=>{
 const p={x:10,y:70,z:10,axis:'z'};
 assert.equal(lampSiteSafe(p,[[10,69,10,'GRASS_BLOCK',true],[9,74,10,'SPRUCE_PLANKS',true]],[]),true);
 assert.ok(lampPlan(p).filter(b=>b.block==='LANTERN').every(b=>b.x===10));
});
