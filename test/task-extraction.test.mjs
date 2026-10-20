import test from 'node:test';
import assert from 'node:assert/strict';
import {groundedTaskSuggestions,TASK_MESSAGES,TASK_MODEL} from '../worker/task-extraction.js';
const note='明日は研究室でゼミの資料を確認する。帰りに牛乳と卵を買う。週末は部屋を掃除したい。';
test('grounded Japanese suggestions retain only exact excerpts',()=>{
 const response={response:JSON.stringify({tasks:[{quote:'ゼミの資料を確認する'},{quote:'牛乳と卵を買う'},{quote:'部屋を掃除したい'}]})};
 assert.deepEqual(groundedTaskSuggestions(response,note).map(x=>x.title),['ゼミの資料を確認する','牛乳と卵を買う','部屋を掃除したい']);
});
test('garbled and fabricated Japanese tasks are rejected',()=>{
 const response={response:'{"tasks":[{"quote":"更しだはディジアストを判です"},{"quote":"私のパールを返きだ"},{"quote":"ゼミの資料を確認する"}]}'};
 assert.deepEqual(groundedTaskSuggestions(response,note),[{title:'ゼミの資料を確認する'}]);
});
test('empty, short and duplicate suggestions filtered',()=>{
 assert.deepEqual(groundedTaskSuggestions({response:'{"tasks":[{"quote":"牛乳と卵を買う"},{"quote":"牛乳と卵を買う"},{"quote":"卵"}]}'},note),[{title:'牛乳と卵を買う'}]);
 assert.deepEqual(groundedTaskSuggestions({response:'not json'},note),[]);
});
test('model uses restricted task extraction prompt',()=>{
 assert.match(TASK_MODEL,/gemma/);
 assert.match(TASK_MESSAGES(note)[0].content,/一字一句/);
});

test('友達の報告: 複数行動を自然な独立タスクとして受け入れる',()=>{
 const text='自炊して散歩して風呂入る';
 const response={response:JSON.stringify({tasks:[
 {quote:'自炊して',title:'自炊する'},
 {quote:'散歩して',title:'散歩する'},
 {quote:'風呂入る',title:'お風呂に入る'}]})};
 assert.deepEqual(groundedTaskSuggestions(response,text).map(x=>x.title),['自炊する','散歩する','お風呂に入る']);
});
test('原文にない捏造された行動や根拠をそのまま受け付けない',()=>{
 const text='大学の課題と就活の面接対策を行う';
 const response={response:JSON.stringify({tasks:[
 {quote:'大学の課題',title:'大学の課題に取り組む'},
 {quote:'書類を提出',title:'書類を提出する'},
 {quote:'就活の面接対策',title:'面接対策をする'}]})};
 const titles=groundedTaskSuggestions(response,text).map(x=>x.title);
 assert.equal(titles.length,2);
 assert.ok(titles.includes('大学の課題に取り組む'));
 assert.ok(!titles.includes('書類を提出する'));
});
