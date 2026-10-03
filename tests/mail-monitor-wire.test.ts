import { it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startImapFixture } from './helpers/imap-fixture.js';
import { startOAuthFixture } from './helpers/oauth-fixture.mjs';
import { AccountManager } from '../src/services/account-manager.js';
import { MonitorStore } from '../src/monitoring/state.js';
import { MailMonitor } from '../src/monitoring/monitor.js';
import { MailEvents } from '../src/monitoring/events.js';
import { readMonitorConfig } from '../src/monitoring/config.js';
import { createHttpApp, readHttpConfig } from '../src/http-server.js';
import { createOAuthVerifier } from '../src/oauth.js';
import { monitorTools } from '../src/tools/monitor-tools.js';

const mime = (subject: string) => `From: fixture@example.test\r\nTo: local@example.test\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic fixture body.\r\n`;
const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server?: Server) => server?.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();

it('autonomously polls real IMAP sockets and wakes an authenticated MCP client to read and acknowledge only new mail', async () => {
  const imap = await startImapFixture();
  const oauth = await startOAuthFixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'imap-wire-monitor-'));
  let monitor: MailMonitor | undefined;
  let store: MonitorStore | undefined;
  let mcp: Server | undefined;
  let receiver: Server | undefined;
  let failure: unknown;
  let processed = false;
  let bodyFetchBeforeEvent = false;
  try {
    imap.mailboxes.set('account-a', { uidValidity: 111, uidNext: 2, messages: new Map([[1, mime('Existing')]]) });
    imap.mailboxes.set('account-b', { uidValidity: 222, uidNext: 2, messages: new Map([[1, mime('Other')]]) });
    const accounts = new AccountManager(directory);
    const account = async (name: string, user: string) => accounts.addAccount({ name, user, password: 'fixture-only', host: '127.0.0.1', port: imap.port, tls: false, allowStartTLS: false });
    const a = await account('Account A', 'account-a');
    const b = await account('Account B', 'account-b');
    store = new MonitorStore(directory);
    monitor = new MailMonitor(store, accounts, readMonitorConfig({ IMAP_MCP_POLL_ENABLED: 'true', IMAP_MCP_POLL_INTERVAL_SECONDS: '10' }));
    const token = await oauth.token();
    let base: string;
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const rpc = async (method: string, params: any = {}) => {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
        ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) });
      expect(res.status).toBe(200);
      const response = await res.json();
      expect(response.error).toBeUndefined();
      return response.result;
    };
    const call = async (name: string, args: any) => {
      const result = await rpc('tools/call', { name, arguments: args });
      expect(result.isError).not.toBe(true);
      return JSON.parse(result.content[0].text);
    };
    const key = Buffer.alloc(32, 9);
    receiver = createServer(async (req, res) => {
      try {
        let bytes = '';
        for await (const chunk of req) bytes += chunk;
        const signed = `${req.headers['webhook-id']}.${req.headers['webhook-timestamp']}.${bytes}`;
        const expected = `v1,${createHmac('sha256', key).update(signed).digest('base64')}`;
        const actual = String(req.headers['webhook-signature']);
        expect(actual.length).toBe(expected.length);
        expect(timingSafeEqual(Buffer.from(actual), Buffer.from(expected))).toBe(true);
        const event = JSON.parse(bytes);
        if (event.type === 'verification') {
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ challenge: event.challenge })); return;
        }
        bodyFetchBeforeEvent = imap.commands.some(c => c.body);
        expect(event).toMatchObject({ name: 'email.arrived', data: { accountId: a.id, uidValidity: '111', uidRanges: [[2, 2]] } });
        expect(req.headers['webhook-id']).toBe(event.eventId);
        const pending = await call('imap_get_pending_emails', { accountId: a.id });
        expect(pending.uids).toEqual([2]);
        const email = await call('imap_get_pending_email', { accountId: a.id, uidValidity: pending.uidValidity, uid: 2 });
        expect(email).toMatchObject({ subject: 'Arrived', uid: 2, vanished: false });
        expect(email.markdownContent).toContain('Synthetic fixture body');
        await call('imap_acknowledge_emails', { accountId: a.id, uidValidity: pending.uidValidity, uids: [2] });
        processed = true;
        res.end('{}');
      } catch (error) { failure = error; res.statusCode = 500; res.end('{}'); }
    });
    const callback = await listen(receiver);
    // Only the test supplies a loopback delivery adapter. Production always
    // uses postWebhook with DNS pinning/public HTTPS checks; no bypass env exists.
    const events = new MailEvents(monitor, async (_url, body, headers) => {
      const res = await fetch(callback, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
      return { status: res.status, body: await res.text() };
    });
    const config = readHttpConfig({ IMAP_MCP_OAUTH_ISSUER: oauth.issuer, IMAP_MCP_OAUTH_RESOURCE_URL: oauth.state.resource, IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP: 'true' });
    mcp = createServer(createHttpApp(config, () => {
      const server = new McpServer({ name: 'wire-test', version: '1' }); monitorTools(server, monitor!); return server;
    }, await createOAuthVerifier(config.oauth), events));
    base = await listen(mcp);
    await rpc('events/subscribe', { name: 'email.arrived', arguments: { accountId: a.id },
      delivery: { mode: 'webhook', url: 'https://receiver.example/wire-test', secret: `whsec_${key.toString('base64')}` } });
    monitor.start(() => events.deliver());
    await expect.poll(() => store!.get(b.id, 'INBOX')?.nextUid, { timeout: 5000, interval: 20 }).toBe(2);
    expect(monitor.pending(a.id, 'INBOX').uids).toEqual([]);
    // Same message count, different UID: an old message disappears as a new one
    // arrives. The next check must detect the new UID without a client/tool poll.
    const mailbox = imap.mailboxes.get('account-a')!;
    mailbox.messages.delete(1); mailbox.messages.set(2, mime('Arrived')); mailbox.uidNext = 3;
    await expect.poll(() => processed || !!failure, { timeout: 15000, interval: 50 }).toBe(true);
    if (failure) throw failure;
    expect(bodyFetchBeforeEvent).toBe(false);
    expect(monitor.pending(a.id, 'INBOX').uids).toEqual([]);
    expect(monitor.pending(b.id, 'INBOX').uids).toEqual([]);
    expect(imap.commands.filter(c => c.command === 'UID' && c.user === 'account-a')).toEqual([
      { command: 'UID', user: 'account-a', range: '2:2', body: false },
      { command: 'UID', user: 'account-a', range: '2', body: true },
    ]);
    expect(imap.commands.some(c => ['SELECT', 'STORE', 'IDLE', 'DELETE', 'MOVE'].includes(c.command))).toBe(false);
    await monitor.stop();
    await expect.poll(() => imap.activeConnections, { timeout: 1000, interval: 20 }).toBe(0);
  } finally {
    await monitor?.stop(); await close(mcp); await close(receiver);
    store?.close(); await imap.close(); await oauth.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 25000);
