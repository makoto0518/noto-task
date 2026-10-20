import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudSync} from '../public/sync.js';

const id='a1111111-1111-4111-8111-111111111111';
const stamp='2026-10-19T11:00:00.000Z';
const note=(content)=>({id,kind:'note',content,status:'todo',dueDate:null,createdAt:stamp,updatedAt:stamp});
const memory=()=>{const db=new Map();return {getItem:k=>db.get(k)||null,setItem:(k,v)=>db.set(k,v),removeItem:k=>db.delete(k)};};
function backend(){
 const db=new Map();let offline=false;let version=0;
 const conflict=()=>{const e=new Error('競合');e.status=409;e.current=db.get(id)||null;throw e;};
 return {db,setOffline:v=>offline=v,async request(path,opts={}){
  if(offline)throw new Error('offline');
  if(path==='/items')return {items:[...db.values()]};
  const key=path.split('/').pop(),before=db.get(key);
  if(opts.method==='DELETE'){if(!before)return {ok:true};if(before.updatedAt!==opts.headers['If-Match'])return conflict();db.delete(key);return {ok:true};}
  if(opts.method==='PUT'){
    const {expectedUpdatedAt,...incoming}=JSON.parse(opts.body);
    if(before?before.updatedAt!==expectedUpdatedAt:expectedUpdatedAt!==null)return conflict();
    const saved={...incoming,updatedAt:'2026-10-20T11:00:00.'+String(++version).padStart(3,'0')+'Z'};
    db.set(key,saved);return {item:saved};
  }
  throw Error('bad route');
 }};
}
function client(server){
 let visible=[],warnings=[];
 const sync=new CloudSync({request:(...x)=>server.request(...x),storage:memory(),guestKey:'guest',onData:x=>visible=x,onStatus:()=>{},onConflict:x=>warnings.push(x)});
 sync.activate('alice');
 return {sync,get visible(){return visible},get warnings(){return warnings}};
}
test('same-item Android offline and Windows online edits keep both versions',async()=>{
 const server=backend(),pc=client(server),phone=client(server);
 const initial=note('競合テスト001');
 pc.sync.recordPut(initial,[initial]);await pc.sync.flush();await phone.sync.refresh();
 const phoneEdit={...phone.visible[0],content:'Androidで編集'};
 server.setOffline(true);phone.sync.recordPut(phoneEdit,[phoneEdit]);await phone.sync.flush();
 server.setOffline(false);
 const pcEdit={...pc.visible[0],content:'Windowsで編集'};
 pc.sync.recordPut(pcEdit,[pcEdit]);await pc.sync.flush();
 await phone.sync.flush();await pc.sync.refresh();
 const contents=[...server.db.values()].map(i=>i.content);
 assert.ok(contents.includes('Windowsで編集'));
 assert.ok(contents.includes('【競合コピー】 Androidで編集'));
 assert.equal(phone.sync.queue.length,0);
 assert.equal(phone.warnings.length,1);
 pc.sync.stop();phone.sync.stop();
});
test('offline new notes and same-device consecutive edits still sync',async()=>{
 const server=backend(),device=client(server);server.setOffline(true);
 const original=note('オフライン作成');device.sync.recordPut(original,[original]);await device.sync.flush();
 server.setOffline(false);await device.sync.flush();
 const next={...device.visible[0],content:'1回目の編集'};
 device.sync.recordPut(next,[next]);await device.sync.flush();
 const last={...device.visible[0],content:'2回目の編集'};
 device.sync.recordPut(last,[last]);await device.sync.flush();
 assert.equal(server.db.get(id).content,'2回目の編集');
 assert.equal(device.warnings.length,0);
 device.sync.stop();
});
test('a stale deletion does not remove a newer remote edit',async()=>{
 const server=backend(),a=client(server),b=client(server);
 const initial=note('元メモ');a.sync.recordPut(initial,[initial]);await a.sync.flush();await b.sync.refresh();
 const changed={...a.visible[0],content:'新しい編集'};a.sync.recordPut(changed,[changed]);await a.sync.flush();
 b.sync.recordDelete(id,[]);await b.sync.flush();
 assert.equal(server.db.get(id).content,'新しい編集');
 assert.equal(b.visible[0].content,'新しい編集');
 assert.equal(b.warnings.length,1);
 a.sync.stop();b.sync.stop();
});
