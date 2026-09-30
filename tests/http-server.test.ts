import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp, readHttpConfig } from '../src/http-server.js';

const token = 'test-only-token-with-at-least-32-characters';
const config = () => readHttpConfig({ IMAP_MCP_BEARER_TOKEN: token, IMAP_MCP_ALLOWED_ORIGINS: 'https://client.example.test' });
let listener: Server;
let base: string;
let calls = 0;
const factory = vi.fn(() => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  server.registerTool('test_tool', { description: 'Count verified calls', inputSchema: {} }, async () => {
    calls++;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  return server;
});
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    listener = createHttpApp(config(), factory).listen(0, '127.0.0.1', error => error ? reject(error) : resolve());
    listener.on('error', reject);
  });
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => listener.close(() => resolve())); });
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

describe('HTTP authentication and MCP', () => {
  it.each(['GET', 'POST', 'DELETE', 'OPTIONS'])('requires authentication for %s /mcp', async method => {
    const response = await fetch(`${base}/mcp`, { method });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each(['Basic xyz', 'Bearer wrong-token', `Bearer ${token} extra`])('rejects invalid Authorization syntax/token', async authorization => {
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: authorization } })).status).toBe(401);
  });
  it('does not accept query credentials, cookies or a forged session ID', async () => {
    const count = factory.mock.calls.length;
    const response = await fetch(`${base}/mcp?access_token=${token}`, {
      method: 'POST', headers: { Cookie: `token=${token}`, 'mcp-session-id': 'forged', 'Content-Type': 'application/json' },
      body: '{invalid JSON',
    });
    expect(response.status).toBe(401);
    expect(factory.mock.calls.length).toBe(count);
  });
  it('rejects duplicate Authorization headers', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { headers: { Authorization: [`Bearer ${token}`, `Bearer ${token}`] } }, res => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(401);
  });
  it('blocks foreign and opaque Origins before invoking a tool', async () => {
    for (const origin of ['https://evil.test', 'null', 'https://client.example.test.evil.test']) {
      expect((await fetch(`${base}/mcp`, { headers: { ...headers, Origin: origin } })).status).toBe(403);
    }
  });
  it('checks Host even with a valid token; forwarded headers do not bypass it', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { headers: { ...headers, Host: 'evil.test', 'X-Forwarded-Host': 'localhost' } }, res => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
  });
  it('authenticates before parsing malformed bodies and sanitizes parser errors', async () => {
    const raw = '{"password":"private-test-value';
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })).status).toBe(401);
    const authenticated = await fetch(`${base}/mcp`, { method: 'POST', headers, body: raw });
    expect(authenticated.status).toBe(400);
    expect(await authenticated.text()).not.toContain('private-test-value');
  });
  it('returns authenticated 405 for stateless GET/DELETE, and minimal public liveness', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${base}/mcp`, { method, headers });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/api/accounts`)).status).toBe(404);
  });
  it('works with the official SDK client across multiple stateless/concurrent requests', async () => {
    const clients = Array.from({ length: 3 }, () => new Client({ name: 'test-client', version: '1.0.0' }));
    try {
      await Promise.all(clients.map(client => client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, Origin: 'https://client.example.test' } },
      }))));
      const lists = await Promise.all(clients.map(client => client.listTools()));
      expect(lists.every(list => list.tools[0].name === 'test_tool')).toBe(true);
      await Promise.all(clients.map(client => client.callTool({ name: 'test_tool', arguments: {} })));
      expect(calls).toBe(3);
    } finally { await Promise.all(clients.map(client => client.close())); }
  });
});

describe('HTTP configuration fails closed', () => {
  it.each([{}, { IMAP_MCP_BEARER_TOKEN: '' }, { IMAP_MCP_BEARER_TOKEN: 'short' },
    { IMAP_MCP_BEARER_TOKEN: token, IMAP_MCP_BEARER_TOKEN_FILE: '/tmp/example' },
    { IMAP_MCP_BEARER_TOKEN: token, IMAP_MCP_PORT: '8787junk' },
    { IMAP_MCP_BEARER_TOKEN: token, IMAP_MCP_ALLOWED_HOSTS: '*' },
    { IMAP_MCP_BEARER_TOKEN: token, IMAP_MCP_ALLOWED_ORIGINS: 'https://example.test/path' }])('rejects invalid/missing configuration', env => {
    expect(() => readHttpConfig({ ...env })).toThrow();
  });
  it('captures only a digest and consumes the environment token', () => {
    const env = { IMAP_MCP_BEARER_TOKEN: token };
    const result = readHttpConfig(env);
    expect(env.IMAP_MCP_BEARER_TOKEN).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.tokenDigest.length).toBe(32);
  });
  it('reads a token file and fails closed on unreadable/invalid files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-auth-'));
    const file = path.join(dir, 'bearer-token');
    try {
      expect(() => readHttpConfig({ IMAP_MCP_BEARER_TOKEN_FILE: file })).toThrow(/Cannot read/);
      await fs.writeFile(file, token + '\n', { mode: 0o600 });
      expect(readHttpConfig({ IMAP_MCP_BEARER_TOKEN_FILE: file }).tokenDigest).toEqual(config().tokenDigest);
      await fs.writeFile(file, 'weak');
      expect(() => readHttpConfig({ IMAP_MCP_BEARER_TOKEN_FILE: file })).toThrow(/32/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
