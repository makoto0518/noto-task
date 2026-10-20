// D1互換のSQLite文法をローカルで確認する。Cloudflare本番D1への接続テストと混同しない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const ddl=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
function db(){const database=new DatabaseSync(':memory:');database.exec('PRAGMA foreign_keys=ON');database.exec(ddl);return database;}
const id='a1111111-1111-4111-8111-111111111111';
const putSQL='INSERT INTO items(id,user_id,kind,content,status,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET content=excluded.content,status=excluded.status,due_date=excluded.due_date,updated_at=excluded.updated_at WHERE items.kind=excluded.kind';
test('D1 SQLite schema supports PUT upsert, status updates and idempotent delete',()=>{
 const d=db();d.prepare('INSERT INTO users(id,email) VALUES (?,?)').run('alice','a@example.com');
 const save=d.prepare(putSQL);
 save.run(id,'alice','task','研究','todo',null,'2026-10-18T10:00:00Z','2026-10-18T10:00:00Z');
 save.run(id,'alice','task','研究を進める','doing',null,'2026-10-18T12:00:00Z','2026-10-18T12:00:00Z');
 const row=d.prepare('SELECT content,status,created_at FROM items WHERE user_id=? AND id=?').get('alice',id);
 assert.equal(row.content,'研究を進める');assert.equal(row.status,'doing');
 assert.equal(row.created_at,'2026-10-18T10:00:00Z');
 const del=d.prepare('DELETE FROM items WHERE user_id=? AND id=?');del.run('alice',id);del.run('alice',id);
 assert.equal(d.prepare('SELECT count(*) AS n FROM items').get().n,0);
 d.close();
});
test('two Google account IDs never overwrite each other, even with same item ID',()=>{
 const d=db();const user=d.prepare('INSERT INTO users(id,email) VALUES (?,?)');
 user.run('alice','a@example.com');user.run('bob','b@example.com');
 const put=d.prepare(putSQL);put.run(id,'alice','note','秘密A','todo',null,'2026-10-18T10:00:00Z','2026-10-18T10:00:00Z');
 put.run(id,'bob','note','秘密B','todo',null,'2026-10-18T10:00:00Z','2026-10-18T10:00:00Z');
 assert.equal(d.prepare('SELECT content FROM items WHERE user_id=? AND id=?').get('alice',id).content,'秘密A');
 assert.equal(d.prepare('SELECT content FROM items WHERE user_id=? AND id=?').get('bob',id).content,'秘密B');
 d.close();
});

test('全削除の世代更新は本人だけに作用し、古い書き込み条件では復活しない',()=>{
 const d=db();const migration=readFileSync(new URL('../migrations/0001_account_epoch.sql',import.meta.url),'utf8');
 d.prepare('INSERT INTO users(id,email) VALUES(?,?)').run('alice','a@example.com');
 d.prepare('INSERT INTO users(id,email) VALUES(?,?)').run('bob','b@example.com');
 d.exec(migration);
 const before=d.prepare('SELECT epoch FROM account_epochs WHERE user_id=?').get('alice');
 assert.equal(before.epoch,0);
 const put=d.prepare("INSERT INTO items(id,user_id,kind,content,status,due_date,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_epochs WHERE user_id=? AND epoch=?) ON CONFLICT(user_id,id) DO NOTHING");
 assert.equal(put.run(id,'alice','note','昔の記録','todo',null,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','alice',0).changes,1);
 const other='b2222222-2222-4222-8222-222222222222';
 assert.equal(put.run(other,'bob','note','友達の記録','todo',null,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','bob',0).changes,1);
 d.prepare('UPDATE account_epochs SET epoch=epoch+1,clear_token=? WHERE user_id=? AND epoch=?').run('nonce','alice',0);
 d.prepare('DELETE FROM items WHERE user_id=? AND EXISTS (SELECT 1 FROM account_epochs WHERE user_id=? AND epoch=? AND clear_token=?)').run('alice','alice',1,'nonce');
 assert.equal(d.prepare('SELECT count(*) AS n FROM items WHERE user_id=?').get('alice').n,0);
 assert.equal(d.prepare('SELECT count(*) AS n FROM items WHERE user_id=?').get('bob').n,1);
 assert.equal(put.run(id,'alice','note','復活させない','todo',null,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','alice',0).changes,0);
 assert.equal(put.run(id,'alice','note','復元として追加','todo',null,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','alice',1).changes,1);
 d.close();
});
