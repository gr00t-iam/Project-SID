// Real-calendar community projects. Progress is earned only by acknowledged world actions.
import {recipeFor} from './materials.mjs';
import {roomFor} from './skills/supply.mjs';
const ZONE='America/Chicago';
const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
export function communityDate(time){
  const parts=Object.fromEntries(calendar.formatToParts(time).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const nice=item=>item.toLowerCase().replace(/_/g,' ');
const flowers=['POPPY','DANDELION','CORNFLOWER','OXEYE_DAISY'];
const districts=[{id:'z2',name:'Town centre'},{id:'z4',name:'North district'},{id:'z5',name:'West quarter'}];
const outputs=['OAK_PLANKS','SPRUCE_PLANKS','OAK_STAIRS','SPRUCE_STAIRS','OAK_SLAB','SPRUCE_SLAB','OAK_FENCE','SPRUCE_FENCE','OAK_FENCE_GATE','SPRUCE_FENCE_GATE','OAK_DOOR','SPRUCE_DOOR','OAK_TRAPDOOR','SPRUCE_TRAPDOOR','LADDER','CHEST','CRAFTING_TABLE','FURNACE','STONE_BRICK_STAIRS','STONE_BRICK_SLAB','STONE_BRICK_WALL','COBBLESTONE_STAIRS','COBBLESTONE_SLAB','COBBLESTONE_WALL','GLASS_PANE','IRON_BARS','IRON_DOOR','LANTERN','LEVER'];
const pool=[...districts.flatMap(district=>flowers.map(item=>({template:`garden-${district.id}-${item}`,kind:'garden',item,district:district.id,goal:4,
  name:`${district.name}: ${item==='LANTERN'?'green-space lanterns':nice(item)+' flower beds'}`,
  benefit:item==='LANTERN'?'Make shared green spaces brighter and more welcoming.':'Add colour to empty ground in public green spaces.'}))),
  ...outputs.map(item=>({template:`supply-${item}`,kind:'supply',item,goal:recipeFor(item).out*Math.min(4,/DOOR|GATE|CHEST|TABLE|FURNACE|LANTERN|LEVER/.test(item)?2:4),
    name:`Make ${nice(item)} for village improvements`,benefit:/DOOR|GATE|FENCE/.test(item)?'Supply entrances and enclosures for village repairs.':/LANTERN|LADDER|CHEST|TABLE|FURNACE|LEVER/.test(item)?'Equip the village with useful fittings and tools.':'Supply building finishes for paths, homes and public buildings.'}))];
const contains=(p,b,margin=0)=>p.x>=b.x1-margin&&p.x<=b.x2+margin&&p.z>=b.z1-margin&&p.z<=b.z2+margin;
/** Only adopted public/park ground, outside buildings, roads, farms and recent player edits. */
export function gardenCandidates({zones=[],footprints=[],roads=[],farms=[],playerEdits={},protectedAt=()=>false}={},time=Date.now()){
  const out=[],seen=new Set();
  const reserved=zones.filter(z=>z.status==='adopted'&&!['park','public'].includes(z.kind));
  for(const z of zones.filter(z=>['park','public'].includes(z.kind)&&z.status==='adopted'))
    for(let x=Math.ceil(z.x1)+1;x<z.x2;x++)for(let zz=Math.ceil(z.z1)+1;zz<z.z2;zz++){
      const p={x,z:zz},key=`${x},${zz}`;
      if(seen.has(key)||reserved.some(b=>contains(p,b,1))||protectedAt(x,zz)||footprints.some(b=>contains(p,b,1))||farms.some(b=>contains(p,b,1)))continue;
      if(roads.some(r=>contains(p,{x1:Math.min(r.a.x,r.b.x),x2:Math.max(r.a.x,r.b.x)+(r.width??2)-1,z1:Math.min(r.a.z,r.b.z),z2:Math.max(r.a.z,r.b.z)+(r.width??2)-1},1)))continue;
      if(playerEdits[key]&&time-playerEdits[key]<86400000)continue;
      seen.add(key);out.push(p);
    }
  return out;
}
const shuffled=(list,random)=>list.map(value=>({value,key:random()})).sort((a,b)=>a.key-b.key).map(x=>x.value);
function resolvedInputs(recipe,stock,inventory={}){
  return Object.fromEntries(Object.entries(recipe.inputs).map(([key,n])=>{
    if(key==='any_PLANKS')key=['OAK_PLANKS','SPRUCE_PLANKS'].sort((a,b)=>(stock[b]??0)+(inventory[b]??0)-(stock[a]??0)-(inventory[a]??0))[0];
    if(key==='any_LOG')key=['OAK_LOG','SPRUCE_LOG'].sort((a,b)=>(stock[b]??0)+(inventory[b]??0)-(stock[a]??0)-(inventory[a]??0))[0];
    return [key,n];
  }));
}
export function createCommunityBoard(d){
  const {state,configs,save,stock,land,goToWarehouse,withdraw,deposit,travel,act}=d;
  const now=d.now??(()=>Date.now()),random=d.random??Math.random,log=d.log??(()=>{}),ledger=d.ledger??(()=>{});
  for(const m of state.items??[])if(m.kind==='garden'&&m.item==='LANTERN'&&m.status!=='completed'){
    m.kind='supply';m.name='Make lanterns for village lamp posts';m.benefit='Supply supported street lighting.';
  }
  const workers=configs.filter(c=>!['guardian','sheriff','judge','banker','clerk','merchant','courier','builder','miner','chef','herbalist','farmer','fisher','lumberjack'].includes(c.role??c.id));
  let rolling=null;const running=new Set(),planting=new Set();
  // An interrupted write cannot safely be assumed failed or credited as completed after restart.
  for(const m of state.items??[])if(m.operation){m.status='review';m.note='Interrupted action needs inspection before retrying.';}
  async function tick(){
    const date=communityDate(now());if(state.date&&state.date>=date)return;
    if(rolling)return rolling;
    rolling=(async()=>{
      if(running.size)return; // Finish in-flight actions before archiving yesterday.
      const previous=new Set((state.items??[]).map(m=>m.template));
      if(state.date)(state.history??=[]).unshift({date:state.date,items:structuredClone(state.items)});
      state.history=(state.history??[]).slice(0,14);
      const available=stock(),chosen=[];
      for(const [kind,count] of [['garden',4],['supply',6]]){
        const candidates=shuffled(pool.filter(m=>m.kind===kind),random);
        const feasible=m=>kind==='garden'?(available[m.item]??0)>=m.goal:
          roomFor(m.item,m.goal,available[m.item]??0)>=m.goal&&Object.entries(resolvedInputs(recipeFor(m.item),available)).every(([k,n])=>(available[k]??0)>=n*m.goal/recipeFor(m.item).out);
        candidates.sort((a,b)=>Number(previous.has(a.template))-Number(previous.has(b.template))||Number(!feasible(a))-Number(!feasible(b)));
        chosen.push(...candidates.slice(0,count));
      }
      state.date=date;state.timeZone=ZONE;state.created=now();
      const used=new Set();
      state.items=chosen.map((m,i)=>{
        const preferred=m.kind==='garden'?['priest','scribe','governor','scout']:['crafter','smith','farmer','fisher','lumberjack'];
        const candidates=[...workers].sort((a,b)=>{
          const rank=c=>{const i=preferred.indexOf(c.role??c.id);return i<0?100:i;};return rank(a)-rank(b);
        });
        const worker=candidates.find(c=>!used.has(c.id))??workers[i%Math.max(1,workers.length)];if(worker)used.add(worker.id);
        return {...m,id:`${date}:${m.template}`,agent:worker?.id??null,have:0,pending:0,status:'pending',note:'',cursor:Math.floor(random()*1000),at:now()};
      });
      await save();log('community_day',{date,count:state.items.length,timeZone:ZONE});
    })().finally(()=>{rolling=null;});
    return rolling;
  }
  const view=()=>({date:state.date??null,timeZone:ZONE,completed:(state.items??[]).filter(m=>m.status==='completed').length,
    items:(state.items??[]).map(m=>({...m,agentName:configs.find(c=>c.id===m.agent)?.name??m.agent,need:m.kind==='garden'?`Place ${m.goal} ${nice(m.item)} in shared green spaces`:`Craft and deliver ${m.goal} ${nice(m.item)} for village use`})),
    history:(state.history??[]).map(h=>({date:h.date,completed:h.items.filter(m=>m.status==='completed').length,total:h.items.length}))});
  function job(c,s,self){
    if(rolling||state.date!==communityDate(now())||running.has(c.id)||s.project||s.dig||s.farm||s.producing||s.supply||s.resting||s.order||s.contract||s.errand||s.angler?.trip||self.pathing||['moving','loading'].includes(self.navigation?.status))return null;
    const m=(state.items??[]).find(m=>m.agent===c.id&&!['completed','review'].includes(m.status)&&!(m.retryAt>now()));
    if(!m)return null;
    return async()=>{
      if(running.has(c.id))return;running.add(c.id);
      try{
        m.status='in_progress';m.note='';
        if(m.kind==='garden')await garden(m,c,self);else await supply(m,c,self);
        if(m.have>=m.goal){m.have=m.goal;m.status='completed';m.completedAt=now();m.note='';ledger(c.id,`completed daily community milestone: ${m.name}`);log('community_completed',{agent:c.id,date:state.date,template:m.template});}
        m.at=now();await save();
      }catch(error){
        const uncertain=/unknown|disconnect|timeout|timed out|closed|ECONN|outcome/i.test(error.message);
        m.status=uncertain?'review':'blocked';m.note=String(error.message).slice(0,160);m.retryAt=now()+300000;
        if(!uncertain)delete m.operation;
        log('community_blocked',{agent:c.id,template:m.template,message:m.note});await save();
      }finally{running.delete(c.id);}
    };
  }
  const blocked=(m,note)=>{m.status='blocked';m.note=note;m.retryAt=now()+300000;};
  async function writing(m,type,fn){m.operation={type,at:now()};await save();const result=await fn();delete m.operation;return result;}
  async function garden(m,c,self){
    if(!(self.inventory?.[m.item]>0)){
      if(!(stock()[m.item]>0)){blocked(m,`Waiting for ${nice(m.item)} in the warehouse.`);return;}
      if(await goToWarehouse(c.id,self))await withdraw(c.id,m.item,m.goal-m.have,{procure:false});
      return;
    }
    const area=land();if(area.zones.some(z=>z.id===m.district))area.zones=area.zones.filter(z=>z.id===m.district||!['park','public'].includes(z.kind));
    const cells=gardenCandidates(area,now());if(!cells.length){blocked(m,'No suitable empty public green space is available.');return;}
    const p=cells[m.cursor%cells.length],key=`${p.x},${p.z}`;
    if(planting.has(key)){m.cursor++;return;}
    planting.add(key);try{
    const ground=await act(c.id,{type:'survey',x:p.x,y:0,z:p.z,width:1,depth:1});
    const y=ground?.heights?.[0];
    if(!Number.isFinite(y)||ground.liquid?.[0]||!['GRASS_BLOCK','DIRT','ROOTED_DIRT'].includes(ground.tops?.[0])){m.cursor++;return;}
    const scanned=await act(c.id,{type:'scan',x:p.x,y:y+1,z:p.z,width:1,height:2,depth:1});
    if(!Array.isArray(scanned?.cells))throw Error('Could not inspect planting space.');
    if(scanned.cells.length){m.cursor++;return;}
    if(Math.hypot(p.x+0.5-self.x,y+1-self.y,p.z+0.5-self.z)>6){await travel(c.id,self,{x:p.x+1.5,y:y+1,z:p.z+0.5});return;}
    await writing(m,'place',()=>act(c.id,{type:'place',x:p.x,y:y+1,z:p.z,target:m.item}));
    m.have++;m.cursor+=7;m.note=`Placed at ${p.x}, ${y+1}, ${p.z}.`;
    }finally{planting.delete(key);}
  }
  async function supply(m,c,self){
    if(m.pending>0){
      if(!(self.inventory?.[m.item]>0)){blocked(m,'Produced goods are no longer in this citizen’s inventory.');return;}
      if(!await goToWarehouse(c.id,self))return;
      const n=await writing(m,'deposit',()=>deposit(c.id,m.item,Math.min(m.pending,self.inventory[m.item])));
      if(n>0){m.have+=n;m.pending-=n;}else blocked(m,'Waiting for warehouse space or access.');
      return;
    }
    const recipe=recipeFor(m.item),left=m.goal-m.have;
    if(roomFor(m.item,left,stock()[m.item]??0)<left){blocked(m,`The village already has enough ${nice(m.item)}; waiting for it to be used.`);return;}
    const times=Math.min(16,Math.ceil(left/recipe.out)),inputs=resolvedInputs(recipe,stock(),self.inventory);
    for(const [item,per] of Object.entries(inputs)){
      const need=per*times-(self.inventory?.[item]??0);if(need<=0)continue;
      if(!(stock()[item]>0)){blocked(m,`Waiting for ${nice(item)} to make ${nice(m.item)}.`);return;}
      if(await goToWarehouse(c.id,self))await withdraw(c.id,item,need,{procure:false});return;
    }
    const r=await writing(m,'craft',()=>act(c.id,{type:'craft',x:0,y:0,z:0,target:m.item,count:times}));
    if(!(r?.times>0)||r.crafted!==m.item)throw Error('Craft outcome unknown: no finished goods confirmed.');
    m.pending=r.times*recipe.out;
  }
  return {tick,view,job};
}
