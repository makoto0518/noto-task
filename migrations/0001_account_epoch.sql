-- 全削除のたびにユーザーの世代を進め、古いオフライン端末からの再登録を拒否する。
-- このSQLは一度だけ本番D1へ適用。CREATE TABLE IF NOT EXISTSで既存データは削除しない。
CREATE TABLE IF NOT EXISTS account_epochs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  clear_token TEXT
);
INSERT OR IGNORE INTO account_epochs(user_id,epoch) SELECT id,0 FROM users;
