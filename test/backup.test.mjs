import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBackup,backupFilename} from '../public/backup.js';
const item={id:'a1111111-1111-4111-8111-111111111111',kind:'note',content:'非同期のメモ',status:'todo',dueDate:null,createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z'};
test('exports offline notes without network access and counts pending writes',()=>{
 const result=buildBackup([item],{userId:'user-a',pendingSyncCount:2,now:new Date('2026-10-20T03:00:00Z')});
 assert.equal(result.format,'noto-backup');
 assert.equal(result.pendingSyncCount,2);
 assert.equal(result.items[0].content,'非同期のメモ');
 assert.equal(result.accountId,'user-a');
 assert.equal(backupFilename(new Date('2026-10-20T03:00:00Z')),'noto-backup-2026-10-20.json');
});
test('malformed items are not exported; backups do not include cookies or secrets',()=>{
 const json=JSON.stringify(buildBackup([item,{id:'bad',content:'bad'}]));
 assert.equal(JSON.parse(json).items.length,1);
 assert.ok(!json.includes('mizu_session'));
 assert.ok(!json.includes('CF_ANALYTICS_TOKEN'));
});
