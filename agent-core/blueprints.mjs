// Turns a small shape description into an ordered block list (bottom layer first) so models can
// ask for "a 9x9 stone brick house" instead of guessing hundreds of coordinates.
export const SHAPES=['floor','walls','box','house','roof','path','pillar','well','tower','pavilion','hall','warehouse','library','forge','windmill','jail','bank','tavern','courthouse','infirmary','bakery','cancel'];
// Larger designs unlock as the builder gains experience (level from town.mjs).
export const SHAPE_LEVEL={tower:2,well:2,pavilion:3,windmill:3,hall:4};
export const MAX_BLOCKS=600;
const SIDES=['north','south','east','west'];
const clampInt=(v,min,max,fallback)=>{const n=Math.round(Number(v));return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;};
const mat=(v,fallback)=>typeof v==='string'&&/^[A-Za-z_]{2,64}$/.test(v)?v.toUpperCase():fallback;

function rect(out,x,y,z,w,d,block,hollow=false){
  for(let i=0;i<w;i++)for(let k=0;k<d;k++)
    if(!hollow||i===0||k===0||i===w-1||k===d-1)out.push({x:x+i,y,z:z+k,block});
}
// Position along the perimeter used for door/window placement.
function side(i,k,w,d){
  if(k===0)return 'north';if(k===d-1)return 'south';if(i===w-1)return 'east';if(i===0)return 'west';return null;
}
function walls(out,x,y,z,w,d,h,{block,trim,door,windows}){
  const mid={north:[Math.floor((w-1)/2),0],south:[Math.floor((w-1)/2),d-1],east:[w-1,Math.floor((d-1)/2)],west:[0,Math.floor((d-1)/2)]};
  const [dx,dz]=door?mid[door]:[-1,-1];
  for(let level=0;level<h;level++)for(let i=0;i<w;i++)for(let k=0;k<d;k++){
    if(!(i===0||k===0||i===w-1||k===d-1))continue;
    const corner=(i===0||i===w-1)&&(k===0||k===d-1);
    if(door&&i===dx&&k===dz&&level<2)continue; // 1x2 doorway
    const nearDoor=door&&Math.abs(i-dx)+Math.abs(k-dz)<=1;
    const isWindow=windows&&!corner&&!nearDoor&&level===1&&h>=3&&((side(i,k,w,d)==='north'||side(i,k,w,d)==='south')?i%2===0:k%2===0);
    out.push({x:x+i,y:y+level,z:z+k,block:isWindow?'GLASS_PANE':corner&&trim?trim:block});
  }
}
function roof(out,x,y,z,w,d,block,overhang=1){
  let x0=x-overhang,z0=z-overhang,rw=w+2*overhang,rd=d+2*overhang;
  for(let level=0;rw>0&&rd>0;level++){
    rect(out,x0,y+level,z0,rw,rd,block,rw>2&&rd>2);
    x0++;z0++;rw-=2;rd-=2;
  }
}
function path(out,x,y,z,x2,z2,width,block){
  const steps=Math.max(Math.abs(x2-x),Math.abs(z2-z));const seen=new Set();
  for(let s=0;s<=steps;s++){
    const px=Math.round(x+(x2-x)*(steps?s/steps:0)),pz=Math.round(z+(z2-z)*(steps?s/steps:0));
    for(let a=0;a<width;a++)for(let b=0;b<width;b++){
      const key=`${px+a},${pz+b}`;if(seen.has(key))continue;seen.add(key);
      out.push({x:px+a,y,z:pz+b,block});
    }
  }
}

