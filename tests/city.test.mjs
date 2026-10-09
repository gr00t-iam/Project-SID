import test from 'node:test';
import assert from 'node:assert/strict';
import {createCityBoard,constructionGate,restorationPlan,renovationPlan,builderDuty} from '../agent-core/city.mjs';

test('Bram works the recovery queue in daylight and retains night rest',()=>{
 assert.equal(builderDuty('builder',false,{}, {priorityBuilds:['complete:35']}),true);
 assert.equal(builderDuty('builder',true,{}, {priorityBuilds:['complete:35']}),false);
 assert.equal(builderDuty('farmer',false,{}, {priorityBuilds:['complete:35']}),false);
 assert.equal(builderDuty('builder',false,{}, {city:{queue:[{kind:'new',site:'a'}]},built:{a:true}}),false);
});

test('approved renovation removes obsolete partitions and verifies open interior space',()=>{
 const p=renovationPlan([{x:0,y:0,z:0,block:'COBBLESTONE'}],[[0,0,0,'COBBLESTONE',true,false],[1,0,0,'IRON_BARS',true,false]],{x1:0,x2:1,y1:0,y2:0,z1:0,z2:0});
 assert.equal(p.queue.length,1);assert.equal(p.queue[0].demolish,true);
 assert.ok(p.expected.some(b=>b.x===1&&b.block==='AIR'));
});
test('renovation clears an occupied door head and rebuilds a door whose upper half is missing',()=>{
 const door={x:0,y:70,z:0,block:'IRON_DOOR'},box={x1:0,x2:0,y1:70,y2:71,z1:0,z2:0};
 const wrong=renovationPlan([door],[[0,70,0,'IRON_DOOR',true,false],[0,71,0,'COBBLESTONE',true,false]],box);
 assert.ok(wrong.queue.some(b=>b.y===71&&b.clear&&b.demolish));
 assert.ok(wrong.queue.some(b=>b.y===70&&b.block==='IRON_DOOR'));
 const missing=renovationPlan([door],[[0,70,0,'IRON_DOOR',true,false]],box);
 assert.ok(missing.queue.some(b=>b.y===70&&b.clear));
 assert.ok(missing.queue.some(b=>b.y===70&&b.block==='IRON_DOOR'));
});
function fixture(state={}){
 let time=Date.parse('2026-10-09T05:01:00Z'),calls=[],saves=0;
 const sites={library:{shape:'library',x:20,z:20}},town={sites:{library:{x:20,y:70,z:20}},built:{library:true},finishedSites:{},parkedProjects:[]},worker={};
 const board=createCityBoard({state,sites,town,now:()=>time,random:()=>0.4,save:async()=>{saves++;},projects:()=>worker.project?[worker.project]:[],start:async(c,s,site,name,extra)=>{calls.push(['start',site,name]);s.project={...extra,total:100,placed:0};return true;},finish:async(c,s,id)=>{calls.push(['finish',id]);s.project={publicWork:id,total:90,placed:20};return true;}});
 return {state,sites,town,worker,board,calls,setTime:t=>time=Date.parse(t),saves:()=>saves};
}
test('six distinct goals are issued once per Chicago calendar day',async()=>{const f=fixture();await f.board.tick();assert.equal(f.board.view().items.length,6);const ids=f.board.view().items.map(m=>m.id);await f.board.tick();assert.deepEqual(f.board.view().items.map(m=>m.id),ids);assert.equal(new Set(ids).size,6);});
test('finishing an existing shell is included, not replaced with a new site',async()=>{const f=fixture();await f.board.tick();assert.ok(f.board.view().items.some(m=>m.site==='library'&&m.kind==='finish'));await f.board.work({id:'builder'},f.worker);assert.equal(f.calls[0][0],'finish');assert.equal(f.calls[0][1],'library');});
test('daily rollover retains unfinished buildings and issues six fresh goals',async()=>{const f=fixture();await f.board.tick();const ids=f.board.view().items.map(m=>m.id);f.setTime('2026-10-10T05:01:00Z');await f.board.tick();assert.equal(f.board.view().items.length,6);assert.ok(f.board.view().items.every(m=>!ids.includes(m.id)));assert.ok(f.state.queue.some(m=>m.id===ids[0]));assert.ok(f.board.view().backlog>=6);});
test('restart restores generated site definitions and stable goals',async()=>{const f=fixture();await f.board.tick();const r=fixture(JSON.parse(JSON.stringify(f.state)));await r.board.tick();assert.deepEqual(r.board.view().items.map(m=>m.id),f.board.view().items.map(m=>m.id));assert.ok(r.board.view().items.filter(m=>m.kind==='new').every(m=>r.sites[m.site]));});
test('active and parked projects are never started twice; progress needs confirmed completion',async()=>{const f=fixture();await f.board.tick();await f.board.work({id:'builder'},f.worker);const m=f.board.view().items.find(m=>m.site===f.worker.project.publicWork);assert.equal(m.status,'in_progress');assert.notEqual(m.status,'completed');f.town.parkedProjects.push({project:f.worker.project});delete f.worker.project;await f.board.work({id:'builder'},f.worker);assert.equal(f.calls.filter(c=>c[1]===m.site).length,1);f.town.finishedSites[m.site]=1;assert.equal(f.board.view().items.find(i=>i.id===m.id).status,'completed');});
test('backward clock does not reset construction goals',async()=>{const f=fixture();await f.board.tick();f.setTime('2026-10-08T05:01:00Z');await f.board.tick();assert.equal(f.board.view().date,'2026-10-09');});

test('an unfinished blocked shell prevents starting a fresh building',async()=>{const f=fixture();await f.board.tick();const m=f.state.queue.find(m=>m.kind==='finish');m.retryAt=Date.parse('2026-10-09T08:00:00Z');await f.board.work({id:'builder'},f.worker);assert.equal(f.calls.length,0);});

test('Bram cannot abandon a build or start a new blueprint while one is paused',()=>{assert.match(constructionGate('builder','cancel',{project:{name:'hall'}},{}),/finish/i);assert.match(constructionGate('builder','house',{}, {parkedProjects:[{project:{name:'hall'}}]}),/paused/i);assert.equal(constructionGate('builder','house',{},{}),null);assert.equal(constructionGate('crafter','cancel',{project:{}},{}),null);});

test('restoration preserves existing finishes but verifies the whole structure',()=>{const blocks=[{x:1,y:1,z:1,block:'STONE_BRICKS'},{x:2,y:1,z:1,block:'STONE_BRICKS'},{x:3,y:1,z:1,block:'STONE_BRICKS'}];const p=restorationPlan(blocks,[[1,1,1,'STONE_BRICKS',true,false,false],[2,1,1,'COBBLESTONE',true,false,false]]);assert.equal(p.queue.length,1);assert.equal(p.expected.length,3);assert.equal(p.expected[1].block,'COBBLESTONE');});
