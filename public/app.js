import { clampStatus, createItem, getCounts, getVisibleItems, nextStatus, safeItems } from './logic.js';
/**
 * 【画面の司令塔】index.html のボタンや入力欄に動作を結び付けるファイル。
 * 役割分担：logic.js＝データの計算、sync.js＝端末保存とクラウド同期、
 * backup.js＝JSONバックアップ、quota.js＝無料枠の表示。
 * 実際のAPI処理は worker/index.js、見た目は style.css が担当する。
 * 学習の順番は「addItem → saveRemote → sync.js の recordPut」が分かりやすい。
 */
import { CloudSync, cacheKey, queueKey } from './sync.js';
import { renderQuotaPanel } from './quota.js';
import { buildBackup, backupFilename } from './backup.js';

// state は画面が今表示しているデータ（表示用の状態）。
// 通信の完了を待たずに先に表示し、失敗時の再送は sync.js の CloudSync に任せる。
// タスクの状態遷移や検索の計算は logic.js に分け、画面処理との混在を防ぐ。
const $ = (id) => document.getElementById(id);
// 保存キー名が旧称 mizu_* のままなのは、旧版の端末内メモを読めるようにするため。
// 名前だけを安易に変更すると、以前のデータが見えなくなる場合がある。
const storageKey = 'mizu_guest_items_v1';
const draftKey = 'mizu_capture_draft_v1';
let cloudSync = null;
let syncStatus = 'local';
const accountIcon = document.getElementById('account-btn').innerHTML;
const state = { items: [], user: null, mode: 'note', filter: 'all', search: '', editing: null, toastTimer: null, undo: null, loadingSession: true };

function getLocalItems() {
  try { return safeItems(JSON.parse(localStorage.getItem(storageKey) || '[]')); } catch { return []; }
}
function persistGuest() { if (!state.user) { try { localStorage.setItem(storageKey, JSON.stringify(state.items)); } catch { toast('保存容量が不足しています'); } } }
function errorMessage(error) { return error?.message || '通信に失敗しました'; }
/**
 * 【APIの共通窓口】例えば api('/items') は同じサイトの /api/items にアクセスする。
 * GoogleログインのセッションCookieはブラウザが自動送信し、JSからは読み取れない。
 * サーバー側 worker/index.js の route() が本人確認と権限確認を行う。
 * エラーの status/current は sync.js に渡り、409（競合）を判定するために必要。
 */
