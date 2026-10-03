import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const uidSchema = z.number().int().min(1).max(4294967295);
export const rangesSchema = z.array(z.tuple([uidSchema, uidSchema])).superRefine((ranges, ctx) => {
  let last = 0;
  for (const [a, b] of ranges) {
    if (a > b || a <= last) ctx.addIssue({ code: 'custom', message: 'Invalid UID ranges' });
    last = b;
  }
});
export type Ranges = z.infer<typeof rangesSchema>;

export function compact(uids: number[]): Ranges {
  const ranges: Ranges = [];
  for (const uid of [...new Set(uids)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === uid) last[1] = uid;
    else ranges.push([uid, uid]);
  }
  return ranges;
}

export function mergeRanges(a: Ranges, b: Ranges): Ranges {
  const result: Ranges = [];
  for (const [start, end] of [...a, ...b].sort((x, y) => x[0] - y[0])) {
    const last = result.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

export function removeUids(ranges: Ranges, uids: number[]): Ranges {
  const removed = [...new Set(uids)].sort((a, b) => a - b);
  const result: Ranges = [];
  let index = 0;
  for (const [start, end] of ranges) {
    let next = start;
    while (index < removed.length && removed[index] < start) index++;
    while (index < removed.length && removed[index] <= end) {
      const uid = removed[index++];
      if (next < uid) result.push([next, uid - 1]);
      next = uid + 1;
    }
    if (next <= end) result.push([next, end]);
  }
  return result;
}

export function pageUids(ranges: Ranges, afterUid: number, limit: number): number[] {
  const result: number[] = [];
  for (const [a, b] of ranges) {
    for (let uid = Math.max(a, afterUid + 1); uid <= b && result.length < limit; uid++) result.push(uid);
    if (result.length === limit) break;
  }
  return result;
}

export const folderSchema = z.object({
  fingerprint: z.string(), uidValidity: z.string().regex(/^[1-9]\d*$/),
  nextUid: z.number().int().min(1).max(4294967296), pending: rangesSchema,
  lastSuccess: z.string(), lastResult: z.enum(['baseline', 'unchanged', 'new', 'reset', 'catching_up']),
}).strict();
export type FolderState = z.infer<typeof folderSchema>;
export interface Subscription {
  id: string; owner: string; accountId: string; folder: string; fingerprint: string;
  url: string; secret: string; previousSecret?: string; rotateUntil?: number; expires: number;
}
export interface MailEvent {
  eventId: string; name: 'email.arrived'; timestamp: string;
  data: { accountId: string; folder: string; uidValidity: string; uidRanges: Ranges; reason: 'arrival' | 'reset' };
  cursor: null;
}

// SQLite supplies crash recovery and cross-process transactions without a service,
// database package, or a lock file that could survive a container crash.
export class MonitorStore {
  readonly db: DatabaseSync;
  private readonly key: Buffer;
  constructor(directory: string) {
    const key = readFileSync(path.join(directory, '.key'), 'utf8');
    if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Invalid monitoring encryption key.');
    this.key = Buffer.from(key, 'hex');
    const filename = path.join(directory, 'monitor.sqlite');
    if (!existsSync(filename)) {
      try { writeFileSync(filename, '', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported monitoring database version.'); }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS folders(account TEXT, folder TEXT, state TEXT NOT NULL, error TEXT,
        PRIMARY KEY(account, folder));
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, owner TEXT, account TEXT, folder TEXT,
        expires INTEGER, sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, subscription TEXT, event TEXT NOT NULL,
        attempts INTEGER DEFAULT 0, due INTEGER DEFAULT 0, lease INTEGER DEFAULT 0, failed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS failures(account TEXT, folder TEXT, lastAttempt TEXT, PRIMARY KEY(account,folder));
      PRAGMA user_version=1;`);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(account: string, folder: string): FolderState | undefined {
    const row = this.db.prepare('SELECT state FROM folders WHERE account=? AND folder=?').get(account, folder);
    return row ? folderSchema.parse(JSON.parse(row.state as string)) : undefined;
  }
  put(account: string, folder: string, state: FolderState, pollSuccess = true) {
    this.db.prepare(`INSERT INTO folders(account,folder,state) VALUES(?,?,?)
      ON CONFLICT(account,folder) DO UPDATE SET state=excluded.state,
      error=CASE WHEN ? THEN NULL ELSE folders.error END`).run(account, folder, JSON.stringify(folderSchema.parse(state)), pollSuccess ? 1 : 0);
    if (pollSuccess) this.db.prepare('DELETE FROM failures WHERE account=? AND folder=?').run(account, folder);
  }
  error(account: string, folder: string) {
    this.db.prepare('UPDATE folders SET error=? WHERE account=? AND folder=?').run('poll_failed', account, folder);
    this.db.prepare(`INSERT INTO failures VALUES(?,?,?) ON CONFLICT(account,folder)
      DO UPDATE SET lastAttempt=excluded.lastAttempt`).run(account, folder, new Date().toISOString());
  }
  summary(account: string, folder: string) {
    const state = this.get(account, folder);
    const row = this.db.prepare('SELECT error FROM folders WHERE account=? AND folder=?').get(account, folder);
    const failure = this.db.prepare('SELECT lastAttempt FROM failures WHERE account=? AND folder=?').get(account, folder);
    const delivery = this.db.prepare(`SELECT count(*) AS queued,sum(failed) AS failed FROM outbox
      WHERE subscription IN (SELECT id FROM subscriptions WHERE account=? AND folder=?)`).get(account, folder)!;
    const status = { lastError: failure || row?.error ? 'poll_failed' : null, lastFailedAttempt: failure?.lastAttempt ?? null,
      delivery: { queued: Number(delivery.queued), failed: Number(delivery.failed ?? 0) } };
    return state ? { ...state, fingerprint: undefined, ...status,
      pendingCount: state.pending.reduce((n, [a, b]) => n + b - a + 1, 0) } : null;
  }
  initialStatus(account: string, folder: string) {
    const failure = this.db.prepare('SELECT lastAttempt FROM failures WHERE account=? AND folder=?').get(account, folder);
    return { lastError: failure ? 'poll_failed' : null, lastFailedAttempt: failure?.lastAttempt ?? null };
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
  }
  private unseal(value: string): Subscription {
    const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  }
  subscription(id: string): Subscription | undefined {
    const row = this.db.prepare('SELECT sealed FROM subscriptions WHERE id=?').get(id);
    return row ? this.unseal(row.sealed as string) : undefined;
  }
  saveSubscription(sub: Subscription) {
    this.db.prepare(`INSERT INTO subscriptions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      expires=excluded.expires,sealed=excluded.sealed`).run(sub.id, sub.owner, sub.accountId, sub.folder, sub.expires, this.seal(sub));
  }
  removeSubscription(id: string) {
    this.db.prepare('DELETE FROM subscriptions WHERE id=?').run(id);
    this.db.prepare('DELETE FROM outbox WHERE subscription=?').run(id);
  }
  enqueue(event: MailEvent) {
    const ids = this.db.prepare(
      'SELECT id FROM subscriptions WHERE account=? AND folder=? AND expires>?').all(event.data.accountId, event.data.folder, Date.now());
    for (const sub of ids) this.db.prepare('INSERT OR IGNORE INTO outbox(id,subscription,event) VALUES(?,?,?)')
      .run(`${event.eventId}:${sub.id}`, sub.id as string, JSON.stringify(event));
  }
  lease(id: string, owner: string, milliseconds: number): boolean {
    const now = Date.now();
    return Number(this.db.prepare(`INSERT INTO leases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET
      expires=excluded.expires,owner=excluded.owner WHERE leases.expires<=?`).run(id, now + milliseconds, owner, now).changes) > 0;
  }
  release(id: string, owner: string) {
    this.db.prepare('DELETE FROM leases WHERE id=? AND owner=?').run(id, owner);
  }
  close() { this.db.close(); }
}
