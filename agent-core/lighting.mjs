// Outdoor street furniture: a stone shaft and fence arms supporting hanging lanterns.
export function lampPlan(p){
 const out=[];
 for(let h=0;h<5;h++)out.push({x:p.x,y:p.y+h,z:p.z,block:'CHISELED_STONE_BRICKS'});
 for(const n of [-1,1]){
  const x=p.x+(p.axis==='z'?0:n),z=p.z+(p.axis==='z'?n:0);
  out.push({x,y:p.y+4,z,block:'SPRUCE_FENCE'});
  out.push({x,y:p.y+3,z,block:'LANTERN',hanging:true});
 }
 out.push({x:p.x,y:p.y+5,z:p.z,block:'SPRUCE_FENCE'});
 return out;
}
export function lampSiteSafe(p,cells,posts=[],roadColumns=new Set()){
 if(lampPlan(p).some(b=>roadColumns.has(`${b.x},${b.z}`)))return false;
 if(!Array.isArray(cells)||posts.some(q=>Math.hypot(q.x-p.x,q.z-p.z)<10))return false;
 const ground=cells.find(c=>c[0]===p.x&&c[1]===p.y-1&&c[2]===p.z);
 if(!ground||!['GRASS_BLOCK','DIRT','ROOTED_DIRT'].includes(ground[3]))return false;
 return !cells.some(c=>/DOOR|LANTERN|TORCH|FARMLAND|WHEAT|CARROT|POTATO|BEETROOT/.test(c[3])||
  ((p.axis==='z'?c[0]===p.x&&Math.abs(c[2]-p.z)<=1:c[2]===p.z&&Math.abs(c[0]-p.x)<=1)
   &&c[1]>=p.y&&c[1]<=p.y+5&&!['AIR','SHORT_GRASS','TALL_GRASS'].includes(c[3])));
}