/** spec: {shape,width,depth,height,material,trim,roof,floor,door,windows,x2,z2}; x,y,z is the minimum corner of the first layer. */
export function blueprint(spec,x,y,z){
  const shape=String(spec?.shape??'').toLowerCase();
  if(!SHAPES.includes(shape)||shape==='cancel')throw Error(`Unknown shape; use one of ${SHAPES.filter(s=>s!=='cancel').join(', ')}`);
  [x,y,z]=[x,y,z].map(v=>Math.floor(Number(v)));
  if(![x,y,z].every(Number.isFinite))throw Error('Blueprint needs a numeric x,y,z corner');
  const w=clampInt(spec.width,1,15,{hall:11,pavilion:9,warehouse:9,library:9,forge:7,well:3,tower:5,windmill:5,jail:9,bank:9,tavern:9}[shape]??5),d=clampInt(spec.depth,1,15,{hall:9,pavilion:9,warehouse:7,library:7,forge:7,well:3,tower:5,windmill:5,jail:7,bank:7,tavern:9}[shape]??w),h=clampInt(spec.height,1,10,{house:4,hall:5,tower:8,windmill:7,warehouse:4,library:4,forge:4,jail:4,bank:4,tavern:4}[shape]??3);
  const block=mat(spec.material,'OAK_PLANKS'),trim=mat(spec.trim,null);
  const door=SIDES.includes(String(spec.door).toLowerCase())?String(spec.door).toLowerCase():(spec.door===true||shape==='house'?'south':null);
  const windows=spec.windows!==false&&(spec.windows===true||shape==='house');
  const out=[];
  switch(shape){
    case 'floor':rect(out,x,y,z,w,d,block);break;
    case 'walls':walls(out,x,y,z,w,d,h,{block,trim,door,windows});break;
    case 'box':rect(out,x,y,z,w,d,mat(spec.floor,block));walls(out,x,y+1,z,w,d,h,{block,trim,door,windows});rect(out,x,y+h+1,z,w,d,mat(spec.roof,block));break;
    case 'house':
      if(w<5||d<5)throw Error('A house needs width and depth of at least 5');
      rect(out,x,y,z,w,d,mat(spec.floor,block));
      walls(out,x,y+1,z,w,d,h,{block,trim:trim??'OAK_LOG',door,windows});
      roof(out,x,y+h+1,z,w,d,mat(spec.roof,'SPRUCE_PLANKS'));
      out.push({x:x+Math.floor(w/2),y:y+1,z:z+Math.floor(d/2),block:'LANTERN'});
      if(spec.bed){
        // Bed against the wall opposite the door, foot then head, so the doorway stays clear.
        const bx=door==='east'?x+1:door==='west'?x+w-2:x+1;
        const bz=door==='north'?z+d-3:z+1;
        out.push({x:bx,y:y+1,z:bz,block:mat(spec.bed===true?'RED_BED':spec.bed,'RED_BED'),facing:'SOUTH'});
        // The owner's private chest at the foot of the bed (skills/property.mjs dwellingOf).
        if(spec.chest)out.push({x:bx,y:y+1,z:door==='north'?bz-1:bz+2,block:'CHEST'});
      }
      break;
    case 'roof':roof(out,x,y,z,w,d,block,clampInt(spec.overhang,0,2,1));break;
    case 'path':path(out,x,y,z,clampInt(spec.x2,-30000000,30000000,x),clampInt(spec.z2,-30000000,30000000,z),clampInt(spec.width,1,3,2),mat(spec.material,'GRAVEL'));break;
    case 'pillar':for(let level=0;level<h;level++)out.push({x,y:y+level,z,block});break;
    case 'well':{
      // Stone ring, fence posts at the corners, slab roof and a cauldron in the middle.
      rect(out,x,y,z,3,3,mat(spec.material,'COBBLESTONE'),true);
      for(const [i,k] of [[0,0],[2,0],[0,2],[2,2]])for(let level=1;level<=2;level++)out.push({x:x+i,y:y+level,z:z+k,block:'OAK_FENCE'});
      rect(out,x,y+3,z,3,3,mat(spec.roof,'SPRUCE_SLAB'));
      out.push({x:x+1,y,z:z+1,block:'CAULDRON'});
      break;
    }
    case 'tower':case 'windmill':{
      // Hollow tower with a doorway, arrow-slit windows and crenellations; the windmill adds sails.
      rect(out,x,y,z,w,d,mat(spec.floor,block));
      walls(out,x,y+1,z,w,d,h,{block:mat(spec.material,shape==='windmill'?'OAK_PLANKS':'STONE_BRICKS'),trim:trim??(shape==='windmill'?'SPRUCE_LOG':'MOSSY_STONE_BRICKS'),door:door??'south',windows:false});
      if(shape==='tower'){
        rect(out,x,y+h+1,z,w,d,mat(spec.material,'STONE_BRICKS'));
        for(let i=0;i<w;i++)for(let k=0;k<d;k++)if((i===0||k===0||i===w-1||k===d-1)&&(i+k)%2===0)out.push({x:x+i,y:y+h+2,z:z+k,block:'STONE_BRICK_WALL'});
        out.push({x:x+Math.floor(w/2),y:y+h+2,z:z+Math.floor(d/2),block:'LANTERN'});
      }else{
        roof(out,x,y+h+1,z,w,d,mat(spec.roof,'SPRUCE_PLANKS'));
        // Four sails of wool on the north face, crossing at the hub.
        const hx=x+Math.floor(w/2),hy=y+h-1,hz=z-1;
        out.push({x:hx,y:hy,z:hz,block:'SPRUCE_LOG'});
        for(let r=1;r<=3;r++)for(const [dx,dy] of [[r,0],[-r,0],[0,r],[0,-r]])out.push({x:hx+dx,y:hy+dy,z:hz-1,block:'WHITE_WOOL'});
        out.push({x:hx,y:hy,z:hz-1,block:'SPRUCE_LOG'});
      }
      break;
    }
    case 'tavern':{
      // The tavern, where the town gathers in the evening (DUSK_SOCIAL): a fixed 9 x 9 timber hall, door on the south,
      // a bar of barrels along the north wall, four tables with stools, a hearth (campfire) and lanterns.
      const W=9,D=9,H=4,wall=mat(spec.material,'SPRUCE_PLANKS'),trimBlock=trim??'SPRUCE_LOG';
      rect(out,x,y,z,W,D,mat(spec.floor,'OAK_PLANKS'));
      walls(out,x,y+1,z,W,D,H,{block:wall,trim:trimBlock,door:'south',windows:true});
      for(let i=1;i<W-1;i++)if(i!==4)out.push({x:x+i,y:y+1,z:z+2,block:'BARREL'});
      for(const [i,k] of [[2,4],[6,4],[2,6],[6,6]]){out.push({x:x+i,y:y+1,z:z+k,block:'OAK_FENCE'},{x:x+i,y:y+2,z:z+k,block:'OAK_PRESSURE_PLATE'});
        out.push({x:x+i-1,y:y+1,z:z+k,block:'SPRUCE_STAIRS',facing:'EAST'},{x:x+i+1,y:y+1,z:z+k,block:'SPRUCE_STAIRS',facing:'WEST'});}
      out.push({x:x+4,y:y+1,z:z+1,block:'CAMPFIRE'});
      roof(out,x,y+H+1,z,W,D,mat(spec.roof,'SPRUCE_PLANKS'));
      for(const [i,k] of [[2,2],[6,2],[4,5],[2,7],[6,7]])out.push({x:x+i,y:y+H,z:z+k,block:'LANTERN'});
      break;
    }
    case 'bank':{
      // The bank: a fixed 9 x 7 stone hall, door on the south. The vault room along the north wall holds four chests
      // behind cobblestone-wall grates (the vault box for the plugin: x+1..x+7, y+1, z+1..z+2); a counter of barrels
      // with a gap for the Banker in the middle of the hall. See skills/banking.mjs.
      const W=9,D=7,H=4,wall=mat(spec.material,'COBBLESTONE'),trimBlock=trim??'STONE_BRICKS';
      rect(out,x,y,z,W,D,mat(spec.floor,'SMOOTH_STONE'));
      walls(out,x,y+1,z,W,D,H,{block:wall,trim:trimBlock,door:'south',windows:true});
      for(let i=1;i<W-1;i++){out.push({x:x+i,y:y+1,z:z+3,block:'COBBLESTONE_WALL'},{x:x+i,y:y+2,z:z+3,block:'COBBLESTONE_WALL'});for(let level=3;level<=H;level++)out.push({x:x+i,y:y+level,z:z+3,block:wall});}
      for(const i of [1,3,5,7])out.push({x:x+i,y:y+1,z:z+1,block:'CHEST'});
      for(const i of [2,3,5,6])out.push({x:x+i,y:y+1,z:z+4,block:'BARREL'});
      rect(out,x,y+H+1,z,W,D,mat(spec.roof,'COBBLESTONE_SLAB'));
      out.push({x:x+4,y:y+H,z:z+5,block:'LANTERN'},{x:x+4,y:y+H,z:z+1,block:'LANTERN'});
      break;
    }
    case 'jail':{
      if(spec.layoutVersion===2){
        const W=13,D=7,H=4,wall=mat(spec.material,'COBBLESTONE');
        rect(out,x,y,z,W,D,mat(spec.floor,'COBBLESTONE'));
        walls(out,x,y+1,z,W,D,H,{block:wall,trim:trim??'STONE_BRICKS',windows:false});
        // Four identical 2 x 2 cells with a two-row sheriff corridor.
        for(const i of [3,6,9])for(let level=1;level<=H;level++)for(let k=1;k<=3;k++)out.push({x:x+i,y:y+level,z:z+k,block:wall});
        for(const i of [1,4,7,10]){
          out.push({x:x+i,y:y+1,z:z+3,block:'IRON_DOOR',facing:'SOUTH'},
            {x:x+i,y:y+1,z:z+4,block:'LEVER',facing:'SOUTH'},
            {x:x+i,y:y+H,z:z+2,block:'LANTERN'});
          for(let lv=1;lv<=2;lv++)out.push({x:x+i+1,y:y+lv,z:z+3,block:'IRON_BARS'});
          for(let lv=3;lv<=H;lv++)for(let j=i;j<=i+1;j++)out.push({x:x+j,y:y+lv,z:z+3,block:wall});
        }
        // West entrance at corridor level, facing the open lane rather than the fields.
        for(let n=out.length-1;n>=0;n--)if(out[n].x===x&&out[n].z===z+4&&[y+1,y+2].includes(out[n].y))out.splice(n,1);
        out.push({x,y:y+1,z:z+4,block:'SPRUCE_DOOR',facing:'WEST'});
        out.push({x:x+6,y:y+1,z:z+5,block:'CRAFTING_TABLE'},{x:x+10,y:y+1,z:z+5,block:'CHEST'});
        rect(out,x,y+H+1,z,W,D,mat(spec.roof,'SPRUCE_SLAB'));
        break;
      }
      // The town jail: a fixed 9 x 7 stone house, door on the south. Three cells along the north wall (2, 2 and 1 blocks
      // wide, 2 deep) behind iron bars; the sheriff's room in front. Cell stand points: skills/justice.mjs jailCells().
      const W=9,D=7,H=4,wall=mat(spec.material,'COBBLESTONE'),trimBlock=trim??'STONE_BRICKS';
      rect(out,x,y,z,W,D,mat(spec.floor,'COBBLESTONE'));
      walls(out,x,y+1,z,W,D,H,{block:wall,trim:trimBlock,door:'south',windows:false});
      for(const i of [3,6])for(let level=1;level<=H;level++)for(const k of [1,2])out.push({x:x+i,y:y+level,z:z+k,block:wall});
      for(let i=1;i<W-1;i++){if(i===3||i===6){for(let level=1;level<=H;level++)out.push({x:x+i,y:y+level,z:z+3,block:wall});continue;}
        out.push({x:x+i,y:y+1,z:z+3,block:'IRON_BARS'},{x:x+i,y:y+2,z:z+3,block:'IRON_BARS'});for(let level=3;level<=H;level++)out.push({x:x+i,y:y+level,z:z+3,block:wall});}
      rect(out,x,y+H+1,z,W,D,mat(spec.roof,'COBBLESTONE_SLAB'));
      out.push({x:x+2,y:y+1,z:z+5,block:'CRAFTING_TABLE'},{x:x+6,y:y+1,z:z+5,block:'CHEST'},{x:x+4,y:y+H,z:z+5,block:'LANTERN'});
      for(const i of [1,4,7])out.push({x:x+i,y:y+H,z:z+1,block:'LANTERN'});
      break;
    }
    case 'courthouse':{
      // The courthouse: a fixed 13 x 9 stone hall, door in the north wall. Inside, from the door southward: the gallery
      // (stair benches facing the bench; the front row is the jury box), the plaintiff's and the defendant's stands, the witness stand, and the
      // judicial bench - a raised platform along the south wall behind a desk with the gavel block. Along the east
      // wall, two holding cells behind iron bars, each with an iron door worked by a lever on the courtroom floor.
      // Every point the court uses is in courthouseLayout() below (skills/justice.mjs, roles/judge.mjs).
      // Local materials only: stone from the mine, spruce from the lumberjack, iron from the miner's ore.
      const W=13,D=9,H=5,wall=mat(spec.material,'STONE_BRICKS'),trimBlock=trim??'SPRUCE_LOG',wood=mat(spec.wood,'SPRUCE_PLANKS');
      // Floor, with the stands inlaid in stone bricks (plaintiff west, defendant east, witness box by the bench).
      const inlay=new Set(['2,4','7,4','1,6','8,6']);
      for(let i=0;i<W;i++)for(let k=0;k<D;k++)out.push({x:x+i,y,z:z+k,block:inlay.has(`${i},${k}`)?'STONE_BRICKS':mat(spec.floor,'SMOOTH_STONE')});
      walls(out,x,y+1,z,W,D,H,{block:wall,trim:trimBlock,door:'north',windows:true});
      // The cells: x+10..x+11, z+1..z+3 and z+5..z+7, split by a wall at z+4; their front (x+9) is bars, a door each.
      for(let level=1;level<=H;level++)for(const i of [10,11])out.push({x:x+i,y:y+level,z:z+4,block:wall});
      for(let k=1;k<=7;k++)for(let level=1;level<=H;level++){
        if(level>=3||k===4){out.push({x:x+9,y:y+level,z:z+k,block:wall});continue;}
        if(k===2||k===6){if(level===1)out.push({x:x+9,y:y+1,z:z+k,block:'IRON_DOOR',facing:'WEST'});continue;}   // two blocks tall
        out.push({x:x+9,y:y+level,z:z+k,block:'IRON_BARS'});
      }
      for(const k of [2,6])out.push({x:x+8,y:y+1,z:z+k,block:'LEVER',facing:'WEST'});   // right in front of each door, on the floor: it powers the door
      // The bench: platform x+3..x+6 along the south wall, desk in front with the gavel block in the middle.
      for(let i=3;i<=6;i++){out.push({x:x+i,y:y+1,z:z+7,block:'STONE_BRICKS'},{x:x+i,y:y+1,z:z+6,block:wood},{x:x+i,y:y+2,z:z+6,block:'SPRUCE_SLAB'});}
      out.push({x:x+2,y:y+1,z:z+7,block:'STONE_BRICK_STAIRS',facing:'WEST'});   // step up onto the bench
      // The witness box: a rail in front of the witness stand.
      out.push({x:x+1,y:y+1,z:z+5,block:'OAK_FENCE'});
      // The gallery: two rows of benches either side of the aisle (x+5..x+6 leads from the door).
      // The jury box: the front row of five spruce benches (z+3); behind it the public gallery in oak (z+2). x+8 stays clear: the cell levers.
      for(const i of [1,2,3,4,7])out.push({x:x+i,y:y+1,z:z+3,block:'SPRUCE_STAIRS',facing:'NORTH'},{x:x+i,y:y+1,z:z+2,block:'OAK_STAIRS',facing:'NORTH'});
      roof(out,x,y+H+1,z,W,D,mat(spec.roof,'SPRUCE_PLANKS'));
      out.push({x:x+5,y:y+H,z:z+4,block:'LANTERN'},{x:x+4,y:y+H,z:z+7,block:'LANTERN'},{x:x+10,y:y+H,z:z+2,block:'LANTERN'},{x:x+10,y:y+H,z:z+6,block:'LANTERN'});
      break;
    }
    case 'infirmary':{
      // The infirmary: a 9 x 7 timber clinic, door on the south. Four beds along the north wall (heads to the wall),
      // the medicine corner (barrel, chest, cauldron) and the medic's place in the middle. infirmaryLayout() below.
      const W=9,D=7,H=4,wall=mat(spec.material,'SPRUCE_PLANKS'),trimBlock=trim??'SPRUCE_LOG';
      rect(out,x,y,z,W,D,mat(spec.floor,'SMOOTH_STONE'));
      walls(out,x,y+1,z,W,D,H,{block:wall,trim:trimBlock,door:'south',windows:true});
      for(const i of [1,3,5,7])out.push({x:x+i,y:y+1,z:z+2,block:'WHITE_BED',facing:'NORTH'});   // the head goes to z+1
      out.push({x:x+1,y:y+1,z:z+4,block:'BARREL'},{x:x+1,y:y+1,z:z+5,block:'CHEST'},{x:x+7,y:y+1,z:z+4,block:'CAULDRON'});
      roof(out,x,y+H+1,z,W,D,mat(spec.roof,'SPRUCE_PLANKS'));
      out.push({x:x+2,y:y+H,z:z+2,block:'LANTERN'},{x:x+6,y:y+H,z:z+2,block:'LANTERN'},{x:x+4,y:y+H,z:z+4,block:'LANTERN'});
      break;
    }
    case 'bakery':{
      // Chef Antoine's bakery: a 7 x 7 cobblestone kitchen with spruce trim, door on the east. Two furnaces and the
      // crafting table along the north wall, the pantry (two barrels and a chest) on the west wall. bakeryLayout() below.
      const W=7,D=7,H=4;
      rect(out,x,y,z,W,D,mat(spec.floor,'SPRUCE_PLANKS'));
      walls(out,x,y+1,z,W,D,H,{block:mat(spec.material,'COBBLESTONE'),trim:trim??'SPRUCE_LOG',door:door??'east',windows:true});
      out.push({x:x+2,y:y+1,z:z+1,block:'FURNACE',facing:'SOUTH'},{x:x+3,y:y+1,z:z+1,block:'FURNACE',facing:'SOUTH'},{x:x+4,y:y+1,z:z+1,block:'CRAFTING_TABLE'},
        {x:x+1,y:y+1,z:z+3,block:'BARREL'},{x:x+1,y:y+1,z:z+4,block:'BARREL'},{x:x+1,y:y+1,z:z+5,block:'CHEST'});
      roof(out,x,y+H+1,z,W,D,mat(spec.roof,'SPRUCE_PLANKS'));
      out.push({x:x+3,y:y+H,z:z+3,block:'LANTERN'});
      break;
    }
    case 'pavilion':{
      // Open market hall: floor, corner and mid pillars, slab roof, stalls of barrels and crafting tables.
      rect(out,x,y,z,w,d,mat(spec.floor,'SMOOTH_STONE'));
      for(let i=0;i<w;i+=4)for(const k of [0,d-1])for(let level=1;level<=3;level++)out.push({x:x+Math.min(i,w-1),y:y+level,z:z+k,block:mat(trim,'SPRUCE_LOG')});
      for(let k=4;k<d-1;k+=4)for(const i of [0,w-1])for(let level=1;level<=3;level++)out.push({x:x+i,y:y+level,z:z+k,block:mat(trim,'SPRUCE_LOG')});
      rect(out,x-1,y+4,z-1,w+2,d+2,mat(spec.roof,'SPRUCE_SLAB'));
      for(let i=2;i<w-2;i+=2)out.push({x:x+i,y:y+1,z:z+2,block:i%4===2?'BARREL':'CRAFTING_TABLE'},{x:x+i,y:y+1,z:z+d-3,block:i%4===2?'CRAFTING_TABLE':'BARREL'});
      out.push({x:x+Math.floor(w/2),y:y+3,z:z+Math.floor(d/2),block:'LANTERN'});
      break;
    }
    case 'hall':case 'warehouse':case 'library':case 'forge':{
      // Public buildings share the house frame and differ in size, materials and furnishings.
      const style={hall:['STONE_BRICKS','STRIPPED_OAK_LOG','BRICKS','SPRUCE_PLANKS'],warehouse:['SPRUCE_PLANKS','SPRUCE_LOG','SPRUCE_PLANKS','OAK_PLANKS'],
        library:['BIRCH_PLANKS','OAK_LOG','MOSSY_STONE_BRICKS','OAK_PLANKS'],forge:['COBBLESTONE','STONE_BRICKS','COBBLESTONE','SMOOTH_STONE']}[shape];
      const wallBlock=mat(spec.material,style[0]),trimBlock=trim??style[1],roofBlock=mat(spec.roof,style[2]),floorBlock=mat(spec.floor,style[3]);
      rect(out,x,y,z,w,d,floorBlock);
      walls(out,x,y+1,z,w,d,h,{block:wallBlock,trim:trimBlock,door:door??'south',windows:shape!=='warehouse'});
      roof(out,x,y+h+1,z,w,d,roofBlock);
      const inside=[];for(let i=1;i<w-1;i++)for(let k=1;k<d-1;k++)if(i===1||k===1||i===w-2||k===d-2)inside.push([i,k]);
      const doorCell={south:[Math.floor((w-1)/2),d-2],north:[Math.floor((w-1)/2),1],east:[w-2,Math.floor((d-1)/2)],west:[1,Math.floor((d-1)/2)]}[door??'south'];
      const free=inside.filter(([i,k])=>Math.abs(i-doorCell[0])+Math.abs(k-doorCell[1])>1);
      if(shape==='warehouse')free.filter((_,n)=>n%2===0).slice(0,8).forEach(([i,k])=>out.push({x:x+i,y:y+1,z:z+k,block:'CHEST'}));
      if(shape==='library')free.slice(0,20).forEach(([i,k])=>{out.push({x:x+i,y:y+1,z:z+k,block:'BOOKSHELF'});if(h>=4)out.push({x:x+i,y:y+2,z:z+k,block:'BOOKSHELF'});});
      if(shape==='forge')[['FURNACE',0],['FURNACE',1],['ANVIL',3],['CRAFTING_TABLE',5]].forEach(([b,n])=>free[n]&&out.push({x:x+free[n][0],y:y+1,z:z+free[n][1],block:b}));
      if(shape==='hall'){for(let i=2;i<w-2;i++)out.push({x:x+i,y:y+1,z:z+Math.floor(d/2),block:'RED_CARPET'});}
      out.push({x:x+Math.floor(w/2),y:y+h,z:z+Math.floor(d/2),block:'LANTERN'});
      break;
    }
  }
  if(out.length>MAX_BLOCKS)throw Error(`Blueprint too large (${out.length} blocks, max ${MAX_BLOCKS}); split it into parts`);
  // Stable bottom-up order: lower layers first so walls and roofs have something beneath them.
  return out.map((b,i)=>({...b,i})).sort((a,b)=>a.y-b.y||a.i-b.i).map(({i,...b})=>b);
}

