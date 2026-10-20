// Durable, account-scoped outbox. Writes are optimistic and serialized per device.
// Stale cross-device edits are saved as separate conflict copies rather than overwriting others.
import { safeItems } from './logic.js';

/**
 * Storage separation matters: two Google accounts on the same browser must
 * never share their draft synchronization queue. The legacy mizu_* prefix is
 * intentional: changing it would strand notes created by earlier versions.
 */
export const cacheKey = userId => `mizu_account_${encodeURIComponent(userId)}_items_v2`;
export const queueKey = userId => `mizu_account_${encodeURIComponent(userId)}_queue_v2`;
export function parseStored(storage, key, fallback = []) {
  try { const value = JSON.parse(storage.getItem(key) || 'null'); return Array.isArray(value) ? value : fallback; }
  catch { return fallback; }
}
/** Apply unsent local operations over the server snapshot (optimistic UI). */
export function mergeServerItems(remote, queue) {
  const merged = new Map(safeItems(remote).map(item => [item.id, item]));
  for (const op of queue) {
    if (op.type === 'delete') merged.delete(op.id);
    else if (op.type === 'put' && op.item) {
      const item = safeItems([op.item])[0];
      if (item) merged.set(item.id, item);
    }
  }
  return [...merged.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
/** Only the latest unsent action for an item matters (put/put/delete collapse). */
export function compactQueue(queue, op) {
  return [...queue.filter(entry => entry.id !== op.id), op];
}
function validQueue(queue) {
  return queue.filter(op => op && typeof op.id === 'string' &&
    (op.type === 'delete' || (op.type === 'put' && safeItems([op.item]).length)));
}
export class CloudSync {
  constructor({request, storage, onData, onStatus, onConflict=()=>{}, guestKey}) {
    this.request=request; this.storage=storage; this.onData=onData;
    this.onStatus=onStatus; this.onConflict=onConflict; this.guestKey=guestKey;
    this.userId=null; this.items=[]; this.queue=[]; this.active=true;
    this.flushing=null; this.refreshing=null; this.version=0;
  }
  status(label) { if(this.active) this.onStatus(label, this.queue.length); }
  persistQueue() { this.storage.setItem(queueKey(this.userId),JSON.stringify(this.queue)); }
  persistItems() { this.storage.setItem(cacheKey(this.userId),JSON.stringify(this.items)); }
  publish() { if(this.active) this.onData([...this.items]); }
  /** Called after OAuth session verification. Merge guest notes safely. */
  activate(userId, guestItems=[]) {
    this.userId=userId;
    this.queue=validQueue(parseStored(this.storage,queueKey(userId)));
    this.items=mergeServerItems(parseStored(this.storage,cacheKey(userId)),this.queue);
    const known=new Set(this.items.map(x=>x.id));
    for(const item of safeItems(guestItems)){
      if(!known.has(item.id)) {
        this.queue=compactQueue(this.queue,{type:'put',id:item.id,item,expectedUpdatedAt:null});
        this.items=mergeServerItems(this.items,[{type:'put',id:item.id,item}]);
        known.add(item.id);
      }
    }
    // Never drop guest notes until their outbox and cached copies are durable.
    this.persistQueue(); this.persistItems(); this.storage.removeItem(this.guestKey);
    this.publish(); this.status(this.queue.length?'pending':'syncing');
  }
  expectedRevision(id){
    const queued=this.queue.find(entry=>entry.id===id);
    if(queued)return queued.expectedUpdatedAt??null;
    return this.items.find(item=>item.id===id)?.updatedAt??null;
  }
  recordPut(item, localItems) { this.record({type:'put',id:item.id,item,expectedUpdatedAt:this.expectedRevision(item.id)},localItems); }
  recordDelete(id, localItems) {
    if(this.expectedRevision(id)===null){
      // An unsent creation can be cancelled locally; no remote DELETE needed.
      this.queue=this.queue.filter(entry=>entry.id!==id);
      this.version++;
      this.items=safeItems(localItems);
      this.persistQueue();this.persistItems();this.publish();
      this.status(this.queue.length?'pending':'synced');
      return;
    }
    this.record({type:'delete',id,expectedUpdatedAt:this.expectedRevision(id)},localItems);
  }
  record(op,localItems) {
    if(!this.active||!this.userId)return;
    this.queue=compactQueue(this.queue,op);this.version++;
    // Persist outbox first; loss of the cache cannot lose the mutation.
    this.items=safeItems(localItems);
    try { this.persistQueue(); this.persistItems(); this.status('pending'); }
    catch { this.status('error'); }
    this.publish();
    this.scheduleFlush();
  }
  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer=setTimeout(()=>this.flush().catch(()=>{}),280);
  }
  async flush() {
    if(!this.active||!this.userId)return;
    if(this.flushing)return this.flushing;
    const startVersion=this.version;
    this.flushing=this.performFlush();
    try { await this.flushing; }
    finally {
      this.flushing=null;
      // A write created while the final pull was in progress must be sent too.
      if(this.active&&this.queue.length&&this.version!==startVersion)this.scheduleFlush();
    }
  }
  /**
   * Process the outbox sequentially. Every request is idempotent on the API:
   * PUT is an upsert and DELETE succeeds even if the item was already removed.
   * Keep failed operations for retry when the network returns.
   */
  async performFlush() {
    while(this.active && this.queue.length) {
      const op=this.queue[0];
      this.status('syncing');
      try {
        const result=op.type==='delete'
          ? await this.request(`/items/${encodeURIComponent(op.id)}`,{method:'DELETE',headers:{'If-Match':op.expectedUpdatedAt||''}})
          : await this.request(`/items/${encodeURIComponent(op.id)}`,{method:'PUT',body:JSON.stringify({...op.item,expectedUpdatedAt:op.expectedUpdatedAt??null})});
        if(!this.active)return;
        const index=this.queue.findIndex(entry=>entry.id===op.id);
        if(index>=0&&this.queue[index]===op){
          this.queue.splice(index,1);
          if(result?.item){
            this.items=this.items.map(item=>item.id===op.id?result.item:item);
            this.persistItems();this.publish();
          }
          this.persistQueue();
        } else if(index>=0 && result?.item && op.type==='put') {
          // The first write completed while a new edit was queued. Rebase the
          // newer local mutation on this precise server revision.
          this.queue[index].expectedUpdatedAt=result.item.updatedAt;
          this.persistQueue();
        }
      } catch(error) {
        if(error?.status!==409){this.status('pending');return;}
        // Preserve local edits even when the remote item changed or was deleted.
        const index=this.queue.findIndex(entry=>entry.id===op.id);
        if(index>=0&&this.queue[index]===op){
          this.queue.splice(index,1);
          if(op.type==='put'){
            const copy={...op.item,id:crypto.randomUUID(),content:('【競合コピー】 '+op.item.content).slice(0,4000),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
            this.queue.push({type:'put',id:copy.id,item:copy,expectedUpdatedAt:null});
            this.items=this.items.filter(item=>item.id!==op.id);
            if(error.current)this.items.push(error.current);
            this.items.push(copy);
          }else if(error.current){
            this.items=this.items.filter(item=>item.id!==op.id).concat(error.current);
          }
          this.persistQueue();this.persistItems();this.publish();
          this.onConflict(op.type==='put'?'別の端末の編集を保護し、あなたの変更を「競合コピー」として保存しました':'別の端末で変更されていたため、削除を中止しました');
        }
      }
    }
    if(this.active)await this.refresh();
  }
  /**
   * Pull changes from another device. A version check prevents an older GET
   * response from overwriting a newer locally queued edit.
   */
  async refresh() {
    if(!this.active||!this.userId)return;
    if(this.flushing && this.flushing!==this.refreshing && this.queue.length)return;
    if(this.refreshing)return this.refreshing;
    const atVersion=this.version;
    this.refreshing=(async()=>{
      try {
        const response=await this.request('/items');
        if(!this.active||this.version!==atVersion)return;
        this.items=mergeServerItems(response.items||[],this.queue);
        this.persistItems();this.publish();
        this.status(this.queue.length?'pending':'synced');
      }catch { this.status(this.queue.length?'pending':'error'); }
    })();
    try {await this.refreshing;} finally{this.refreshing=null;}
  }
  async syncNow() { await this.flush(); }
  stop() {this.active=false;clearTimeout(this.flushTimer);}
}
