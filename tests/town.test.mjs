import test from 'node:test';
import assert from 'node:assert/strict';
import {updateNeeds,paceOf,wellbeing,levelOf,batchFor,dayPhase,newlyUnlocked,chooseProduction,roadColumns,lanternSpots,questReward,zoneFor,adjustAffinity,relationsOf,NEEDS_START} from '../agent-core/town.mjs';
test('needs drain with work, energy returns with rest, and pace slows when hungry or tired',()=>{
  const worked=updateNeeds(NEEDS_START,800,{working:true});
  assert.ok(worked.hunger<NEEDS_START.hunger-9&&worked.energy<NEEDS_START.energy-30,'a long working stretch makes an agent hungry and tired');
  assert.ok(updateNeeds({hunger:10,energy:10},60,{resting:true}).energy>40);
  assert.equal(paceOf({hunger:18,energy:90}),1);assert.equal(paceOf({hunger:4,energy:90}),2);assert.equal(paceOf({hunger:18,energy:10},5),2);
  assert.equal(wellbeing({hunger:18,energy:80}),'thriving');assert.equal(wellbeing({hunger:3,energy:80}),'starving');
});
test('skills level up and grow batches; day phases and milestones',()=>{
  assert.equal(levelOf(0),1);assert.equal(levelOf(150),3);assert.equal(levelOf(5000),5);assert.equal(batchFor(5),28);
  assert.equal(dayPhase(500),'dawn');assert.equal(dayPhase(6000),'day');assert.equal(dayPhase(12000),'evening');assert.equal(dayPhase(18000),'night');assert.equal(dayPhase(23500),'dawn');
  const town={homes:5,stock:{BREAD:70,IRON_INGOT:3},kills:2,ledger:10};
  assert.deepEqual(newlyUnlocked(town,['well']).map(m=>m.id),['town_hall','market_hall']);
});
test('production picks the first short item it has inputs for, capped by inputs and fuel',()=>{
  assert.deepEqual((({item,times})=>({item,times}))(chooseProduction({BREAD:10,WHEAT:9})),{item:'BREAD',times:3});
  assert.equal(chooseProduction({BREAD:100,OAK_PLANKS:500,SPRUCE_PLANKS:500,STICK:50,TORCH:99,STONE:0,COBBLESTONE:40,COAL:0,STONE_BRICKS:500,IRON_INGOT:40,GLASS:40,GLASS_PANE:99,IRON_NUGGET:40,LANTERN:40}),null,'no fuel to smelt');
  assert.equal(chooseProduction({BREAD:100,OAK_PLANKS:500,SPRUCE_PLANKS:500,STICK:50,TORCH:99,STONE:0,COBBLESTONE:40,COAL:2}).times,16);
});
test('roads run L-shaped at the requested width with lanterns every 8 blocks',()=>{
  const cols=roadColumns({x:0,z:0},{x:10,z:6},2);
  assert.ok(cols.some(c=>c.x===10&&c.z===6)&&cols.some(c=>c.x===0&&c.z===1));
  assert.equal(new Set(cols.map(c=>`${c.x},${c.z}`)).size,cols.length);
  assert.equal(roadColumns({x:5,z:5},{x:5,z:5},1).length,1);
  const spots=lanternSpots({x:0,z:0},{x:16,z:0},2);
  assert.deepEqual(spots.map(p=>p.z),[-1,-1],'beside the road, not on it');
  assert.equal(spots[1].x-spots[0].x,8,'every 8 blocks');
  assert.equal(lanternSpots({x:0,z:0},{x:24,z:0},2).length,3,'24 blocks: lanterns at 7, 15 and 23');
});
test('quests, zones and friendships',()=>{
  assert.equal(questReward(40),5);assert.equal(questReward(1),1);
  const zones=[{kind:'houses',x1:0,z1:0,x2:20,z2:20,status:'adopted'},{kind:'public',x1:30,z1:0,x2:50,z2:20,status:'adopted'},{kind:'public',x1:60,z1:0,x2:70,z2:10,status:'proposed'}];
  assert.ok(zoneFor({x1:2,z1:2,x2:8,z2:8},'house',zones));
  assert.equal(zoneFor({x1:2,z1:2,x2:8,z2:8},'forge',zones),undefined,'forges are not allowed among houses');
  assert.ok(zoneFor({x1:31,z1:1,x2:40,z2:10},'hall',zones));
  assert.equal(zoneFor({x1:61,z1:1,x2:65,z2:5},'hall',zones),undefined,'only adopted zones count');
  const aff={};adjustAffinity(aff,'a','b',4);adjustAffinity(aff,'c','a',-5);adjustAffinity(aff,'a','a',9);
  assert.deepEqual(relationsOf(aff,'a'),{friends:[{id:'b',score:4}],rivals:[{id:'c',score:-5}]});
});
import {seasonOf,moodCategory,EMOTES,reputationTitle,roadGraph,roadRoute} from '../agent-core/town.mjs';
test('seasons, moods and reputation titles',()=>{
  assert.equal(seasonOf(1),'spring');assert.equal(seasonOf(8),'summer');assert.equal(seasonOf(22),'winter');assert.equal(seasonOf(29),'spring');
  assert.equal(moodCategory('proud and hopeful'),'happy');assert.equal(moodCategory('a bit annoyed'),'grumpy');
  assert.equal(moodCategory('calm',{raid:true}),'scared');assert.equal(moodCategory('happy',{resting:true}),'sleepy');
  assert.equal(moodCategory('fine',{needs:{hunger:3,energy:90}}),'hungry');assert.equal(EMOTES.happy,'§d❤');
  assert.equal(reputationTitle(50),'Hero of the town');assert.equal(reputationTitle(0),'Neighbour');assert.equal(reputationTitle(-30),'Outcast');
});
test('road routing follows the network for long trips and walks straight for short ones',()=>{
  const roads=[{a:{x:0,z:0},b:{x:40,z:0},width:2},{a:{x:40,z:0},b:{x:40,z:40},width:2}];
  const g=roadGraph(roads);
  const route=roadRoute(g,{x:2,z:4},{x:44,z:38});
  assert.ok(route&&route.length>=3,'uses the roads');
  assert.ok(route.some(p=>p.x>=35&&p.z<5)&&route.some(p=>p.x>40&&p.z>20),'runs east along the first road, then south along the second');
  assert.equal(roadRoute(g,{x:2,z:4},{x:10,z:4}),null,'short trips walk straight');
  assert.equal(roadRoute(g,{x:2,z:30},{x:30,z:30}),null,'no detour when the road is far away');
});
import {dropOffItems,chooseChest,courierErrand,edibleIn} from '../agent-core/town.mjs';
test('drop-off limits keep a little and move the rest; tools and small amounts stay',()=>{
  const hazel=Object.fromEntries(dropOffItems({WHEAT:285,WHEAT_SEEDS:989,IRON_HOE:1,BREAD:4},'farmer'));
  assert.equal(hazel.WHEAT,277);assert.equal(hazel.WHEAT_SEEDS,957);assert.equal(hazel.IRON_HOE,undefined);assert.equal(hazel.BREAD,undefined);
  assert.deepEqual(dropOffItems({RAW_IRON:20,COBBLESTONE:30},'miner'),[['RAW_IRON',20]]);
  assert.deepEqual(dropOffItems({EMERALD:50},'merchant'),[]);
});
test('deposits go to the labelled chest; withdrawals come from the fullest',()=>{
  const chests=[{x:1,name:'Food Storage',free:20,items:{BREAD:10}},{x:2,name:'Supplies & Tools',free:20,items:{STICK:5}},{x:3,name:'',free:0,items:{BREAD:40}}];
  assert.equal(chooseChest(chests,'COOKED_COD','deposit').x,1);
  assert.equal(chooseChest(chests,'RAW_IRON','deposit').x,2);
  assert.equal(chooseChest(chests,'BREAD','withdraw').x,3);
  assert.equal(chooseChest(chests,'DIAMOND','withdraw'),null);
});
test('the courier feeds the starving first, then collects surplus from producers',()=>{
  const marlo={id:'merchant',inventory:{EMERALD:10}};
  const agents=[marlo,{id:'builder',hunger:0,inventory:{}},{id:'farmer',role:'farmer',hunger:4,inventory:{WHEAT:285}},{id:'fisher',hunger:18,inventory:{COOKED_COD:20}}];
  assert.deepEqual(courierErrand(marlo,agents,{BREAD:64}),{kind:'fetch-food',item:'BREAD',for:'builder'});
  assert.deepEqual(courierErrand({...marlo,inventory:{BREAD:8}},agents,{}),{kind:'feed',to:'builder',item:'BREAD'});
  const fed=agents.map(a=>({...a,hunger:18}));
  const e=courierErrand(marlo,fed,{});assert.equal(e.kind,'collect');assert.equal(e.from,'farmer','the biggest surplus first');
  assert.equal(edibleIn({WHEAT:5}),null,'raw wheat is not a meal');
});
