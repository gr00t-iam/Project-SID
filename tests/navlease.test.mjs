import test from 'node:test';
import assert from 'node:assert/strict';
import {navGuard,navPriority,destKey} from '../agent-core/navlease.mjs';

const walking={pathing:true},still={pathing:false};
const go=(x,z)=>({type:'pathfind',x,y:64,z});
test('a lower-priority job cannot redirect a citizen another job is walking; equal or higher can',()=>{
  const leases=new Map(),blocked=new Map(),t=1000;
  navGuard('a',go(10,10),{ctx:{agent:'a',worker:true,job:'work order / goal',priority:navPriority('work order / goal')},leases,blocked,self:still,now:t});
  assert.throws(()=>navGuard('a',go(50,50),{ctx:{agent:'a',worker:true,job:'hobby: reading',priority:navPriority('hobby: reading')},leases,blocked,self:walking,now:t+5000}),/Busy/);
  navGuard('a',go(12,12),{ctx:{agent:'a',worker:true,job:'work order / goal',priority:2},leases,blocked,self:walking,now:t+6000});   // same job: fine
  navGuard('a',go(0,0),{ctx:{agent:'a',worker:true,job:'urgent',priority:navPriority('urgent')},leases,blocked,self:walking,now:t+7000});   // higher: takes over
  assert.equal(leases.get('a').job,'urgent');
});
test('a model turn may not move a citizen while a job walks it; it may once it arrives or the lease ages out',()=>{
  const leases=new Map([['a',{job:'build',priority:2,at:1000}]]),blocked=new Map();
  assert.throws(()=>navGuard('a',go(5,5),{ctx:{agent:'a',model:true},leases,blocked,self:walking,now:2000}),/walking you somewhere/);
  navGuard('a',go(5,5),{ctx:{agent:'a',model:true},leases,blocked,self:still,now:2000});
  navGuard('a',go(5,5),{ctx:{agent:'a',model:true},leases,blocked,self:walking,now:70000});
  navGuard('a',{type:'wait',x:0,y:0,z:0},{ctx:{override:true},leases,blocked,self:walking,now:2000});   // the watchdog always passes
  navGuard('a',{type:'chat',x:0,y:0,z:0,text:'hi'},{ctx:{agent:'a',model:true},leases,blocked,self:walking,now:2000});   // not a move
});
test('a destination that stalled twice is refused until it expires',()=>{
  const blocked=new Map([['a',new Map([[destKey({x:286.5,z:107.5}),{n:2,until:5000}]])]]);
  assert.throws(()=>navGuard('a',go(286.5,107.5),{ctx:{agent:'a',worker:true,job:'urgent',priority:3},leases:new Map(),blocked,self:still,now:1000}),/stalled twice/);
  navGuard('a',go(286.5,107.5),{ctx:{agent:'a',worker:true,job:'urgent',priority:3},leases:new Map(),blocked,self:still,now:6000});
});
