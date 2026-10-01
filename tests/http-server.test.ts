import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request, createServer as createListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp, readHttpConfig } from '../src/http-server.js';
import { createOAuthVerifier } from '../src/oauth.js';
import { startOAuthFixture } from './helpers/oauth-fixture.mjs';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

let fixture: Awaited<ReturnType<typeof startOAuthFixture>>;
let token: string;
const oauthEnv = () => ({ IMAP_MCP_OAUTH_ISSUER: fixture.issuer, IMAP_MCP_OAUTH_RESOURCE_URL: fixture.state.resource, IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP: 'true' });
const config = () => readHttpConfig({ ...oauthEnv(), IMAP_MCP_ALLOWED_ORIGINS: 'https://client.example.test' });
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
  fixture = await startOAuthFixture();
  token = await fixture.token();
  const verifier = await createOAuthVerifier(config().oauth);
  await new Promise<void>((resolve, reject) => {
    listener = createHttpApp(config(), factory, verifier).listen(0, '127.0.0.1', error => error ? reject(error) : resolve());
    listener.on('error', reject);
  });
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => listener.close(() => resolve())); await fixture.close(); });
const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });

describe('HTTP authentication and MCP', () => {
  it('serves root and path discovery publicly, with canonical URLs and CORS', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await fetch(`${base}${path}`, { headers: { Origin: 'https://discovery.test' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.json()).toMatchObject({ resource: fixture.state.resource,
        authorization_servers: [fixture.issuer], scopes_supported: ['imap:access'], bearer_methods_supported: ['header'] });
      const preflight = await fetch(`${base}${path}`, { method: 'OPTIONS', headers: {
        Origin: 'https://discovery.test', 'Access-Control-Request-Headers': 'mcp-protocol-version',
      } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-headers')).toContain('MCP-Protocol-Version');
    }
    const challenge = (await fetch(`${base}/mcp`)).headers.get('www-authenticate');
    expect(challenge).toContain('resource_metadata="https://mail-mcp.example.test/.well-known/oauth-protected-resource/mcp"');
    expect(challenge).toContain('scope="imap:access"');
    expect(challenge).not.toContain('error=');
  });
  it('allows preflight only for an allowed browser origin and exposes challenges', async () => {
    const response = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://client.example.test' } });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    const denied = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    expect(denied.status).toBe(403);
    const challenge = await fetch(`${base}/mcp`, { headers: { Origin: 'https://client.example.test' } });
    expect(challenge.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });
  it('returns 403 insufficient_scope before invoking tools, and 401 for invalid signed tokens', async () => {
    const count = factory.mock.calls.length;
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers(), Authorization: `Bearer ${await fixture.token({ scope: 'openid' })}` }, body: '{invalid' });
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(response.headers.get('www-authenticate')).toContain('scope="imap:access"');
    expect(factory.mock.calls.length).toBe(count);
    for (const payload of [{ aud: 'other' }, { exp: 1 }, { typ: 'ID' }]) {
      expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${await fixture.token(payload)}` } })).status).toBe(401);
    }
  });
  it.each(['GET', 'POST', 'DELETE', 'OPTIONS'])('requires authentication for %s /mcp', async method => {
    const response = await fetch(`${base}/mcp`, { method });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each(['Basic xyz', 'Bearer wrong-token', 'Bearer wrong extra'])('rejects invalid Authorization syntax/token', async authorization => {
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
      expect((await fetch(`${base}/mcp`, { headers: { ...headers(), Origin: origin } })).status).toBe(403);
    }
  });
  it('checks Host even with a valid token; forwarded headers do not bypass it', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/mcp`, { headers: { ...headers(), Host: 'evil.test', 'X-Forwarded-Host': 'localhost' } }, res => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
  });
  it('authenticates before parsing malformed bodies and sanitizes parser errors', async () => {
    const raw = '{"password":"private-test-value';
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })).status).toBe(401);
    const authenticated = await fetch(`${base}/mcp`, { method: 'POST', headers: headers(), body: raw });
    expect(authenticated.status).toBe(400);
    expect(await authenticated.text()).not.toContain('private-test-value');
  });
  it('returns authenticated 405 for stateless GET/DELETE, and minimal public liveness', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${base}/mcp`, { method, headers: headers() });
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
  it('supports official SDK discovery, authorization-code PKCE and refresh after an expired token', async () => {
    // Standalone app uses its actual loopback URL as resource, so the client can
    // follow WWW-Authenticate instead of the external reverse-proxy test URI.
    const cfg = config();
    const oauthListener = createListener().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => oauthListener.once('listening', resolve));
    const url = `http://127.0.0.1:${(oauthListener.address() as AddressInfo).port}/mcp`;
    cfg.oauth.resourceUrl = url;
    fixture.state.resource = url;
    oauthListener.on('request', createHttpApp(cfg, factory, await createOAuthVerifier(cfg.oauth)));
    let tokens: OAuthTokens | undefined;
    let codeVerifier = '';
    const provider: OAuthClientProvider = {
      redirectUrl: 'http://127.0.0.1:5555/callback',
      clientMetadata: { redirect_uris: ['http://127.0.0.1:5555/callback'], token_endpoint_auth_method: 'none' },
      clientInformation: () => ({ client_id: 'test-client' }), tokens: () => tokens,
      saveTokens: value => { tokens = value; },
      redirectToAuthorization: value => { fixture.state.authorizationUrl = value; },
      saveCodeVerifier: value => { codeVerifier = value; }, codeVerifier: () => codeVerifier,
    };
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
    let client = new Client({ name: 'oauth-client', version: '1.0.0' });
    try {
      await expect(client.connect(transport)).rejects.toThrow('Unauthorized');
      const authUrl = fixture.state.authorizationUrl!;
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('resource')).toBe(url);
      expect(authUrl.searchParams.get('scope')).toBe('imap:access');
      await transport.finishAuth('test-code');
      expect(tokens?.refresh_token).toBe('test-refresh');
      await client.close();
      client = new Client({ name: 'oauth-client', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }));
      expect((await client.listTools()).tools[0].name).toBe('test_tool');
      tokens = { ...tokens!, access_token: await fixture.token({ exp: 1 }) };
      await client.listTools();
      expect(fixture.state.tokenRequests.map((req: Record<string, string>) => req.grant_type)).toEqual(['authorization_code', 'refresh_token']);
    } finally {
      await client.close();
      await new Promise<void>(resolve => oauthListener.close(() => resolve()));
      fixture.state.resource = 'https://mail-mcp.example.test/mcp';
    }
  });
});

describe('HTTP configuration fails closed', () => {
  it.each([{}, { IMAP_MCP_OAUTH_ISSUER: '' }, { IMAP_MCP_BEARER_TOKEN: 'obsolete' },
    { IMAP_MCP_BEARER_TOKEN_FILE: '/tmp/obsolete' }, { IMAP_MCP_PORT: '8787junk' },
    { IMAP_MCP_ALLOWED_HOSTS: '*' }, { IMAP_MCP_ALLOWED_ORIGINS: 'https://example.test/path' }])('rejects invalid/missing configuration', env => {
    expect(() => readHttpConfig(Object.keys(env).length ? { ...oauthEnv(), ...env } : {})).toThrow();
  });
});