async function api(path, opts={}) {
  const response=await fetch('/api'+path,{ credentials:'same-origin', ...opts, headers:{'Content-Type':'application/json', ...(opts.headers||{})} });
  const json=await response.json().catch(()=>({}));
  if(!response.ok) {const error=new Error(json.error || `通信エラー (${response.status})`);error.status=response.status;error.current=json.current??null;throw error;}
  return json;
}
function updateSync() {
  const loggedIn=Boolean(state.user);
  const node=$('sync-state');node.className='sync-state '+(loggedIn?syncStatus:'local');
  const labels={local:'この端末に保存',syncing:'同期中…',synced:'クラウドに同期',pending:'未同期',error:'接続待ち'};
  const pending=cloudSync?.queue.length||0;
  $('sync-label').textContent=loggedIn&&pending ? `未同期 ${pending}件` : (labels[loggedIn?syncStatus:'local']||'接続待ち');
  $('sync-refresh').hidden=!loggedIn;
  $('sync-refresh').disabled=syncStatus==='syncing';
  $('sync-refresh').title=pending?`未同期 ${pending}件を再送`:'今すぐ同期';
  $('account-btn').title=loggedIn?'アカウント':'Googleでログイン';
  $('account-btn').setAttribute('aria-label',loggedIn?'アカウントを開く':'Googleでログイン');
  if(loggedIn&&state.user?.avatarUrl&&/^https:\/\/lh3\.googleusercontent\.com\//.test(state.user.avatarUrl)){
    const image=document.createElement('img');image.src=state.user.avatarUrl;image.alt=''; $('account-btn').replaceChildren(image);
  } else $('account-btn').innerHTML=accountIcon;
}
function applyTheme() {
  const dark=document.documentElement.dataset.theme==='dark';
  $('theme-toggle').setAttribute('aria-pressed',String(dark));
  $('theme-toggle').setAttribute('aria-label',dark?'ライトモードへ切り替え':'ダークモードへ切り替え');
  $('theme-toggle').title=dark?'ライトモードへ':'ダークモードへ';
  $('theme-icon').setAttribute('d',dark?'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z':'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#111827':'#f5f8ff');
}
function toggleTheme() {
  const next=document.documentElement.dataset.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme=next;
  try {localStorage.setItem('mizu_theme_v1',next);}catch{}
  applyTheme();
}
function shortDate(date) {
  const d=new Date(date);
  if(Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP',{month:'short', day:'numeric'}).format(d);
}
function todayLabel() {
  const d=new Date();const weekdays=['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'];
  return `${d.getMonth()+1}月${d.getDate()}日 ${weekdays[d.getDay()]}`;
}
/**
 * 【一覧の再描画】state.items から件数・達成率・カードを組み立て直す。
 * 集計や絞り込みは logic.js、カードの外観は style.css と対応する。
 * メモ本文は innerHTML に混ぜず textContent に設定し、
 * 入力された文字が意図せずHTMLとして実行されないようにする。
 */
function render() {
  const counts=getCounts(state.items);
  $('total-count').textContent=String(counts.all);
  for(const key of ['all','todo','doing','done','note']) $('count-'+key).textContent = counts[key] ? counts[key] : '';
  const totalTasks = counts.todo+counts.doing+counts.done;
  const pct=totalTasks ? Math.round(counts.done/totalTasks*100):0;
  $('progress-ring').style.setProperty('--percent', `${pct}%`);
  $('progress-ring').setAttribute('aria-label',`タスク完了率 ${pct}%`);
  $('progress-value').textContent=`${pct}%`;
  $('summary-line').textContent=totalTasks ? `${counts.done}件完了 ・ ${counts.todo+counts.doing}件のタスクが残っています` : `タスク ${totalTasks}件 ・ メモ ${counts.note}件`;
  document.querySelectorAll('.filter').forEach(el=>{const active=el.dataset.filter===state.filter;el.classList.toggle('active',active);el.setAttribute('aria-selected',String(active));});
  $('dock-all').classList.toggle('active',state.filter==='all');
  $('dock-tasks').classList.toggle('active',state.filter==='doing');
  const visible=getVisibleItems(state.items,state.filter,state.search);
  const list=$('item-list');list.replaceChildren();
  visible.forEach(item=>list.appendChild(makeCard(item)));
  $('empty-state').hidden=visible.length!==0;
  if(visible.length===0){
    $('empty-title').textContent=state.search ? '見つかりませんでした' : state.filter==='all' && !counts.all ? 'まだ何もありません' : 'ここにはまだありません';
    $('empty-subtitle').textContent=state.search ? '別のキーワードで探してみてください。':'上の入力欄から追加できます。';
  }
}
/**
 * 【タスクカードのスワイプ】Pointer Events を使い、PCのマウスとAndroidの指を共通処理する。
 * 横方向の動きが縦方向より大きい場合だけスワイプとして扱うのは、
 * スマホの通常の縦スクロールを邪魔しないため。
 * 72px以上動かしたときだけ logic.js の nextStatus() で状態を進める／戻す。
 * 変更したタスクは saveRemote() → sync.js の順にクラウドへ送られる。
 */
function makeCard(item) {
  const wrap=document.createElement('div');wrap.className='item-swipe-wrap';wrap.dataset.id=item.id;
  const backdrop=document.createElement('div');backdrop.className='swipe-backdrop';
  backdrop.innerHTML='<span class="left">← 戻す</span><span class="right">進める →</span>';
  const card=document.createElement('div');card.className='item-card entering'+(item.status==='done'&&item.kind==='task'?' is-done':'');
  card.setAttribute('role','button');card.tabIndex=0;
  card.setAttribute('aria-label',`${item.kind==='note'?'メモ': 'タスク'}: ${item.content.slice(0,65)}。編集する`);
  const icon=document.createElement('div');icon.className='status-icon '+(item.kind==='note'?'note':item.status);
  icon.textContent=item.kind==='note'?'✎':item.status==='done'?'✓':item.status==='doing'?'◷':'○';
  const main=document.createElement('div');main.className='item-main';
  const content=document.createElement('p');content.className='item-content';content.textContent=item.content;
  const meta=document.createElement('div');meta.className='item-meta';
  const pill=document.createElement('span');pill.className='status-pill '+(item.kind==='note'?'note':item.status);pill.textContent=item.kind==='note'?'メモ':({todo:'未着手',doing:'進行中',done:'完了'}[item.status]);
  const stamp=document.createElement('span');stamp.textContent=shortDate(item.createdAt);
  meta.append(pill,stamp);
  if(item.dueDate){const due=document.createElement('span');due.className='due-pill';due.textContent='期限 '+item.dueDate.replaceAll('-','/');meta.appendChild(due);}
  main.append(content,meta);
  const arrow=document.createElement('span');arrow.className='edit-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';
  card.append(icon,main,arrow);wrap.append(backdrop,card);
  let originX=0,originY=0,dx=0,dragging=false,suppressClick=false;
  card.addEventListener('pointerdown',(e)=>{if(item.kind==='note'||e.button!==0)return;originX=e.clientX;originY=e.clientY;dx=0;dragging=false;suppressClick=false;});
  card.addEventListener('pointermove',(e)=>{
    if(item.kind==='note'||!e.isPrimary||e.buttons===0&&e.pointerType==='mouse')return;
    const x=e.clientX-originX,y=e.clientY-originY;
    if(!dragging&&(Math.abs(x)<12||Math.abs(x)<Math.abs(y)*1.2))return;
    if(!dragging){dragging=true;card.setPointerCapture(e.pointerId);card.classList.add('dragging');}
    dx=Math.max(-145,Math.min(145,x));card.style.transform=`translateX(${dx}px)`;
  });
  card.addEventListener('pointerup',()=>{
    if(!dragging)return;
    suppressClick=true;card.classList.remove('dragging');card.style.transform='';
    if(Math.abs(dx)>=72) changeStatus(item, dx>0 ? 1:-1);
    dragging=false;
  });
  card.addEventListener('pointercancel',()=>{dragging=false;card.classList.remove('dragging');card.style.transform='';});
  card.addEventListener('click',(event)=>{if(suppressClick){suppressClick=false;event.preventDefault();return;}openEditor(item.id);});
  card.addEventListener('keydown',(event)=>{
    if(event.key==='Enter'||event.key===' '){event.preventDefault();openEditor(item.id);}
    if(item.kind==='task'&&event.altKey&&['ArrowRight','ArrowLeft'].includes(event.key)){event.preventDefault();changeStatus(item,event.key==='ArrowRight'?1:-1);}
  });
  return wrap;
}
function toast(message, undoHandler) {
  if(state.toastTimer)clearTimeout(state.toastTimer);
  state.undo=undoHandler||null;const node=$('toast');node.replaceChildren(document.createTextNode(message));
  if(undoHandler){const undo=document.createElement('button');undo.type='button';undo.textContent='元に戻す';undo.addEventListener('click',()=>{state.undo?.();hideToast();});node.appendChild(undo);}
  node.hidden=false;requestAnimationFrame(()=>node.classList.add('visible'));
  state.toastTimer=setTimeout(hideToast,4400);
}
function hideToast(){const el=$('toast');el.classList.remove('visible');state.undo=null;if(state.toastTimer)clearTimeout(state.toastTimer);setTimeout(()=>{if(!el.classList.contains('visible'))el.hidden=true;},260);}
/**
 * 【先に画面へ反映する保存方式】回線が遅くても入力を待たせないため、
 * addItem()/saveEdit() が先に state を更新し、そのあと recordPut() に送信を依頼する。
 * sync.js は送信待ちの内容を端末内に保持し、オフラインなら後で再送する。
 * worker/index.js の PUT /api/items/:id が最終的にD1へ保存する。
 */
function saveRemote(item) {
  if(!state.user)return;
  cloudSync?.recordPut(item,state.items);
}
function addItem(content,kind=state.mode,showToast=true) {
  if(!content.trim())return null;
  const item=createItem(content,kind);
  state.items=[item,...state.items];persistGuest();render();saveRemote(item);
  if(showToast)toast(kind==='note'?'メモを保存しました':'タスクを追加しました',()=>removeItem(item.id,false));
  return item;
}
function removeItem(id,undoToast=true){
  const item=state.items.find(entry=>entry.id===id);if(!item)return;
  state.items=state.items.filter(entry=>entry.id!==id);persistGuest();render();
  if(state.user)cloudSync?.recordDelete(id,state.items);
  if(undoToast)toast('削除しました',()=>{state.items=[item,...state.items];persistGuest();render();saveRemote(item);});
}
function changeStatus(item,direction){
  if(item.kind!=='task')return;
  const status=nextStatus(item.status,direction);
  if(status===item.status){toast(direction===1?'すでに完了です':'すでに未着手です');return;}
  const updated={...item,status,updatedAt:new Date().toISOString()};
  state.items=state.items.map(v=>v.id===item.id?updated:v);persistGuest();render();saveRemote(updated,'PATCH');
  toast(({todo:'未着手',doing:'進行中',done:'完了'}[status])+'に変更しました',()=>{state.items=state.items.map(v=>v.id===item.id?item:v);persistGuest();render();saveRemote(item,'PATCH');});
}
function setMode(mode){state.mode=mode;for(const kind of ['note','task']){$('mode-'+kind).classList.toggle('selected',mode===kind);$('mode-'+kind).setAttribute('aria-pressed',String(mode===kind));}$('capture-input').placeholder=mode==='note'?'ここにメモを書く…':'新しいタスクを追加…';}
function setFilter(filter){state.filter=filter;render();}
function openEditor(id){
  const item=state.items.find(v=>v.id===id);if(!item)return;
  state.editing=id;$('dialog-title').textContent=item.kind==='note'?'メモを編集':'タスクを編集';
  $('edit-content').value=item.content;$('edit-task-fields').hidden=item.kind==='note';$('edit-status').value=clampStatus(item.status);$('edit-date').value=item.dueDate||'';
  $('ai-section').hidden=item.kind!=='note';$('ai-suggestions').replaceChildren();$('dialog-backdrop').hidden=false;
  document.body.style.overflow='hidden';requestAnimationFrame(()=>$('edit-content').focus());
}
function closeEditor(){$('dialog-backdrop').hidden=true;state.editing=null;document.body.style.overflow='';}
function saveEdit(){
  const current=state.items.find(item=>item.id===state.editing);if(!current)return;
  const content=$('edit-content').value.trim();if(!content){toast('内容を入力してください');return;}
  const updated={...current,content,status:current.kind==='task'?clampStatus($('edit-status').value):'todo',dueDate:current.kind==='task'?$('edit-date').value||null:null,updatedAt:new Date().toISOString()};
  state.items=state.items.map(item=>item.id===updated.id?updated:item);persistGuest();render();saveRemote(updated,'PATCH');closeEditor();toast('保存しました');
}
/**
 * 【アカウント画像】worker/index.js がGoogleから取得した画像URLを表示する。
 * 画像を読み込めない場合やログアウト中は従来の「✳」を使う。
 * URLをHTML文字列として結合せず、img要素のsrcに代入するのは安全性のため。
 * HTMLの id="account-icon" と style.css の .account-icon が対応する。
 */
function updateAccountAvatar(){
  const host=$('account-icon');
  host.classList.remove('has-avatar');
  host.textContent='✳';
  const avatarUrl=state.user?.avatarUrl;
  if(typeof avatarUrl!=='string'||!/^https:\/\/lh3\.googleusercontent\.com\//.test(avatarUrl))return;
  const img=document.createElement('img');
  img.alt=''; // 直下の見出しに氏名を表示するため、画像の代替テキストで重複して読ませない。
  img.src=avatarUrl;
  img.decoding='async';
  img.onerror=()=>{
    if(!host.contains(img))return; // Ignore errors from an old session/image.
    host.classList.remove('has-avatar');
    host.textContent='✳';
  };
  host.classList.add('has-avatar');
  host.replaceChildren(img);
}
function showAccount(){
  updateAccountAvatar();
  $('account-backdrop').hidden=false;
  if(state.user){$('account-title').textContent=state.user.name||state.user.email;const pending=cloudSync?.queue.length||0;$('account-description').textContent=pending ? `${state.user.email} ・ 未同期 ${pending}件。接続後に再送します。` : `${state.user.email} ・ ${syncStatus==='synced'?'同期済み':'接続を確認中'}`;$('google-btn-label').textContent='ログアウト';}
  else{$('account-title').textContent='クラウドに同期';$('account-description').textContent='Googleアカウントでログインすると、別の端末からも使えます。';$('google-btn-label').textContent='Googleでログイン';}
}
function closeAccount(){$('account-backdrop').hidden=true;}
async function logout(){
  if(cloudSync?.queue.length){
    await cloudSync.syncNow();
    if(cloudSync.queue.length){toast('未同期の変更があります。通信復帰後にログアウトしてください');return;}
  }
  try{await api('/logout',{method:'POST'});}catch(e){toast('ログアウトできませんでした');return;}
  cloudSync?.stop();
  try{localStorage.removeItem(cacheKey(state.user.id));localStorage.removeItem(queueKey(state.user.id));}catch{}
  cloudSync=null;syncStatus='local';
  state.user=null;state.items=getLocalItems();updateSync();render();closeAccount();toast('ログアウトしました');
}
/**
 * 【起動時のログイン復元】/api/session で本人確認し、ログイン済みなら CloudSync を開始する。
 * 通信中も入力欄を使えるよう非同期で実行する（initialize() と連携）。
 * 端末内の未同期データは sync.js に引き継がれるので、削除してはいけない。
 */
async function loadSession(){
  try{
    const result=await api('/session');
    if(result.authenticated&&result.user){
      state.user=result.user;
      cloudSync=new CloudSync({
        request:api,storage:localStorage,guestKey:storageKey,
        onData:items=>{state.items=items;render();},
        onConflict:message=>toast(message),
        onStatus:(status)=>{syncStatus=status;updateSync();}
      });
      cloudSync.activate(state.user.id,getLocalItems());
      updateSync();
      await cloudSync.syncNow();
      if(location.hash === '#/settings/usage') fetchUsage();
    }
  }catch(error){ /* 一時的な通信障害でも、端末内でのメモ作成は続けられるようにする。 */ }
  finally{state.loadingSession=false;}
}
/**
 * 【AIタスク抽出】利用者が「AIでタスクを抽出」を押したときだけ本文を送る。
 * worker/index.js の /api/ai/tasks → task-extraction.js で候補を検証する。
 * 候補は自動保存せず、「＋タスク化」を押したものだけ addItem() で登録する。
 * 自由記述のメモは個人情報を含むことがあるため、無断でAIへ送らない。
 */
async function runAI(){
  if(!state.user){closeEditor();showAccount();toast('AI機能にはGoogleログインが必要です');return;}
  const text=$('edit-content').value.trim();if(!text){toast('メモの内容を入力してください');return;}
  const button=$('ai-button');button.disabled=true;button.textContent='解析中…';$('ai-suggestions').replaceChildren();
  try{
    const response=await api('/ai/tasks',{method:'POST',body:JSON.stringify({text})});
    const tasks=Array.isArray(response.tasks)?response.tasks:[];
    if(!tasks.length){$('ai-suggestions').textContent='抽出できるタスクはありませんでした';return;}
    for(const suggestion of tasks){if(!suggestion.title)continue;
      const row=document.createElement('div');row.className='ai-suggestion';const title=document.createElement('span');title.textContent=suggestion.title;
      const add=document.createElement('button');add.textContent='＋ タスク化';add.addEventListener('click',()=>{addItem(suggestion.title,'task',false);add.textContent='追加済み';add.disabled=true;toast('タスクを追加しました');});
      row.append(title,add);$('ai-suggestions').appendChild(row);
    }
  } catch(error){toast('AIを利用できません: '+errorMessage(error));}
  finally{button.disabled=false;button.innerHTML='<span>✧</span> AIでタスクを抽出 <span class="ai-arrow">↗</span>';}
}
/**
 * 【起動処理】まず端末内のデータと下書きを復元し、操作できる画面を優先して表示する。
 * スケルトン（読み込み中の仮画面）は index.html にあり、style.css で表示を制御。
 * Googleログイン確認は loadSession() に任せ、通信が遅くても入力を妨げない。
 */
async function initialize(){
  state.items=getLocalItems();$('date-label').textContent=todayLabel();applyTheme();displayView();
  try{$('capture-input').value=localStorage.getItem(draftKey)||'';}catch{}
  $('add-btn').disabled=!$('capture-input').value.trim();render();updateSync();
  const session=loadSession();
  await Promise.race([session,new Promise(resolve=>setTimeout(resolve,260))]);
  await new Promise(resolve=>setTimeout(resolve,120));
  $('app').classList.add('ready');$('app').removeAttribute('aria-hidden');
  $('skeleton').classList.add('fading');setTimeout(()=>$('skeleton').remove(),290);
  if(matchMedia('(min-width: 681px)').matches)$('capture-input').focus({preventScroll:true});
}

/**
 * 【画面切り替え】URLの #/settings などを見て、index.html の各main要素を切り替える。
 * ページ全体を読み直さないので、入力途中の下書きが消えにくい。
 * ブラウザの「戻る」操作にも対応し、インストール型PWAでも使いやすい。
 */
function displayView() {
  const destination = location.hash === '#/settings/usage' ? 'usage'
    : location.hash === '#/settings' ? 'settings' : 'home';
  $('home-view').hidden = destination !== 'home';
  $('settings-view').hidden = destination !== 'settings';
  $('usage-view').hidden = destination !== 'usage';
  document.querySelector('.mobile-dock').hidden = destination !== 'home';
  if (destination === 'usage') fetchUsage();
  // 別の画面に移っても入力欄はDOMに残るため、書きかけの文章を保持できる。
  window.scrollTo({ top:0, behavior:'instant' });
}
function navigate(view) {
  const next = view === 'home' ? '' : `#/${view}`;
  if (location.hash === next) displayView();
  else location.hash = next; // hashchangeイベントが描画を実行する。重複呼び出しを避ける。
}
async function fetchUsage() {
  // 無料枠の照会は画面を開いたときと「更新」時だけ。定期通信による無駄なAPI消費を防ぐ。
  $('usage-refresh').disabled = true;
  $('quota-source').textContent = '使用量を確認しています…';
  renderQuotaPanel(null);
  if (!state.user) {
    $('quota-source').textContent = 'Googleログイン後に使用状況を確認できます。';
    $('quota-notice').textContent = '設定にはCloudflare管理者の認証が必要です。アプリのメモはログイン前でも利用できます。';
    $('usage-refresh').disabled = false;
    return;
  }
  try {
    const info = await api('/usage');
    // 通信が返るまでに画面を移動した場合は、古い使用量結果を表示しない。
    if (location.hash === '#/settings/usage') renderQuotaPanel(info);
  } catch (error) {
    renderQuotaPanel(null);
    $('quota-source').textContent = '使用量を取得できませんでした';
    $('quota-notice').textContent = errorMessage(error);
  } finally { $('usage-refresh').disabled = false; }
}

$('theme-toggle').addEventListener('click',toggleTheme);
$('settings-btn').addEventListener('click',()=>navigate('settings'));
$('settings-back').addEventListener('click',()=>navigate('home'));
$('settings-usage').addEventListener('click',()=>navigate('settings/usage'));
$('settings-backup').addEventListener('click',()=>{
  if(state.loadingSession){toast('読み込み完了後にバックアップしてください');return;}
  const snapshot=buildBackup(state.items,{
    userId:state.user?.id??null,
    pendingSyncCount:cloudSync?.queue.length??0
  });
  const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;link.download=backupFilename();
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  toast(snapshot.pendingSyncCount?'未同期の変更も含めてJSON保存しました':'JSONバックアップを保存しました');
});
$('usage-back').addEventListener('click',()=>navigate('settings'));
$('usage-refresh').addEventListener('click',fetchUsage);
window.addEventListener('hashchange',displayView);
$('sync-refresh').addEventListener('click',()=>cloudSync?.syncNow());
const systemTheme=matchMedia('(prefers-color-scheme: dark)');
systemTheme.addEventListener?.('change',event=>{if(!localStorage.getItem('mizu_theme_v1')){document.documentElement.dataset.theme=event.matches?'dark':'light';applyTheme();}});
window.addEventListener('online',()=>cloudSync?.syncNow());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)cloudSync?.syncNow();});
// 画面表示中だけ25秒ごとに同期。常時接続の有料サービスを使わないための設計。
// 実際の再送や競合検知は sync.js、サーバー上の保存は worker/index.js が担当する。
setInterval(()=>{if(!document.hidden&&navigator.onLine)cloudSync?.syncNow();},25000);
$('mode-note').addEventListener('click',()=>setMode('note'));
$('mode-task').addEventListener('click',()=>setMode('task'));
$('capture-input').addEventListener('input',()=>{const el=$('capture-input');$('add-btn').disabled=!el.value.trim();el.style.height='auto';el.style.height=Math.min(el.scrollHeight,250)+'px';try{localStorage.setItem(draftKey,el.value);}catch{}});
$('capture-input').addEventListener('keydown',(e)=>{if((e.key==='Enter'&&(e.ctrlKey||e.metaKey))){e.preventDefault();submitCapture();}});
function submitCapture(){const el=$('capture-input');if(!el.value.trim())return;addItem(el.value,state.mode);el.value='';el.style.height='';$('add-btn').disabled=true;try{localStorage.removeItem(draftKey);}catch{}el.focus({preventScroll:true});}
$('add-btn').addEventListener('click',submitCapture);
document.querySelectorAll('[data-filter]').forEach(btn=>btn.addEventListener('click',()=>setFilter(btn.dataset.filter)));
$('dock-all').addEventListener('click',()=>setFilter('all'));
$('dock-tasks').addEventListener('click',()=>setFilter('doing'));
$('dock-add').addEventListener('click',()=>{$('capture-input').scrollIntoView({behavior:'smooth',block:'center'});$('capture-input').focus({preventScroll:true});});
$('search-toggle').addEventListener('click',()=>{$('search-wrap').hidden=false;$('search-input').focus();});
$('search-clear').addEventListener('click',()=>{$('search-wrap').hidden=true;$('search-input').value='';state.search='';render();});
$('search-input').addEventListener('input',e=>{state.search=e.target.value;render();});
$('dialog-close').addEventListener('click',closeEditor);
$('dialog-save').addEventListener('click',saveEdit);
$('dialog-delete').addEventListener('click',()=>{const id=state.editing;closeEditor();removeItem(id);});
$('dialog-backdrop').addEventListener('click',e=>{if(e.target===$('dialog-backdrop'))closeEditor();});
$('ai-button').addEventListener('click',runAI);
$('account-btn').addEventListener('click',showAccount);
$('account-close').addEventListener('click',closeAccount);
$('account-backdrop').addEventListener('click',e=>{if(e.target===$('account-backdrop'))closeAccount();});
$('google-signin').addEventListener('click',()=>{if(state.user)logout();else window.location.assign('/api/auth/google');});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('dialog-backdrop').hidden)closeEditor();if(!$('account-backdrop').hidden)closeAccount();}});
initialize();
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost'||location.hostname==='127.0.0.1')){
  window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
}
