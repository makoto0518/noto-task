import test from 'node:test';
import assert from 'node:assert/strict';
import {createItem,clampStatus,nextStatus,getCounts,getVisibleItems,safeItems} from '../public/logic.js';
import worker,{__test} from '../worker/index.js';

test('new items are trimmed, typed and use unique UUIDs',()=>{
  const n=createItem(' hello ','note'), t=createItem(' do it ','task');
  assert.equal(n.content,'hello');assert.equal(t.kind,'task');assert.equal(n.status,'todo');assert.notEqual(n.id,t.id);
});
test('swipes clamp at both ends and progress/revert correctly',()=>{
  assert.equal(nextStatus('todo',1),'doing');assert.equal(nextStatus('doing',1),'done');assert.equal(nextStatus('done',1),'done');
  assert.equal(nextStatus('done',-1),'doing');assert.equal(nextStatus('doing',-1),'todo');assert.equal(nextStatus('todo',-1),'todo');
  assert.equal(clampStatus('hacked'),'todo');
});
test('counts separate notes from task completion',()=>{
  const items=[{kind:'note'},{kind:'task',status:'todo'},{kind:'task',status:'doing'},{kind:'task',status:'done'}];
  assert.deepEqual(getCounts(items),{all:4,note:1,todo:1,doing:1,done:1});
});
test('filters search Japanese text and maintain correct type',()=>{
  const items=[{id:'a',kind:'note',content:'散歩 メモ'}, {id:'b',kind:'task',status:'doing',content:'研究をする'},{id:'c',kind:'task',status:'done',content:'散歩'}];
  assert.deepEqual(getVisibleItems(items,'note').map(x=>x.id),['a']);
  assert.deepEqual(getVisibleItems(items,'doing').map(x=>x.id),['b']);
  assert.deepEqual(getVisibleItems(items,'all','散歩').map(x=>x.id),['a','c']);
});
test('corrupted local payload gets removed and note statuses normalized',()=>{
  const output=safeItems([null,{id:'bad',kind:'note',content:'a'},{id:'safe-id-12345',kind:'note',content:'メモ',status:'invalid',dueDate:'nonsense'}]);
  assert.equal(output.length,1);assert.equal(output[0].status,'todo');assert.equal(output[0].dueDate,null);
});
test('server rejects malicious origins before reading auth',async()=>{
  const req=new Request('https://mizu.example/api/items',{method:'POST',headers:{Origin:'https://evil.example'}});
  const response=await worker.fetch(req,{DB:{}});assert.equal(response.status,403);
});
test('server requires auth for CRUD operations',async()=>{
  const db={prepare:()=>({bind:()=>({first:async()=>null})})};
  const response=await worker.fetch(new Request('https://mizu.example/api/items'),{DB:db});assert.equal(response.status,401);
});
test('server handles missing database without silently exposing data',async()=>{
  const response=await worker.fetch(new Request('https://mizu.example/api/items'),{});assert.equal(response.status,503);
});
test('worker validates user-controlled data and enforces correct kind and size',()=>{
  const valid={id:'00000000-0000-4000-8000-000000000000',kind:'task',content:'  散歩  ',status:'done',dueDate:'2026-10-19'};
  assert.equal(__test.normalizeItem(valid).content,'散歩');
  assert.equal(__test.normalizeItem({...valid,kind:'admin'}),null);
  assert.equal(__test.normalizeItem({...valid,content:'x'.repeat(4001)}),null);
  assert.equal(__test.normalizeItem({...valid,dueDate:'bad'}),null);
  assert.equal(__test.normalizeItem({...valid,kind:'note'}).dueDate,null);
});
test('OAuth initiation requires credentials',async()=>{
  const response=await worker.fetch(new Request('https://mizu.example/api/auth/google'),{DB:{}});
  assert.equal(response.status,503);
});
test('OAuth initiation sets state and PKCE HttpOnly Secure cookies',async()=>{
  const response=await worker.fetch(new Request('https://mizu.example/api/auth/google'),{DB:{},GOOGLE_CLIENT_ID:'fake.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fake'});
  assert.equal(response.status,302);assert.match(response.headers.get('location'),/code_challenge_method=S256/);
  const cookies=response.headers.get('set-cookie');assert.match(cookies,/HttpOnly/);assert.match(cookies,/Secure/);assert.match(cookies,/SameSite=Lax/);
});
