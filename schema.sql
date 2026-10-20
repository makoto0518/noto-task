-- Cloudflare D1はSQLite互換。itemsのuser_idはGoogleログインで得たユーザーIDを保存する。
-- worker/index.jsのSELECT/UPDATE/DELETEは必ずuser_idで絞り、他人のデータを混ぜない。
-- Googleセッションの生トークンは保存せず、SHA-256ハッシュだけをsessionsテーブルに保存する。
-- IF NOT EXISTSにより既存のテーブルを消さずに再実行可能。既存データの削除操作は書かない。
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS items (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'task')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  due_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
-- user_id別に作成日時の新しい順で一覧を取得するSQLを高速化するための複合インデックス。
CREATE INDEX IF NOT EXISTS items_user_created ON items(user_id, created_at DESC);
-- AIボタンの回数はユーザーIDとUTC日付ごとに数える（worker/index.jsのhandleAIと連携）。
-- 注意：20回/人はアプリ側の制限。CloudflareのNeurons無料枠は友達を含めアカウント全体で共有する。
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, day)
);

-- 【全削除の世代管理】別端末の古い未同期記録が削除後に復活するのを防ぐ。
-- worker/index.jsのaccountEpoch()と連携する。clear_tokenは並行する削除を区別する。
CREATE TABLE IF NOT EXISTS account_epochs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  clear_token TEXT
);
