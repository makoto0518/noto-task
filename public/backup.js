/**
 * 【バックアップ用データの作成】app.js の「JSONバックアップ」ボタンから使われる。
 * 今端末に表示されているメモ・タスクをJSON（構造化したテキスト）にまとめる。
 * オフライン中の未同期編集も対象で、クラウドとの通信は不要。
 * safeItems() は logic.js にあり、壊れたデータを出力しないために利用する。
 * 注意：本文やアカウントIDは暗号化されない。また復元機能はまだ実装していない。
 */
import { safeItems } from './logic.js';

export const BACKUP_FORMAT = 'noto-backup';

export function buildBackup(items, { userId=null, pendingSyncCount=0, now=new Date() }={}) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    source: 'local-visible-items',
    accountId: typeof userId === 'string' ? userId : null,
    pendingSyncCount: Number.isSafeInteger(pendingSyncCount) && pendingSyncCount >= 0 ? pendingSyncCount : 0,
    items: safeItems(items),
  };
}

export function backupFilename(now=new Date()) {
  return `noto-backup-${now.toISOString().slice(0,10)}.json`;
}
