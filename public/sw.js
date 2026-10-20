/**
 * 【Service Worker：オフライン起動の仕組み】ブラウザとは別に動くWeb標準の処理。
 * index.html・style.css・app.js などをキャッシュし、通信がなくても画面を開ける。
 * メモ・タスクの保存は sync.js（端末）と worker/index.js + D1（クラウド）が担当。
 * /api/ の応答は絶対にキャッシュしない。別アカウントのデータや古い認証情報を
 * 端末に誤って再表示しないため。静的ファイルを更新したらCACHEの版も変更する。
 */
const CACHE='noto-static-v13';
const SHELL=['/','/index.html','/style.css','/app.js','/logic.js','/backup.js','/restore.js','/sync.js','/quota.js','/theme.js','/icon.svg','/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const url=new URL(request.url);if(url.origin!==location.origin||url.pathname.startsWith('/api/'))return;
  event.respondWith(fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}
    return response;
  }).catch(async()=>await caches.match(request)||(request.mode==='navigate'?await caches.match('/index.html'):Response.error())));
});