// Mining plans for the miner. Each step lists the blocks to dig (top first) and where to stand
// afterwards; "stairs" descends one block per step, "tunnel" runs level and places a torch every 8.
/**
 * The courthouse's working points, from its floor corner {x,y,z} (y = floor block): where the judge stands, the gavel
 * block, the stands, the gallery seats, the cells (inside, the door, the lever) - see case 'courthouse' above.
 */
export function courthouseLayout({x,y,z}){
  const p=(i,k,dy=1)=>({x:x+i+0.5,y:y+dy,z:z+k+0.5});
  return {
    bench:p(4,7,2),gavel:{x:x+4,y:y+2,z:z+6},door:p(6,-1),entrance:p(6,1),
    stands:{plaintiff:p(2,4),defendant:p(7,4),witness:p(1,6),sheriff:p(8,6)},
    jury:[1,2,3,4,7].map(i=>p(i,3)),          // the jury box, seats 1-5 (skills/jury.mjs: 3 or 5 jurors)
    gallery:[1,2,3,4,7].map(i=>p(i,2)),
    cells:[{cell:1,...p(10.5,2),door:{x:x+9,y:y+1,z:z+2},lever:{x:x+8,y:y+1,z:z+2},outside:p(7,2)},
           {cell:2,...p(10.5,6),door:{x:x+9,y:y+1,z:z+6},lever:{x:x+8,y:y+1,z:z+6},outside:p(7,6)}],
  };
}
/** The infirmary's working points from its floor corner: a spot beside each bed, the medic's place, the medicine chest. */
export function infirmaryLayout({x,y,z}){
  const p=(i,k)=>({x:x+i+0.5,y:y+1,z:z+k+0.5});
  return {beds:[1,3,5,7].map((i,n)=>({bed:n+1,...p(i,3),head:{x:x+i,y:y+1,z:z+1}})),medic:p(4,4),chest:{x:x+1,y:y+1,z:z+5},door:p(4,7)};
}
/** The bakery's working points from its floor corner: the chef's place at the stove, the furnaces, the pantry chest. */
export function bakeryLayout({x,y,z}){
  const p=(i,k)=>({x:x+i+0.5,y:y+1,z:z+k+0.5});
  return {chef:p(3,2),furnaces:[{x:x+2,y:y+1,z:z+1},{x:x+3,y:y+1,z:z+1}],table:{x:x+4,y:y+1,z:z+1},chest:{x:x+1,y:y+1,z:z+5},door:p(7,3)};
}
export const DIG_SHAPES=['stairs','tunnel','cancel'];
const DIRECTIONS={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]};
export function digPlan(spec,x,y,z){
  const shape=String(spec?.shape??'').toLowerCase();
  if(!DIG_SHAPES.includes(shape)||shape==='cancel')throw Error('dig shape must be "stairs" or "tunnel"');
  const [dx,dz]=DIRECTIONS[String(spec.direction??'').toLowerCase()]??(()=>{throw Error('dig needs direction north, south, east or west');})();
  [x,y,z]=[x,y,z].map(v=>Math.floor(Number(v)));
  const length=clampInt(spec.length,1,shape==='stairs'?32:48,shape==='stairs'?16:24);
  const steps=[];
  for(let i=1;i<=length;i++){
    const cx=x+dx*i,cz=z+dz*i,feet=shape==='stairs'?y-i:y;
    const heights=shape==='stairs'?[feet+2,feet+1,feet]:[feet+1,feet];
    steps.push({dig:heights.map(h=>({x:cx,y:h,z:cz})),stand:{x:cx+0.5,y:feet,z:cz+0.5},torch:shape==='tunnel'&&i%8===0});
  }
  return steps;
}
