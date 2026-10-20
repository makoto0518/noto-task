import test from 'node:test';
import assert from 'node:assert/strict';
import {previewBackup,makeRestoreItems} from '../public/restore.js';
import {buildBackup} from '../public/backup.js';
import {CloudSync,epochKey,queueKey} from '../public/sync.js';
const note=(txt,id='a1111111-1111-4111-8111-111111111111')=>({id,kind:'note',content:txt,status:'todo',dueDate:null,createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z'});
const memory=()=>{const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}};
test('復元はバックアップ形式を検査し、既存データを上書きせず新しいIDを割り当てる',()=>{
 const json=JSON.stringify(buildBackup([note('原文'),note('追加分','b2222222-2222-4222-8222-222222222222')],{userId:'alice'}));
 const data=previewBackup(json,{accountId:'alice'});
 const restored=makeRestoreItems(data.items,[note('原文')],new Date('2026-10-20T09:00:00Z'));
 assert.equal(restored.length,1);assert.equal(restored[0].content,'追加分');
 assert.notEqual(restored[0].id,data.items[1].id);
 assert.equal(restored[0].createdAt,'2026-10-20T09:00:00.000Z');
});
test('別アカウント・壊れたJSON・容量過大は復元拒否',()=>{
 const backup=buildBackup([note('個人メモ')],{userId:'alice'});
 assert.throws(()=>previewBackup(JSON.stringify(backup),{accountId:'bob'}),/異なるGoogle/);
 assert.throws(()=>previewBackup('{broken'),/JSON/);
 assert.throws(()=>previewBackup('x'.repeat(2_000_001)),/大きすぎ/);
 assert.throws(()=>previewBackup(JSON.stringify({...backup,items:[{id:'invalid'}]})),/不正な記録/);
});
test('全削除世代を受け取ったオフライン端末は古いキューを破棄する',async()=>{
 const disk=memory();let remoteEpoch=0;let remote=[note('古いメモ')];let writes=0;
 const request=async(path,opts={})=>{
  if(path==='/items')return {items:remote,epoch:remoteEpoch};
  if(opts.method==='PUT'){writes++;return{item:JSON.parse(opts.body)}}
 };
 let view=[];const cloud=new CloudSync({request,storage:disk,guestKey:'guest',onData:x=>view=x,onStatus:()=>{}});
 cloud.activate('alice');
 await cloud.refresh();
 cloud.recordPut(note('オフラインで編集'),[note('オフラインで編集')]);
 assert.equal(cloud.queue.length,1);
 remoteEpoch=1;remote=[];
 await cloud.refresh();
 assert.equal(cloud.queue.length,0);assert.deepEqual(view,[]);
 assert.equal(disk.getItem(epochKey('alice')),'1');
 assert.deepEqual(JSON.parse(disk.getItem(queueKey('alice'))),[]);
 await cloud.flush();assert.equal(writes,0);
 cloud.stop();
});
