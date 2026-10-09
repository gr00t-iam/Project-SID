export function requestDelivery(queue,to,item,count,now=Date.now()){
 let r=queue.find(r=>r.to===to&&r.item===item);
 if(r){r.count=Math.max(r.count,count);return r;}
 r={id:`${to}:${item}:${now}`,to,item,count,at:now};queue.push(r);return r;
}
export function nextDelivery(queue,stock){
 const r=queue.find(r=>r.count>0&&(stock[r.item]??0)>0);
 return r?{kind:'supply',to:r.to,for:'requested warehouse delivery',requestId:r.id,items:{[r.item]:Math.min(64,r.count,stock[r.item])}}:null;
}
export function recordDelivery(queue,id,given){
 const r=queue.find(r=>r.id===id);if(!r)return;
 r.count=Math.max(0,r.count-(given[r.item]??0));
 if(!r.count)queue.splice(queue.indexOf(r),1);
}
