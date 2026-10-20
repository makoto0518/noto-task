/**
 * Offline-first shell, not an offline database: API requests are NEVER cached.
 * This separation avoids accidentally replaying stale Google/session data.
 * Bump CACHE whenever changing essential static assets.
 */
const CACHE='noto-static-v11';
const SHELL=['/','/index.html','/style.css','/app.js','/logic.js','/backup.js','/sync.js','/quota.js','/theme.js','/icon.svg','/manifest.webmanifest'];
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
