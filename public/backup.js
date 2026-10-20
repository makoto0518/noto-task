/**
 * JSON export of the current visible notebook snapshot.
 * It includes optimistic offline edits; no network request is necessary.
 * A download is not an automatic restoration or encrypted backup.
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
