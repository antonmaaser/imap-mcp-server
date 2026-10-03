import { createHash, randomUUID } from 'node:crypto';
import type { AccountManager } from '../services/account-manager.js';
import type { ImapAccount } from '../types/index.js';
import type { MonitorConfig } from './config.js';
import { ImapMonitorSource, type MailSource } from './imap-source.js';
import { MonitorStore, compact, mergeRanges, pageUids, removeUids, type MailEvent } from './state.js';

export function accountFingerprint(account: ImapAccount) {
  return createHash('sha256').update(JSON.stringify([account.host, account.port, account.user, account.tls, account.allowStartTLS])).digest('hex');
}

export class MailMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private deliver?: () => Promise<void>;
  private wakeRequested = false;
  private nextPoll = 0;
  private stopped = false;
  private due = new Map<string, number>();
  private readonly owner = randomUUID();
  readonly source: MailSource;
  constructor(readonly store: MonitorStore, readonly accounts: AccountManager, readonly config: MonitorConfig, source?: MailSource) {
    this.source = source ?? new ImapMonitorSource();
  }
  targets() {
    const accounts = this.accounts.getAllAccounts();
    return accounts.flatMap(account => {
      if (!this.config.rules) return [{ account, folders: ['INBOX'], intervalSeconds: this.config.intervalSeconds }];
      const rule = this.config.rules.find(r => r.account === account.id || r.account === account.name);
      return rule ? [{ account, folders: [...new Set(rule.folders)], intervalSeconds: rule.intervalSeconds ?? this.config.intervalSeconds }] : [];
    });
  }
  target(accountId: string, folder: string) {
    const account = this.accounts.getAccount(accountId);
    const rule = account && this.config.rules?.find(r => r.account === account.id || r.account === account.name);
    const folders = this.config.rules ? rule?.folders : ['INBOX'];
    if (!account || !folders?.includes(folder)) throw new Error('Account/folder is not configured for monitoring.');
    return account;
  }
  makeEvent(accountId: string, folder: string, uidValidity: string, uidRanges: MailEvent['data']['uidRanges'], reason: MailEvent['data']['reason']): MailEvent {
    return { eventId: `evt_${randomUUID()}`, name: 'email.arrived', timestamp: new Date().toISOString(),
      data: { accountId, folder, uidValidity, uidRanges, reason }, cursor: null };
  }
  async pollOnce(force = false) {
    if (!force && this.nextPoll > Date.now()) return;
    const targets = this.targets();
    const keys = new Set<string>();
    for (const { account, folders, intervalSeconds } of targets) {
      if (this.stopped) break;
      const fingerprint = accountFingerprint(account);
      for (const folder of folders) {
        if (this.stopped) break;
        const key = JSON.stringify([account.id, folder]);
        keys.add(key);
        if (!force && (this.due.get(key) ?? 0) > Date.now()) continue;
        this.due.set(key, Date.now() + intervalSeconds * 1000);
        if (!this.store.lease(key, this.owner, 60000)) continue;
        try {
          // Backpressure retains the cursor, rather than dropping notifications.
          const outbox = this.store.db.prepare('SELECT count(*) AS n FROM outbox').get()!;
          if (Number(outbox.n) >= 10000) continue;
          const stored = this.store.get(account.id, folder);
          const previous = stored?.fingerprint === fingerprint ? stored : undefined;
          const result = await this.source.scan(account, folder, previous, this.config.initial);
          // An account edited/removed during the network request must not advance
          // the old mailbox's state or enqueue deliveries under its new identity.
          if (accountFingerprint(this.target(account.id, folder)) !== fingerprint) continue;
          this.store.transaction(() => {
            const current = this.store.get(account.id, folder);
            const pending = current?.fingerprint === fingerprint && current.uidValidity === result.uidValidity ? current.pending : [];
            const added = compact(result.uids);
            const reset = result.reset || (!!stored && stored.fingerprint !== fingerprint);
            this.store.put(account.id, folder, { fingerprint, uidValidity: result.uidValidity, nextUid: result.nextUid,
              pending: mergeRanges(pending, added), lastSuccess: new Date().toISOString(),
              lastResult: result.baseline ? 'baseline' : reset ? 'reset' : !result.caughtUp ? 'catching_up' : added.length ? 'new' : 'unchanged' });
            if (added.length) this.store.enqueue(this.makeEvent(account.id, folder, result.uidValidity, added, reset ? 'reset' : 'arrival'));
          });
        } catch {
          this.store.error(account.id, folder);
          // Provider exceptions may contain credentials or mail contents.
          console.error(`[imap-mcp] Poll failed for account ${account.id}. State was not advanced.`);
        } finally { this.store.release(key, this.owner); }
      }
    }
    for (const key of this.due.keys()) if (!keys.has(key)) this.due.delete(key);
    this.nextPoll = Math.min(Date.now() + this.config.intervalSeconds * 1000, ...this.due.values());
  }
  pending(accountId: string, folder: string, afterUid = 0, limit = 100) {
    const account = this.target(accountId, folder);
    const state = this.store.get(accountId, folder);
    if (!state || state.fingerprint !== accountFingerprint(account)) return { accountId, folder, initialized: false, uids: [], ...this.store.initialStatus(accountId, folder) };
    const uids = pageUids(state.pending, afterUid, limit + 1);
    const more = uids.length > limit;
    if (more) uids.pop();
    return { accountId, folder, initialized: true, uidValidity: state.uidValidity, uids,
      nextAfterUid: more ? uids.at(-1) : null, ...this.store.summary(accountId, folder) };
  }
  async read(accountId: string, folder: string, uidValidity: string, uid: number, maxLength: number) {
    const account = this.target(accountId, folder);
    const state = this.store.get(accountId, folder);
    if (!state || state.fingerprint !== accountFingerprint(account) || state.uidValidity !== uidValidity ||
      !state.pending.some(([a, b]) => uid >= a && uid <= b)) throw new Error('Email is not pending in this mailbox generation.');
    return this.source.read(account, folder, uidValidity, uid, maxLength);
  }
  acknowledge(accountId: string, folder: string, uidValidity: string, uids: number[]) {
    const account = this.target(accountId, folder);
    return this.store.transaction(() => {
      const state = this.store.get(accountId, folder);
      if (!state || state.fingerprint !== accountFingerprint(account) || state.uidValidity !== uidValidity) {
        throw new Error('Mailbox generation changed. Obtain the current pending identifiers.');
      }
      state.pending = removeUids(state.pending, uids);
      this.store.put(accountId, folder, state, false);
      return { accountId, folder, uidValidity, acknowledgedUids: [...new Set(uids)] };
    });
  }
  start(deliver: () => Promise<void>) {
    if (this.deliver) throw new Error('Monitoring already started.');
    this.deliver = deliver;
    this.wake();
  }
  wake() {
    if (this.stopped || !this.deliver) return;
    if (this.running) { this.wakeRequested = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 0);
  }
  private async tick() {
    this.running = (async () => { await this.pollOnce(); await this.deliver!(); })();
    try { await this.running; }
    catch { console.error('[imap-mcp] Monitoring cycle failed.'); }
    finally {
      this.running = undefined;
      if (!this.stopped) {
        // Quiet accounts sleep until their next check. New subscriptions can
        // wake this timer immediately; retries wake at the next delivery due.
        let next = this.nextPoll || Date.now() + this.config.intervalSeconds * 1000;
        try {
          const delivery = this.store.db.prepare('SELECT min(due) AS due FROM outbox WHERE failed=0').get();
          const expiration = this.store.db.prepare('SELECT min(expires) AS expires FROM subscriptions').get();
          if (delivery?.due != null) next = Math.min(next, Number(delivery.due));
          if (expiration?.expires != null) next = Math.min(next, Number(expiration.expires));
        } catch { next = Date.now() + this.config.intervalSeconds * 1000; }
        const delay = this.wakeRequested ? 0 : Math.max(1000, next - Date.now());
        this.wakeRequested = false;
        this.timer = setTimeout(() => this.tick(), delay);
      }
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.source.close();
    await this.running;
  }
}
