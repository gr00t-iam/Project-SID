import test from 'node:test';
import assert from 'node:assert/strict';
import {createClerk} from '../agent-core/roles/clerk.mjs';
import {WarehouseMap} from '../agent-core/skills/warehouse.mjs';
import {blueprint,bakeryLayout} from '../agent-core/blueprints.mjs';

function clerkWith({requests,stock=200,phase='day'}){
  const town={built:{warehouse:true},counter:{requests,served:0},clerk:{state:'IDLE',moves:0,filed:0,merged:0,lastIndex:Date.now(),jasperV1:true,stuck:{}}};
  const memory={data:{town}},gives=[],withdrawals=[],deposits=[];
  const map=new WarehouseMap({assign:{'282,70,102':'BUILDING_BLOCKS'}});
  const civic={warehouseMap:()=>map,counter:()=>town.counter,goToWarehouse:async()=>true,refreshStock:async()=>{},
    withdraw:async(id,item,count,opts)=>{withdrawals.push({id,item,count,opts});return Math.min(count,stock);},
    deposit:async(id,item,count)=>{deposits.push({item,count});return count;}};
  const act=async(id,a)=>{if(a.type==='give')gives.push({from:id,...a});return 'given';};
  const clerk=createClerk({phase:()=>phase,memory,act,say:async()=>{},civic:()=>civic,nameOf:id=>id,
    posOf:id=>({x:285,y:70,z:105}),walkTo:async()=>{}});
  return {clerk,town,gives,withdrawals,deposits};
}

test("Jasper serves the counter first: fetches on the asker's behalf and hands it over in stacks of 64",async()=>{
  const req={who:'chef',item:'WHEAT',count:100,status:'open',given:0,taken:false};
  const {clerk,gives,withdrawals}=clerkWith({requests:[req]});
  const job=clerk.job({id:'clerk',role:'clerk'},{},{x:286,y:70,z:107,inventory:{}},false);
  assert.ok(job);await job();
  assert.equal(withdrawals[0].opts.onBehalf,'chef');
  assert.deepEqual(gives.map(g=>[g.to,g.target,g.count]),[['chef','WHEAT',64],['chef','WHEAT',36]]);
  assert.equal(req.status,'done');assert.equal(req.given,100);
});

test('out of stock: the request is closed with nothing given; off duty (night) the counter is not served',async()=>{
  const req={who:'farmer',item:'DIAMOND',count:3,status:'open',given:0,taken:false};
  const a=clerkWith({requests:[req],stock:0});
  await a.clerk.job({id:'clerk',role:'clerk'},{},{x:286,y:70,z:107,inventory:{}},false)();
  assert.equal(req.status,'done');assert.equal(req.given,0);assert.equal(a.gives.length,0);
  const req2={who:'farmer',item:'BREAD',count:3,status:'open',given:0,taken:false};
  const b=clerkWith({requests:[req2],phase:'night'});
  const job=b.clerk.job({id:'clerk',role:'clerk'},{},{x:286,y:70,z:107,inventory:{}},false);
  if(job)await job();
  assert.equal(req2.taken,false);assert.equal(b.withdrawals.length,0);
});

test("the bakery: two furnaces, a crafting table and the pantry inside a 7 x 7 kitchen with the door east",()=>{
  const bp=blueprint({shape:'bakery'},100,64,200),count=b=>bp.filter(x=>x.block===b).length;
  assert.equal(count('FURNACE'),2);assert.equal(count('CRAFTING_TABLE'),1);assert.equal(count('CHEST'),1);assert.equal(count('BARREL'),2);
  const xs=bp.map(b=>b.x),zs=bp.map(b=>b.z);
  assert.ok(Math.max(...xs)-Math.min(...xs)<=8&&Math.max(...zs)-Math.min(...zs)<=8);
  // The east doorway (x+6, z+3) is open at both levels; the chef's place is free floor inside.
  assert.ok(!bp.some(b=>b.x===106&&b.z===203&&(b.y===65||b.y===66)));
  const L=bakeryLayout({x:100,y:64,z:200});
  assert.ok(!bp.some(b=>b.x===Math.floor(L.chef.x)&&b.z===Math.floor(L.chef.z)&&b.y===65));
});
