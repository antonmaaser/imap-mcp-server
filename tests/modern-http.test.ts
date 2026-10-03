import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApp, readHttpConfig } from '../src/http-server.js';
import { createOAuthVerifier } from '../src/oauth.js';
import { startOAuthFixture } from './helpers/oauth-fixture.mjs';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccountManager } from '../src/services/account-manager.js';
import { MonitorStore } from '../src/monitoring/state.js';
import { MailMonitor } from '../src/monitoring/monitor.js';
import { MailEvents } from '../src/monitoring/events.js';
import { readMonitorConfig } from '../src/monitoring/config.js';
import { monitorTools } from '../src/tools/monitor-tools.js';

let fixture: Awaited<ReturnType<typeof startOAuthFixture>>;
let listener: Server | undefined;
let base: string;
let token: string;
let directory: string;
let store: MonitorStore;
let accountId: string;
let posted = 0;
let monitor: MailMonitor;
let events: MailEvents;
let arriving = false;
const deliveries: any[] = [];
const calls = vi.fn();
const factory = () => {
  const server = new McpServer({ name: 'modern-test', version: '1' });
  server.registerTool('test_tool', { description: 'Test', inputSchema: { value: z.string() } }, async ({ value }) => {
    calls(); return { content: [{ type: 'text', text: value }] };
  });
  if (monitor) monitorTools(server, monitor);
  return server;
};
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const rpc = (method: string, params: object = {}, overrides: Record<string, string> = {}, authorized = true) => fetch(`${base}/mcp`, {
  method: 'POST', headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
    ...(method === 'tools/call' ? { 'Mcp-Name': (params as any).name } : {}), ...overrides },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
});
beforeAll(async () => {
  fixture = await startOAuthFixture(); token = await fixture.token();
  directory = mkdtempSync(path.join(os.tmpdir(), 'imap-modern-'));
  const accounts = new AccountManager(directory);
  accountId = (await accounts.addAccount({ name: 'Test', host: 'imap.invalid', port: 993, tls: true, user: 'test', password: 'test' })).id;
  store = new MonitorStore(directory);
  monitor = new MailMonitor(store, accounts, readMonitorConfig({ IMAP_MCP_POLL_ENABLED: 'true' }), {
    scan: async () => ({ uidValidity: '111', nextUid: arriving ? 3 : 1, uids: arriving ? [1, 2] : [], baseline: !arriving, reset: false, caughtUp: true }),
    read: async (_account, folder, uidValidity, uid) => ({ folder, uidValidity, uid, markdownContent: 'Mail body returned only to the client.' }),
    close() {},
  });
  events = new MailEvents(monitor, async (_url, body) => {
    posted++; const payload = JSON.parse(body); if (payload.eventId) deliveries.push(payload);
    return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  });
  const config = readHttpConfig({ IMAP_MCP_OAUTH_ISSUER: fixture.issuer, IMAP_MCP_OAUTH_RESOURCE_URL: fixture.state.resource, IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP: 'true' });
  listener = createHttpApp(config, factory, await createOAuthVerifier(config.oauth), events).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { listener!.once('listening', resolve); listener!.once('error', reject); });
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
afterAll(async () => { if (listener) await new Promise<void>(resolve => listener!.close(() => resolve())); await fixture?.close(); store?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

describe('modern MCP HTTP adapter', () => {
  it('discovers supported features and lists events through the authenticated endpoint', async () => {
    expect((await (await rpc('server/discover')).json()).result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } });
    expect((await (await rpc('events/list')).json()).result.events[0]).toMatchObject({ name: 'email.arrived', delivery: ['webhook'] });
    expect((await rpc('events/list', {}, {}, false)).status).toBe(401);
  });
  it('routes existing tools through their SDK validation and returns modern result envelopes', async () => {
    expect((await (await rpc('tools/list')).json()).result.tools[0].name).toBe('test_tool');
    expect((await (await rpc('tools/call', { name: 'test_tool', arguments: { value: 'ok' } })).json()).result).toMatchObject({ resultType: 'complete', content: [{ text: 'ok' }] });
    const count = calls.mock.calls.length;
    expect((await (await rpc('tools/call', { name: 'test_tool', arguments: { value: 3 } })).json()).result.isError).toBe(true);
    expect(calls).toHaveBeenCalledTimes(count);
  });
  it('validates mirrored headers before invoking tools and returns official error codes', async () => {
    const response = await rpc('tools/call', { name: 'test_tool', arguments: { value: 'ok' } }, { 'Mcp-Name': 'wrong' });
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe(-32020);
    expect((await rpc('tools/list', {}, { 'MCP-Protocol-Version': 'unknown' })).status).toBe(400);
    expect((await rpc('unknown/method')).status).toBe(404);
  });
  it('verifies and persists event subscription through HTTP and does not deliver application data before verification', async () => {
    const params = { name: 'email.arrived', arguments: { accountId }, delivery: {
      mode: 'webhook', url: 'https://receiver.example/callback', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` } };
    const first = (await (await rpc('events/subscribe', params)).json()).result;
    expect(first.id).toMatch(/^sub_/); expect(posted).toBe(1);
    expect((await (await rpc('events/subscribe', params)).json()).result.id).toBe(first.id);
    expect(posted).toBe(1);
    expect(store.subscription(first.id)).toBeDefined();
    const { secret: _secret, ...delivery } = params.delivery;
    expect((await (await rpc('events/unsubscribe', { ...params, delivery })).json()).result).toMatchObject({ resultType: 'complete' });
    expect(store.subscription(first.id)).toBeUndefined();
  });
  it('runs the full poll-event-read-acknowledge sequence through authenticated MCP', async () => {
    await monitor.pollOnce(true);
    const params = { name: 'email.arrived', arguments: { accountId }, delivery: {
      mode: 'webhook', url: 'https://receiver.example/pipeline', secret: `whsec_${Buffer.alloc(32, 9).toString('base64')}` } };
    expect((await (await rpc('events/subscribe', params)).json()).result.id).toMatch(/^sub_/);
    arriving = true;
    await monitor.pollOnce(true); await events.deliver();
    expect(deliveries.at(-1)).toMatchObject({ name: 'email.arrived', data: { accountId, uidValidity: '111', uidRanges: [[1, 2]] } });
    const call = async (name: string, args: object) => {
      const response = await (await rpc('tools/call', { name, arguments: args })).json();
      expect(response.result.isError).not.toBe(true);
      return JSON.parse(response.result.content[0].text);
    };
    expect(await call('imap_get_pending_emails', { accountId })).toMatchObject({ uids: [1, 2] });
    expect(await call('imap_get_pending_email', { accountId, uidValidity: '111', uid: 1 })).toMatchObject({ uid: 1, markdownContent: 'Mail body returned only to the client.' });
    expect(await call('imap_get_pending_emails', { accountId })).toMatchObject({ uids: [1, 2] });
    await call('imap_acknowledge_emails', { accountId, uidValidity: '111', uids: [1] });
    expect(await call('imap_get_pending_emails', { accountId })).toMatchObject({ uids: [2] });
  });
});
