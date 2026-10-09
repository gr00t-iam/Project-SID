// The warehouse clerk end to end, with chests that behave like the plugin's (slots, stacks of 64, 256 per withdrawal):
//   1. INDEX       seven chests get categories (the smallest becomes the input drop box); the food chest by its name
//   2. DROP BOX    the courier dumps 5 mismatched kinds into the drop box; Finneas files each to its category chest
//   3. MISFILED    raw beef found in the building chest goes to the food chest (with a word about it)
//   4. MERGE       stone split over two chests is gathered into one; the totals stay right throughout
//   5. QUERY       a builder asks where the stone is: the exact chest coordinates come back
//   6. OVERFLOW    a full category chest overflows into a spare chest, which the index remembers; locks keep two
//                  citizens off the same chest; tools are never merged
//   node agent-core/test-warehouse.mjs        (exits 1 on any failure; also run by npm test)
import {pathToFileURL} from 'node:url';
import {WarehouseMap,categoryOf,chestKey,DROP_BOX} from './skills/warehouse.mjs';
import {createClerk} from './roles/clerk.mjs';

const slots=items=>Object.values(items).reduce((a,n)=>a+Math.ceil(n/64),0);
export async function simulate(){
  const failures=[],check=(ok,msg)=>{if(!ok)failures.push(msg);};
  let t=1e9;const now=()=>t;
  const chest=(x,z,size,name,items={})=>({x,y:70,z,size,name,items,free:size-slots(items)});
  const chests=[chest(285,108,54,'Food Storage',{BREAD:40,CARROT:100}),chest(289,106,54,'',{COBBLESTONE:200,STONE:14,BEEF:6}),
    chest(289,109,54,'',{RAW_IRON:20,COAL:30}),chest(289,107,27,'',{}),chest(287,105,54,'Supplies & Tools',{IRON_PICKAXE:1,STONE:32}),
    chest(286,106,54,'',{REDSTONE:12}),chest(286,109,54,'',{EMERALD:5,BOOK:3})];
  const town={day:320,built:{warehouse:true},stock:{chests,items:{}}};
  const total=()=>{const s={};for(const c of chests)for(const [k,v] of Object.entries(c.items))s[k]=(s[k]??0)+v;return s;};
  town.stock.items=total();
  const memory={data:{town}};const map=new WarehouseMap(town.warehouseMap={});
  const find=at=>chests.find(c=>chestKey(c)===chestKey(at));
  const said=[],logs=[],ledger=[];
  // The plugin's chests: deposits fill partial stacks then free slots; withdrawals at most 256.
  const act=async(id,a)=>{
    const c=find(a);
    if(a.type==='withdraw'){const n=Math.min(256,a.count,c.items[a.target]??0);c.items[a.target]-=n;if(!c.items[a.target])delete c.items[a.target];c.free=c.size-slots(c.items);return {withdrew:n};}
    if(a.type==='deposit'){let n=0;while(n<a.count){const test={...c.items,[a.target]:(c.items[a.target]??0)+1};if(slots(test)>c.size)break;c.items=test;n++;}c.free=c.size-slots(c.items);
      if(!n)throw Error('That chest is full');return {deposited:n};}
    return {};
  };
  const civic={goToWarehouse:async()=>true,refreshStock:async()=>{town.stock.items=total();},warehouseMap:()=>map,standing:()=>[],
    noteChest:(at,item,delta)=>{town.stock.items[item]=Math.max(0,(town.stock.items[item]??0)+delta);}};
  const clerk=createClerk({memory,act,say:async(id,x)=>said.push(x),log:(type,d)=>logs.push({type,...d}),ledger:(id,x)=>ledger.push(x),civic:()=>civic,now,random:()=>0.2});
  const finneas={id:'clerk',role:'clerk'},self={x:286.5,y:70,z:107.5};   // Jasper, the warehouse clerk
  const work=async()=>{const j=clerk.job(finneas,{},self,false);if(j){await j();return true;}return false;};

  // ---------- 1. INDEX ----------
  await work();
  const cat=c=>map.categoryOfChest(find(c));
  check(cat({x:289,y:70,z:107})===DROP_BOX,'the smallest chest is the input drop box');
  check(cat({x:285,y:70,z:108})==='FOOD_AND_AGRICULTURE'&&cat({x:289,y:70,z:106})==='BUILDING_BLOCKS'&&cat({x:289,y:70,z:109})==='ORES_AND_METALS','categories follow what each chest already holds');
  check(cat({x:287,y:70,z:105})==='TOOLS_AND_EQUIPMENT','the tools chest by its name');
  check(ledger.some(x=>/took stock of the warehouse/.test(x)),'the inventory summary goes to the ledger');

  // ---------- 2. DROP BOX ----------
  const box=find({x:289,y:70,z:107});
  Object.assign(box.items,{GRAVEL:20,COAL:9,WHEAT_SEEDS:30,TORCH:16,IRON_AXE:1});box.free=box.size-slots(box.items);
  town.stock.items=total();const sorted=o=>JSON.stringify(Object.keys(o).sort().map(k=>[k,o[k]]));const before=sorted(total());
  for(let i=0;i<12&&Object.keys(box.items).length;i++)await work();
  check(!Object.keys(box.items).length,'the drop box is emptied');
  const where=item=>map.categoryOfChest(chests.find(c=>(c.items[item]??0)>0));
  check(where('GRAVEL')==='BUILDING_BLOCKS'&&where('WHEAT_SEEDS')==='FOOD_AND_AGRICULTURE'&&where('TORCH')==='REDSTONE_AND_COMPONENTS'&&where('IRON_AXE')==='TOOLS_AND_EQUIPMENT','each kind filed in its category chest');
  check(find({x:289,y:70,z:109}).items.COAL===39,'coal merged into the existing coal stack (30 + 9)');
  check(sorted(total())===before,'nothing lost or created while filing');

  // ---------- 3. + 4. MISFILED and MERGE ----------
  for(let i=0;i<12;i++)if(!await work())break;
  check(where('BEEF')==='FOOD_AND_AGRICULTURE'&&said.some(x=>/beef/.test(x)),'raw beef out of the building chest, with a word about it');
  check(chests.filter(c=>c.items.STONE).length===1&&total().STONE===46,'stone gathered into one chest (14 + 32)');
  // The 32 stone sat in the tools chest: it was misfiled, so it counts as filed (not merged).
  check(clerk.view().filed>=6+32&&clerk.view().moves>=7,'the clerk\'s ledger counts what he filed and moved');
  check(town.stock.items.STONE===46&&town.stock.items.GRAVEL===20,'the global stock counter is right');

  // ---------- 5. QUERY ----------
  const stone=map.locationOf('STONE',chests);
  check(stone.length===1&&stone[0].x===289&&stone[0].z===106&&stone[0].count===46&&stone[0].category==='BUILDING_BLOCKS',`the builder gets the exact chest for stone (${JSON.stringify(stone)})`);

  // ---------- 6. OVERFLOW, LOCKS, TOOLS ----------
  const food=find({x:285,y:70,z:108});food.items={...food.items,POTATO:64*50};food.free=food.size-slots(food.items);
  const to=map.targetFor('BEETROOT',chests);
  check(!to,'a full food category takes nothing more - never another category\'s chest (the rest goes to the market)');
  {const box2=find({x:289,y:70,z:107});box2.items.BEETROOT=10;box2.free=box2.size-slots(box2.items);const m=map.nextMove(chests);check(m?.kind==='to_market'&&m.item==='BEETROOT','food with no room left in the food chests is sent to the market');delete box2.items.BEETROOT;box2.free=box2.size-slots(box2.items);}
  check(categoryOf('IRON_SWORD')==='WEAPONS'&&categoryOf('BOW')==='WEAPONS'&&categoryOf('ARROW')==='WEAPONS'&&categoryOf('IRON_AXE')==='TOOLS_AND_EQUIPMENT'&&categoryOf('WOODEN_PICKAXE')==='TOOLS_AND_EQUIPMENT','swords, bows and arrows are weapons; axes and pickaxes are tools');
  check(map.lock(food,'courier')&&!map.lock(food,'banker')&&map.locked(food,'banker'),'a chest worked by one citizen is locked to another');
  map.unlock(food,'courier');
  check(categoryOf('IRON_PICKAXE')==='TOOLS_AND_EQUIPMENT'&&!['IRON_PICKAXE','IRON_SWORD'].some(i=>logs.some(l=>l.kind==='consolidate'&&l.item===i)),'tools are kept by kind, never merged');
  return {failures,said,logs};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=await simulate();for(const l of r.said)console.log('  '+l);
  for(const l of r.logs.filter(l=>l.type==='warehouse_move'))console.log(`  ${l.kind}: ${l.count} ${l.item} ${l.from.category} -> ${l.to.category}`);
  if(r.failures.length){console.log(`\n${r.failures.length} failure(s):`);for(const f of r.failures)console.log('  FAIL '+f);process.exit(1);}
  console.log('\nall warehouse checks passed');
}
