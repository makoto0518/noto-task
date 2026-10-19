import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync, queueKey, cacheKey, compactQueue, mergeServerItems } from '../public/sync.js';

const newNote=(id,content='text')=>({id,kind:'note',content,status:'todo',dueDate:null,createdAt:'2026-10-18T11:00:00.000Z',updatedAt:'2026-10-18T11:00:00.000Z'});
const id1='a1111111-1111-4111-8111-111111111111';
const id2='b2222222-2222-4222-8222-222222222222';
const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),map};};
function server(){
 const db=new Map();let offline=false;const calls=[];
 return {
 db,calls,setOffline(value){offline=value},
 async request(path,opts={}){
   calls.push([path,opts.method||'GET']);
   if(offline)throw new Error('offline');
   if(path==='/items')return {items:[...db.values()].map(item=>({...item}))};
   const id=path.slice('/items/'.length);
   if(opts.method==='DELETE'){db.delete(id);return {ok:true};}
   if(opts.method==='PUT'){
     const item=JSON.parse(opts.body);db.set(id,{...item});return {item};
   }
   throw new Error(`Bad API ${path}`);
 }
 };
}
function client(backend,local=storage(),userId='google-user'){
 let view=[],status='';const cloud=new CloudSync({request:(...args)=>backend.request(...args),storage:local,guestKey:'guest',onData:items=>{view=items},onStatus:next=>{status=next}});
 return {cloud,local,get view(){return view},get status(){return status},activate:(guest=[])=>cloud.activate(userId,guest)};
}
test('queue compaction and remote overlay preserve pending mutations',()=>{
 const a=newNote(id1);
 assert.deepEqual(compactQueue([{id:id1,type:'delete'}],{type:'put',id:id1,item:a}),[{type:'put',id:id1,item:a}]);
 assert.deepEqual(mergeServerItems([a],[{type:'delete',id:id1}]),[]);
 assert.equal(mergeServerItems([],[{type:'put',id:id1,item:a}])[0].id,id1);
});
test('Android and PC see the same account additions and edits after refresh',async()=>{
 const backend=server();const mobile=client(backend),pc=client(backend);
 mobile.activate();pc.activate();
 const original=newNote(id1,'Androidからメモ');
 mobile.cloud.recordPut(original,[original]);await mobile.cloud.flush();await pc.cloud.refresh();
 assert.deepEqual(pc.view.map(x=>x.content),['Androidからメモ']);
 const changed={...pc.view[0],content:'PCで編集'};
 pc.cloud.recordPut(changed,[changed]);await pc.cloud.flush();await mobile.cloud.refresh();
 assert.equal(mobile.view[0].content,'PCで編集');
 mobile.cloud.stop();pc.cloud.stop();
});
test('offline writes survive reload and synchronize when connection returns',async()=>{
 const backend=server(),disk=storage(),first=client(backend,disk);
 first.activate();backend.setOffline(true);
 const note=newNote(id1,'電波なしでも保存');
 first.cloud.recordPut(note,[note]);await first.cloud.flush();
 assert.equal(first.cloud.queue.length,1);assert.equal(backend.db.size,0);
 assert.equal(JSON.parse(disk.getItem(queueKey('google-user'))).length,1);
 first.cloud.stop();
 const restarted=client(backend,disk);restarted.activate();
 assert.equal(restarted.view[0].content,'電波なしでも保存');
 backend.setOffline(false);await restarted.cloud.flush();
 assert.equal(restarted.cloud.queue.length,0);assert.equal(backend.db.get(id1).content,'電波なしでも保存');
 restarted.cloud.stop();
});
test('deleting offline queues deletion and prevents stale remote content returning',async()=>{
 const backend=server();backend.db.set(id1,newNote(id1));
 const mobile=client(backend);mobile.activate();await mobile.cloud.refresh();
 backend.setOffline(true);mobile.cloud.recordDelete(id1,[]);await mobile.cloud.flush();
 assert.deepEqual(mobile.view,[]);
 backend.setOffline(false);await mobile.cloud.flush();
 assert.equal(backend.db.has(id1),false);
 mobile.cloud.stop();
});
test('guest notes become durable account-scoped outbox before guest storage is cleared',async()=>{
 const backend=server(),disk=storage(),guest=newNote(id2,'ゲストメモ');
 disk.setItem('guest',JSON.stringify([guest]));
 const mobile=client(backend,disk);mobile.activate(JSON.parse(disk.getItem('guest')));
 assert.equal(disk.getItem('guest'),null);
 assert.equal(mobile.view.length,1);
 assert.equal(JSON.parse(disk.getItem(queueKey('google-user'))).length,1);
 await mobile.cloud.flush();assert.equal(backend.db.get(id2).content,'ゲストメモ');
 mobile.cloud.stop();
});
test('account cached data is isolated by Google subject',()=>{
 const backend=server(),disk=storage();
 const alpha=client(backend,disk,'alice'),beta=client(backend,disk,'bob');
 alpha.activate();alpha.cloud.recordPut(newNote(id1),[newNote(id1)]);
 beta.activate();assert.equal(beta.view.length,0);
 assert.notEqual(cacheKey('alice'),cacheKey('bob'));
 alpha.cloud.stop();beta.cloud.stop();
});
test('superseding a request in flight never drops the newest queued edit',async()=>{
 const disk=storage();const db=new Map();let firstResolve;let calls=0;
 const request=async(path,opts={})=>{
   if(path==='/items')return {items:[...db.values()]};
   if(opts.method==='PUT'){
     const value=JSON.parse(opts.body);calls++;
     if(calls===1)await new Promise(resolve=>firstResolve=resolve);
     db.set(value.id,value);return {item:value};
   }
 };
 let view=[];const sync=new CloudSync({request,storage:disk,guestKey:'guest',onData:v=>view=v,onStatus:()=>{}});
 sync.activate('alice');
 const early=newNote(id1,'before'),latest=newNote(id1,'after');
 sync.recordPut(early,[early]);const pending=sync.flush();
 while(!firstResolve)await new Promise(resolve=>setTimeout(resolve,1));
 sync.recordPut(latest,[latest]);firstResolve();await pending;
 assert.equal(sync.queue.length,0);
 assert.equal(db.get(id1).content,'after');assert.equal(view[0].content,'after');
 sync.stop();
});
test('stale cloud responses do not overwrite local edits that arrived during refresh',async()=>{
 const disk=storage(),initial=newNote(id1,'remote old');let unlock;
 const request=async(path,opts={})=>{
   if(path==='/items'){await new Promise(resolve=>unlock=resolve);return {items:[initial]};}
   return {ok:true};
 };
 let view=[];const sync=new CloudSync({request,storage:disk,guestKey:'guest',onData:v=>view=v,onStatus:()=>{}});
 sync.activate('alice');const inflight=sync.refresh();
 while(!unlock)await new Promise(resolve=>setTimeout(resolve,1));
 const edited=newNote(id1,'local new');sync.recordPut(edited,[edited]);
 unlock();await inflight;
 assert.equal(view[0].content,'local new');assert.equal(sync.queue.length,1);
 sync.stop();
});
