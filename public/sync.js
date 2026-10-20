/**
 * 【同期の中心】app.js から渡されたメモ・タスクの変更をCloudflareへ送る。
 * 「送信待ちキュー（outbox）」を localStorage に保存するので、
 * 回線が切れても操作を後から再送できる。実際の送信先は worker/index.js。
 * 異なる端末が同じメモを変更した場合は、上書きせず「競合コピー」を残す。
 * 注意：クラウド上のデータはD1、端末内の一時保存はlocalStorageという別の場所。
 */
import { safeItems } from './logic.js';

/**
 * 【アカウントごとの保存先】キーにGoogleのユーザーIDを含めてデータを分離する。
 * 同じブラウザで別のGoogleアカウントを使っても、送信待ちキューが混ざらないようにするため。
 * 旧版から使っている mizu_* は意図的な名前。変更すると古いメモを読めなくなる。
 * サーバー側でも worker/index.js の user.id で必ず利用者を絞り込む。
 */
export const cacheKey = userId => `mizu_account_${encodeURIComponent(userId)}_items_v2`;
export const epochKey = userId => `mizu_account_${encodeURIComponent(userId)}_epoch_v1`;
export const queueKey = userId => `mizu_account_${encodeURIComponent(userId)}_queue_v2`;
export function parseStored(storage, key, fallback = []) {
  try { const value = JSON.parse(storage.getItem(key) || 'null'); return Array.isArray(value) ? value : fallback; }
  catch { return fallback; }
}
/**
 * 【最新表示の合成】サーバーから受け取った一覧に、まだ送信していない端末側の変更を重ねる。
 * 先にサーバー一覧だけ表示すると、オフライン編集が一時的に消えたように見えるため。
 * app.js は合成された結果を受け取り render() で再描画する。
 */
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
/**
 * 【送信待ちキューの整理】同じIDの操作が連続したとき、最後の操作だけを残す。
 * 例：送信前に同じメモを2回編集 → 最新の編集を送信する。
 * ただし、別端末からの変更検知に必要な expectedUpdatedAt は維持する必要がある。
 */
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
    this.epoch=0;this.ready=false;this.epochMismatch=false;
  }
  status(label) { if(this.active) this.onStatus(label, this.queue.length); }
  persistQueue() { this.storage.setItem(queueKey(this.userId),JSON.stringify(this.queue)); }
  persistItems() { this.storage.setItem(cacheKey(this.userId),JSON.stringify(this.items)); }
  publish() { if(this.active) this.onData([...this.items]); }
  /**
   * 【ログイン直後】app.js の loadSession() から呼ばれる。
   * Googleアカウント別の保存データとゲスト時代のメモを合成して、
   * 送信待ちキューを端末に記録してからゲスト用の保存領域を片付ける。
   */
  activate(userId, guestItems=[]) {
    this.userId=userId;
    this.epoch=Number(this.storage.getItem(epochKey(userId))||0);
    if(!Number.isSafeInteger(this.epoch)||this.epoch<0)this.epoch=0;
    this.ready=this.epoch>0;this.epochMismatch=false;
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
    // ゲストメモを消す前に、必ずキューとキャッシュに保存する。順番を逆にすると消失し得る。
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
      // 作成自体がまだ送られていなければ、ローカルの作成を取り消すだけでよい。
      // サーバーに存在しないメモへDELETEを送らないための分岐。
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
    // 画面用キャッシュより先に送信待ちキューを保存。通信中断時も変更を再送できるようにする。
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
    if(!this.ready){await this.refresh();if(!this.ready)return;}
    if(this.flushing)return this.flushing;
    const startVersion=this.version;
    this.flushing=this.performFlush();
    try { await this.flushing; }
    finally {
      this.flushing=null;
      // 最後の受信中に新しい編集が増えた場合も、取りこぼさず次の送信を予約する。
      if(this.active&&this.queue.length&&this.version!==startVersion)this.scheduleFlush();
    }
  }
  /**
   * 【キューの送信】同じ端末からの操作を順番にAPIへ送る。
   * PUTは作成／更新、DELETEは削除。どちらも worker/index.js で本人確認する。
   * 更新・削除には expectedUpdatedAt（編集前の版）を送り、古い変更による上書きを防止。
   * 回線障害ならキューを残して後で再送し、409（競合）なら下のcatchで別コピーを作る。
   * 注意：旧版の無条件PUTとは異なり、サーバー側でも版の一致が必須。
   */
  async performFlush() {
    while(this.active && this.queue.length) {
      const op=this.queue[0];
      this.status('syncing');
      try {
        const result=op.type==='delete'
          ? await this.request(`/items/${encodeURIComponent(op.id)}`,{method:'DELETE',headers:{'If-Match':op.expectedUpdatedAt||'','X-Noto-Epoch':String(this.epoch)}})
          : await this.request(`/items/${encodeURIComponent(op.id)}`,{method:'PUT',headers:{'X-Noto-Epoch':String(this.epoch)},body:JSON.stringify({...op.item,expectedUpdatedAt:op.expectedUpdatedAt??null})});
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
          // 通信中に同じメモをさらに編集した場合、次の送信の基準を直前の保存結果に更新する。
          // これをしないと自分自身の連続編集まで409競合になってしまう。
          this.queue[index].expectedUpdatedAt=result.item.updatedAt;
          this.persistQueue();
        }
      } catch(error) {
        if(error?.reason==='epoch_changed'){
          this.invalidateEpoch(error.epoch);
          return;
        }
        if(error?.status!==409){this.status('pending');return;}
        // 別端末で更新されていても、今回の編集内容を捨てず「【競合コピー】」として保存する。
        // 元メモはサーバーの最新版を採用し、利用者が後から両方を見比べられるようにする。
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
   * 【最新データの取得】別端末の変更をGET /api/itemsから受け取る。
   * 通信を始めたあとに新しい編集が発生したら、古い応答を採用しない。
   * 古い応答で端末内の未同期変更を上書きしないための version チェック。
   * app.js の「同期」ボタンや25秒ごとの同期からも呼ばれる。
   */
  /**
   * 全削除後の古い端末の未送信キューは再送できない。
   * 新しい世代を受け取ったら、キューとキャッシュを破棄して最新データに入れ替える。
   */
  invalidateEpoch(epoch,remoteItems=[]){
    if(!Number.isSafeInteger(epoch)||epoch<0)return;
    this.epoch=epoch;this.ready=true;this.epochMismatch=true;this.queue=[];this.version++;
    this.storage.setItem(epochKey(this.userId),String(epoch));
    this.items=safeItems(remoteItems);this.persistQueue();this.persistItems();this.publish();
    this.status('synced');this.onConflict('別の端末で全記録が削除されたため、古い未同期変更を取り消しました');
  }
  /**
   * 設定画面からの全削除後に呼ぶ。サーバーの新しい世代へ安全に切り替える。
   */
  clearLocal(epoch){
    this.invalidateEpoch(epoch,[]);this.epochMismatch=false;
  }
  async refresh() {
    if(!this.active||!this.userId)return;
    if(this.flushing && this.flushing!==this.refreshing && this.queue.length)return;
    if(this.refreshing)return this.refreshing;
    const atVersion=this.version;
    this.refreshing=(async()=>{
      try {
        const response=await this.request('/items');
        if(!this.active||this.version!==atVersion)return;
        if(Number.isSafeInteger(response.epoch)&&response.epoch!==this.epoch){
          this.invalidateEpoch(response.epoch,response.items||[]);
          this.epochMismatch=false;return;
        }
        this.ready=true;
        this.storage.setItem(epochKey(this.userId),String(this.epoch));
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
