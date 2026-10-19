// Durable, account-scoped outbox. Writes are optimistic and serialized per device.
// Concurrent edits of the same item on different devices use last successful server write.
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
  constructor({request, storage, onData, onStatus, guestKey}) {
    this.request=request; this.storage=storage; this.onData=onData;
    this.onStatus=onStatus; this.guestKey=guestKey;
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
        this.queue=compactQueue(this.queue,{type:'put',id:item.id,item});
        this.items=mergeServerItems(this.items,[{type:'put',id:item.id,item}]);
        known.add(item.id);
      }
    }
    // Never drop guest notes until their outbox and cached copies are durable.
    this.persistQueue(); this.persistItems(); this.storage.removeItem(this.guestKey);
    this.publish(); this.status(this.queue.length?'pending':'syncing');
  }
  recordPut(item, localItems) { this.record({type:'put',id:item.id,item},localItems); }
  recordDelete(id, localItems) { this.record({type:'delete',id},localItems); }
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
        if(op.type==='delete')await this.request(`/items/${encodeURIComponent(op.id)}`,{method:'DELETE'});
        else await this.request(`/items/${encodeURIComponent(op.id)}`,{method:'PUT',body:JSON.stringify(op.item)});
      }catch { this.status('pending'); return; }
      // A newer edit may have superseded the in-flight mutation. Never discard it.
      const index=this.queue.findIndex(entry=>entry.id===op.id);
      if(index>=0 && this.queue[index]===op){this.queue.splice(index,1);this.persistQueue();}
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
