/**
 * 【画面に依存しない計算】app.js が使う「状態変更・検索・件数計算」をまとめたファイル。
 * HTML・ネット通信・データベースに触れない「純粋な関数」を中心にしている。
 * 例：タスクは todo（未着手）→ doing（進行中）→ done（完了）の3段階。
 * メモにはこの進捗がない。単独で test/logic.test.mjs からテストしやすい。
 */
export const STATUSES=['todo','doing','done'];
export function clampStatus(status){return STATUSES.includes(status)?status:'todo';}
/**
 * スワイプ方向の値（右=+1、左=-1）から次のタスク状態を返す。
 * 先頭の「未着手」より前、末尾の「完了」より先へは進まない。
 * app.js のカード操作から呼ばれるが、ここでは画面操作そのものは行わない。
 */
export function nextStatus(status,direction){const index=STATUSES.indexOf(clampStatus(status));return STATUSES[Math.max(0,Math.min(2,index+(direction<0?-1:1)))];}
export function createItem(content,kind='note',now=new Date()){
  if(typeof content!=='string'||!content.trim())throw new TypeError('Empty item');
  if(!['note','task'].includes(kind))throw new TypeError('Unknown kind');
  return {id:crypto.randomUUID(),kind,content:content.trim().slice(0,4000),status:'todo',dueDate:null,createdAt:now.toISOString(),updatedAt:now.toISOString()};
}
/**
 * 【データの検証】端末保存やAPIからの不正・古い形式のレコードを除外する。
 * 壊れた値をそのまま描画したり、同期キューへ積んだりするのを防ぐ。
 * app.js・sync.js・backup.js から共通で呼ばれる。
 */
export function safeItems(input){
  if(!Array.isArray(input))return [];
  return input.filter(x=>x && typeof x.id==='string' && /^[\w-]{10,80}$/.test(x.id) && ['note','task'].includes(x.kind) && typeof x.content==='string' && x.content.trim()).map(x=>({id:x.id,kind:x.kind,content:x.content.slice(0,4000),status:clampStatus(x.status),dueDate:typeof x.dueDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.dueDate)?x.dueDate:null,createdAt:x.createdAt||new Date().toISOString(),updatedAt:x.updatedAt||x.createdAt||new Date().toISOString()})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export function getCounts(items){const counts={all:items.length,note:0,todo:0,doing:0,done:0};for(const item of items){if(item.kind==='note')counts.note++;else counts[clampStatus(item.status)]++;}return counts;}
/**
 * 一覧の種別フィルターとキーワード検索を端末内だけで行う。
 * 検索のたびにAPIを呼ぶと通信量が増え、オフライン時にも使えなくなるため。
 * app.js の render() が必要なときに呼び出す。
 */
export function getVisibleItems(items,filter='all',search=''){
  const query=search.toLocaleLowerCase('ja').trim();return items.filter(item=>(filter==='all'||(filter==='note'?item.kind==='note':item.kind==='task'&&item.status===filter))&&(!query||item.content.toLocaleLowerCase('ja').includes(query)));
}
