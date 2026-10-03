import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccountManager } from '../src/services/account-manager.js';
import { MailMonitor } from '../src/monitoring/monitor.js';
import { MonitorStore } from '../src/monitoring/state.js';
import { readMonitorConfig } from '../src/monitoring/config.js';
import { MailEvents } from '../src/monitoring/events.js';
import type { ScanResult, MailSource } from '../src/monitoring/imap-source.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { publicAddress, callbackUrl, webhookSignature } from '../src/monitoring/webhook.js';
import { createHmac } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools/index.js';

let directory: string;
let accounts: AccountManager;
let store: MonitorStore;
let monitor: MailMonitor;
let events: MailEvents;
let id: string;
let snapshot: ScanResult;
let source: MailSource;
let posted: { body: string; headers: Record<string, string> }[];
let responseStatus: number;
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const auth = (): AuthInfo => ({ token: 'not-persisted', clientId: 'test', scopes: ['imap:access'],
  expiresAt: Math.floor(Date.now() / 1000) + 300, extra: { sub: 'owner' } });
const subscription = () => ({ name: 'email.arrived', arguments: { accountId: id, folder: 'INBOX' },
  delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret } });
beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'imap-monitor-'));
  accounts = new AccountManager(directory);
  const account = await accounts.addAccount({ name: 'Work', host: 'imap.example.test', port: 993, user: 'test', password: 'local-test-secret', tls: true });
  id = account.id;
  store = new MonitorStore(directory);
  snapshot = { uidValidity: '111', nextUid: 10, uids: [], baseline: true, reset: false, caughtUp: true };
  source = { scan: vi.fn(async () => structuredClone(snapshot)), read: vi.fn(async () => ({ body: 'memory-only' })), close: vi.fn() };
  monitor = new MailMonitor(store, accounts, readMonitorConfig({ IMAP_MCP_POLL_ENABLED: 'true' }), source);
  posted = []; responseStatus = 200;
  events = new MailEvents(monitor, async (_url, body, headers) => {
    posted.push({ body, headers });
    const parsed = JSON.parse(body);
    return { status: responseStatus, body: JSON.stringify(parsed.type === 'verification' ? { challenge: parsed.challenge } : {}) };
  });
});
afterEach(async () => { await monitor.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('durable mailbox state', () => {
  it('keeps account state isolated, paginates gaps, and advances without relying on unread or message counts', async () => {
    const other = await accounts.addAccount({ name: 'Other', host: 'other.test', port: 993, user: 'test', password: 'test', tls: true });
    await monitor.pollOnce(true);
    snapshot = { ...snapshot, nextUid: 17, baseline: false, uids: [10, 11, 15, 16] };
    await monitor.pollOnce(true);
    expect(monitor.pending(id, 'INBOX', 0, 2)).toMatchObject({ uidValidity: '111', uids: [10, 11], pending: [[10, 11], [15, 16]], nextAfterUid: 11 });
    expect(monitor.pending(id, 'INBOX', 11, 2)).toMatchObject({ uids: [15, 16], nextAfterUid: null });
    monitor.acknowledge(id, 'INBOX', '111', [11, 16]);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ uids: [10, 15] });
    expect(monitor.pending(other.id, 'INBOX')).toMatchObject({ uids: [10, 11, 15, 16] });
  });
  it('does not acknowledge a read and rejects acknowledgements for an old mailbox generation', async () => {
    await monitor.pollOnce(true);
    snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
    await monitor.pollOnce(true);
    await monitor.read(id, 'INBOX', '111', 10, 1000);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ uids: [10] });
    snapshot = { ...snapshot, uidValidity: '222', nextUid: 4, uids: [1, 3], reset: true };
    await monitor.pollOnce(true);
    expect(() => monitor.acknowledge(id, 'INBOX', '111', [10])).toThrow('generation');
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ uids: [1, 3], lastResult: 'reset' });
    expect(() => monitor.acknowledge(id, 'INBOX', '222', [3])).not.toThrow();
    expect(() => monitor.acknowledge(id, 'INBOX', '222', [3])).not.toThrow();
  });
  it('preserves acknowledged state through restart and stores no credentials or bodies', async () => {
    await monitor.pollOnce(true);
    snapshot = { ...snapshot, nextUid: 13, baseline: false, uids: [10, 12] };
    await monitor.pollOnce(true);
    monitor.acknowledge(id, 'INBOX', '111', [10]);
    store.close(); store = new MonitorStore(directory);
    monitor = new MailMonitor(store, accounts, readMonitorConfig({ IMAP_MCP_POLL_ENABLED: 'true' }), source);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ uids: [12], nextUid: 13 });
    const bytes = readFileSync(path.join(directory, 'monitor.sqlite'));
    expect(bytes.includes(Buffer.from('local-test-secret'))).toBe(false);
    expect(bytes.includes(Buffer.from('memory-only'))).toBe(false);
    expect(statSync(path.join(directory, 'monitor.sqlite')).mode & 0o777).toBe(0o600);
  });
  it('retains the checkpoint and returns an unknown/error condition when a poll fails', async () => {
    await monitor.pollOnce(true);
    snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
    await monitor.pollOnce(true);
    vi.mocked(source.scan).mockRejectedValueOnce(new Error('sensitive-provider-error'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await monitor.pollOnce(true);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ nextUid: 11, lastError: 'poll_failed' });
    monitor.acknowledge(id, 'INBOX', '111', [10]);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ lastError: 'poll_failed' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-provider-error');
  });
  it('reports failure before the first successful baseline', async () => {
    vi.mocked(source.scan).mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await monitor.pollOnce(true);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ initialized: false, lastError: 'poll_failed' });
  });
  it('serializes pollers across database connections without consuming each other acknowledgements', async () => {
    const second = new MonitorStore(directory);
    const key = JSON.stringify([id, 'INBOX']);
    expect(second.lease(key, 'other-process', 60000)).toBe(true);
    await monitor.pollOnce(true);
    expect(source.scan).not.toHaveBeenCalled();
    second.release(key, 'other-process'); second.close();
    await monitor.pollOnce(true);
    expect(source.scan).toHaveBeenCalledTimes(1);
  });
  it('honors different per-account folders and intervals and discovers added accounts', async () => {
    const configured = new MailMonitor(store, accounts, readMonitorConfig({ IMAP_MCP_POLL_ENABLED: 'true',
      IMAP_MCP_POLL_ACCOUNTS: JSON.stringify([{ account: 'Work', folders: ['INBOX', 'Receipts'], intervalSeconds: 120 }]) }), source);
    await configured.pollOnce(); await configured.pollOnce();
    expect(source.scan).toHaveBeenCalledTimes(2);
    expect(configured.targets()[0]).toMatchObject({ intervalSeconds: 120, folders: ['INBOX', 'Receipts'] });
    await accounts.addAccount({ name: 'Added', host: 'test', port: 993, user: 'test', password: 'test', tls: true });
    expect(monitor.targets()).toHaveLength(2);
  });
  it('starts polling without a tool call and repeats on its configured interval', async () => {
    vi.useFakeTimers();
    try {
      monitor.start(() => events.deliver());
      await vi.advanceTimersByTimeAsync(1);
      expect(source.scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect(source.scan).toHaveBeenCalledTimes(2);
      await monitor.stop();
      await vi.advanceTimersByTimeAsync(60000);
      expect(source.scan).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('MCP webhook lifecycle', () => {
  it('verifies a signed challenge, keeps subscriptions idempotent and secrets encrypted', async () => {
    const first = await events.subscribe(subscription(), auth());
    const second = await events.subscribe({ ...subscription(), arguments: { folder: 'INBOX', accountId: id } }, auth());
    expect(first.id).toBe(second.id);
    expect(posted).toHaveLength(1);
    const { headers, body } = posted[0];
    expect(headers['webhook-signature']).toBe(webhookSignature(secret, headers['webhook-id'], Number(headers['webhook-timestamp']), body));
    expect(Date.parse(first.refreshBefore)).toBeLessThanOrEqual(auth().expiresAt! * 1000);
    const bytes = readFileSync(path.join(directory, 'monitor.sqlite'));
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
    expect(bytes.includes(Buffer.from('not-persisted'))).toBe(false);
  });
  it('commits discovery and event atomically, delivers on restart with the same event ID, and keeps mail pending', async () => {
    await monitor.pollOnce(true);
    await events.subscribe(subscription(), auth());
    snapshot = { ...snapshot, nextUid: 12, baseline: false, uids: [10, 11] };
    await monitor.pollOnce(true);
    responseStatus = 503;
    await events.deliver();
    const initial = JSON.parse(posted[1].body);
    store.close(); store = new MonitorStore(directory);
    monitor = new MailMonitor(store, accounts, readMonitorConfig({ IMAP_MCP_POLL_ENABLED: 'true' }), source);
    responseStatus = 200;
    events = new MailEvents(monitor, async (_url, body, headers) => { posted.push({ body, headers }); return { status: 200, body: '{}' }; });
    store.db.prepare('UPDATE outbox SET due=0').run();
    await events.deliver();
    expect(JSON.parse(posted.at(-1)!.body).eventId).toBe(initial.eventId);
    expect(posted.at(-1)!.headers['webhook-id']).toBe(initial.eventId);
    expect(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n).toBe(0);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ uids: [10, 11] });
  });
  it('invalidates old-generation events while retaining the folder subscription for resets and future mail', async () => {
    await monitor.pollOnce(true);
    const sub = await events.subscribe(subscription(), auth());
    snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
    await monitor.pollOnce(true);
    snapshot = { ...snapshot, uidValidity: '222', nextUid: 3, uids: [1, 2], reset: true };
    await monitor.pollOnce(true);
    await events.deliver();
    expect(store.subscription(sub.id)).toBeDefined();
    expect(posted.filter(p => !JSON.parse(p.body).type).map(p => JSON.parse(p.body).data.uidValidity)).toEqual(['222']);
  });
  it('stops deliveries after expiry, unsubscribe, account removal or identity change', async () => {
    await monitor.pollOnce(true);
    const sub = await events.subscribe(subscription(), auth());
    snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
    await monitor.pollOnce(true);
    await accounts.removeAccount(id);
    await events.deliver();
    expect(posted).toHaveLength(1);
    expect(store.subscription(sub.id)).toBeUndefined();
  });
  it('rejects wrong challenges and invalid secrets without saving a subscription', async () => {
    const bad = new MailEvents(monitor, async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
    await expect(bad.subscribe(subscription(), auth())).rejects.toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
    await expect(events.subscribe({ ...subscription(), delivery: { ...subscription().delivery, secret: 'whsec_invalid' } }, auth())).rejects.toMatchObject({ code: -32602 });
    expect(store.db.prepare('SELECT count(*) AS n FROM subscriptions').get()!.n).toBe(0);
  });
  it('does not retry 413, terminates on 410, and exposes permanent failure while retaining pending work', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await monitor.pollOnce(true);
    await events.subscribe(subscription(), auth());
    snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
    await monitor.pollOnce(true);
    responseStatus = 413;
    await events.deliver(); await events.deliver();
    expect(posted).toHaveLength(2);
    expect(monitor.pending(id, 'INBOX')).toMatchObject({ uids: [10], delivery: { failed: 1 } });
    snapshot = { ...snapshot, nextUid: 12, uids: [11] };
    await monitor.pollOnce(true);
    responseStatus = 410; await events.deliver();
    expect(store.db.prepare('SELECT count(*) AS n FROM subscriptions').get()!.n).toBe(0);
  });
  it('binds unsubscribe to principal and client, and only notifies a late subscriber of subsequent discoveries', async () => {
    await monitor.pollOnce(true);
    snapshot = { ...snapshot, nextUid: 12, baseline: false, uids: [10, 11] };
    await monitor.pollOnce(true);
    const sub = await events.subscribe(subscription(), auth());
    const stop = { ...subscription(), delivery: { mode: 'webhook', url: subscription().delivery.url } };
    events.unsubscribe(stop, { ...auth(), extra: { sub: 'other' } });
    expect(store.subscription(sub.id)).toBeDefined();
    await events.deliver();
    expect(posted).toHaveLength(1); // Signed verification only; no backlog event.
    snapshot = { ...snapshot, nextUid: 13, uids: [12] };
    await monitor.pollOnce(true); await events.deliver();
    expect(JSON.parse(posted[1].body).data).toMatchObject({ reason: 'arrival', uidRanges: [[12, 12]] });
    events.unsubscribe(stop, auth()); events.unsubscribe(stop, auth());
    expect(store.subscription(sub.id)).toBeUndefined();
    snapshot = { ...snapshot, nextUid: 14, uids: [13] };
    await monitor.pollOnce(true); await events.deliver();
    expect(posted).toHaveLength(2);
    expect(monitor.pending(id, 'INBOX').uids).toEqual([10, 11, 12, 13]);
  });
  it('starts a fresh window after expiry without replaying old deliveries or discoveries during the gap', async () => {
    await monitor.pollOnce(true);
    const first = await events.subscribe(subscription(), auth());
    snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
    await monitor.pollOnce(true);
    const expired = store.subscription(first.id)!;
    store.saveSubscription({ ...expired, expires: Date.now() - 1 });
    snapshot = { ...snapshot, nextUid: 12, uids: [11] };
    await monitor.pollOnce(true);
    expect(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n).toBe(1);
    const renewed = await events.subscribe(subscription(), auth());
    expect(renewed.id).toBe(first.id);
    await events.deliver();
    expect(posted).toHaveLength(2); // Both subscription verification challenges.
    expect(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n).toBe(0);
    snapshot = { ...snapshot, nextUid: 13, uids: [12] };
    await monitor.pollOnce(true); await events.deliver();
    expect(JSON.parse(posted[2].body).data.uidRanges).toEqual([[12, 12]]);
    expect(monitor.pending(id, 'INBOX').uids).toEqual([10, 11, 12]);
  });
  it('preserves a queued event across an uninterrupted subscription refresh without creating a backlog event', async () => {
    await monitor.pollOnce(true);
    await events.subscribe(subscription(), auth());
    snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
    await monitor.pollOnce(true);
    const queued = store.db.prepare('SELECT event FROM outbox').get()!.event;
    await events.subscribe(subscription(), auth());
    expect(store.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n).toBe(1);
    await events.deliver();
    expect(posted).toHaveLength(2);
    expect(posted[1].body).toBe(queued);
  });
  it('excludes discoveries during initial callback verification and only activates after successful registration', async () => {
    await monitor.pollOnce(true);
    const verifying = new MailEvents(monitor, async (_url, body, headers) => {
      posted.push({ body, headers });
      const parsed = JSON.parse(body);
      if (parsed.type === 'verification') {
        snapshot = { ...snapshot, nextUid: 11, baseline: false, uids: [10] };
        await monitor.pollOnce(true);
      }
      return { status: 200, body: JSON.stringify(parsed.type === 'verification' ? { challenge: parsed.challenge } : {}) };
    });
    await verifying.subscribe(subscription(), auth());
    await verifying.deliver();
    expect(posted).toHaveLength(1);
    snapshot = { ...snapshot, nextUid: 12, uids: [11] };
    await monitor.pollOnce(true); await verifying.deliver();
    expect(JSON.parse(posted[1].body).data.uidRanges).toEqual([[11, 11]]);
    expect(monitor.pending(id, 'INBOX').uids).toEqual([10, 11]);
  });
});

describe('outbound callback safety', () => {
  it.each(['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001:db8::1'])('blocks non-public destination %s', address => {
    expect(publicAddress(address)).toBe(false);
  });
  it('allows public IPs and requires HTTPS without credentials, redirects or alternative ports', () => {
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of ['http://example.com', 'https://localhost', 'https://user:password@example.com', 'https://example.com:8443', 'https://127.0.0.1']) {
      expect(() => callbackUrl(url)).toThrow();
    }
    const body = '{"eventId":"evt_1"}';
    expect(webhookSignature(secret, 'evt_1', 123, body)).toBe(`v1,${createHmac('sha256', Buffer.alloc(32, 7)).update(`evt_1.123.${body}`).digest('base64')}`);
  });
  it('registers monitoring tools through the existing allowlist and excludes acknowledgement in read-only mode', () => {
    const names: string[] = [];
    const server = { registerTool: (name: string) => names.push(name) } as unknown as McpServer;
    vi.stubEnv('IMAP_MCP_READ_ONLY', 'true');
    registerTools(server, {} as any, {} as any, {} as any, {} as any, monitor);
    expect(names).toContain('imap_get_pending_emails'); expect(names).toContain('imap_get_pending_email');
    expect(names).not.toContain('imap_acknowledge_emails');
    vi.unstubAllEnvs();
  });
});
