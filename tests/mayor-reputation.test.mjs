import test from 'node:test';
import assert from 'node:assert/strict';
import {createLife} from '../agent-core/life.mjs';

function fixture(){
  const memory={data:{town:{mayor:'Mayor'},people:{Mayor:{reputation:10,facts:[]}},agents:{},conversations:[]}};
  const logs=[];
  const life=createLife({configs:[],memory,names:new Map(),log:(type,data)=>logs.push({type,...data}),getSnapshot:()=>({agents:[]})});
  return {life,memory,logs};
}
const block={x:1,y:64,z:2,type:'STONE'};
test('mayor edits do not penalize reputation, accuse them, or enqueue repairs',()=>{
  const {life,memory,logs}=fixture();
  for(let n=0;n<40;n++)life.onVandalism({player:'mayor',block});
  assert.equal(memory.data.people.Mayor.reputation,10);
  assert.deepEqual(memory.data.people.Mayor.facts,[]);
  assert.equal(memory.data.town.repairs,undefined);
  assert.deepEqual(memory.data.town.news,[]);
  assert.equal(logs.filter(e=>e.type==='reputation').length,0);
  assert.equal(logs.filter(e=>e.type==='town_edit').length,40);
});
test('other players retain damage penalties and repair requests',()=>{
  const {life,memory}=fixture();
  life.onVandalism({player:'Visitor',block});
  assert.equal(memory.data.people.Visitor.reputation,-8);
  assert.equal(memory.data.town.repairs.length,1);
});
test('mayor gifts still improve reputation',()=>{
  const {life,memory}=fixture();
  life.onTrade({kind:'received',from:'Mayor',agent:'builder',item:'SWEET_BERRIES',count:16});
  assert.equal(memory.data.people.Mayor.reputation,12);
});
