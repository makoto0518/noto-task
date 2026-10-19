/**
 * Domain logic shared by the UI and tests; no DOM or network dependencies.
 * A task moves through todo -> doing -> done, while a note has no workflow.
 * Keeping these pure functions separate makes them easy to test and reuse.
 */
export const STATUSES=['todo','doing','done'];
export function clampStatus(status){return STATUSES.includes(status)?status:'todo';}
/** Swipe right (+1) advances; left (-1) reverses. Clamp at both ends. */
export function nextStatus(status,direction){const index=STATUSES.indexOf(clampStatus(status));return STATUSES[Math.max(0,Math.min(2,index+(direction<0?-1:1)))];}
export function createItem(content,kind='note',now=new Date()){
  if(typeof content!=='string'||!content.trim())throw new TypeError('Empty item');
  if(!['note','task'].includes(kind))throw new TypeError('Unknown kind');
  return {id:crypto.randomUUID(),kind,content:content.trim().slice(0,4000),status:'todo',dueDate:null,createdAt:now.toISOString(),updatedAt:now.toISOString()};
}
/** Validate untrusted local/API records before rendering; reject malformed IDs/kinds. */
export function safeItems(input){
  if(!Array.isArray(input))return [];
  return input.filter(x=>x && typeof x.id==='string' && /^[\w-]{10,80}$/.test(x.id) && ['note','task'].includes(x.kind) && typeof x.content==='string' && x.content.trim()).map(x=>({id:x.id,kind:x.kind,content:x.content.slice(0,4000),status:clampStatus(x.status),dueDate:typeof x.dueDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.dueDate)?x.dueDate:null,createdAt:x.createdAt||new Date().toISOString(),updatedAt:x.updatedAt||x.createdAt||new Date().toISOString()})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export function getCounts(items){const counts={all:items.length,note:0,todo:0,doing:0,done:0};for(const item of items){if(item.kind==='note')counts.note++;else counts[clampStatus(item.status)]++;}return counts;}
/** Filtering and text search are local, so typing never waits for the network. */
export function getVisibleItems(items,filter='all',search=''){
  const query=search.toLocaleLowerCase('ja').trim();return items.filter(item=>(filter==='all'||(filter==='note'?item.kind==='note':item.kind==='task'&&item.status===filter))&&(!query||item.content.toLocaleLowerCase('ja').includes(query)));
}
