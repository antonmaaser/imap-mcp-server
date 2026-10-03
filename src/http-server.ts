import express from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { readOAuthConfig, resourceMetadataUrl, type OAuthConfig, type AccessTokenVerifier } from './oauth.js';
import { handleModernRequest } from './modern-http.js';
import type { MailEvents } from './monitoring/events.js';

export interface HttpConfig {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  oauth: OAuthConfig;
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  if (env.IMAP_MCP_BEARER_TOKEN !== undefined || env.IMAP_MCP_BEARER_TOKEN_FILE !== undefined) {
    delete env.IMAP_MCP_BEARER_TOKEN;
    throw new Error('Static bearer authentication has been removed. Configure IMAP_MCP_OAUTH_ISSUER and IMAP_MCP_OAUTH_RESOURCE_URL instead.');
  }
  const portString = env.IMAP_MCP_PORT ?? '8787';
  const port = Number(portString);
  if (!/^\d+$/.test(portString) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('IMAP_MCP_PORT must be an integer between 1 and 65535.');
  }
  const list = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
  const allowedHosts = list(env.IMAP_MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]');
  if (!allowedHosts.length || allowedHosts.some(host => !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])$/.test(host))) {
    throw new Error('IMAP_MCP_ALLOWED_HOSTS must contain exact hostnames without schemes, ports or wildcards.');
  }
  const allowedOrigins = list(env.IMAP_MCP_ALLOWED_ORIGINS ?? '');
  for (const origin of allowedOrigins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error();
    } catch { throw new Error('IMAP_MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths.'); }
  }
  return {
    host: env.IMAP_MCP_HOST ?? '127.0.0.1', port, allowedHosts, allowedOrigins,
    oauth: readOAuthConfig(env),
  };
}

export function createHttpApp(config: HttpConfig, createServer: () => McpServer, verifier: AccessTokenVerifier, events?: MailEvents) {
  const app = express();
  app.disable('x-powered-by');
  // The proxy must preserve Host; never trust forwarded host/origin headers.
  app.use(hostHeaderValidation(config.allowedHosts));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const metadataPaths = ['/.well-known/oauth-protected-resource', new URL(resourceMetadataUrl(config.oauth)).pathname];
  // Public discovery contains no mailbox data; browser clients need unrestricted
  // metadata CORS even when their Origin is not allowed to invoke MCP tools.
  app.use(metadataPaths, (_req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
  app.options(metadataPaths, (_req, res) => {
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Accept, Content-Type, MCP-Protocol-Version');
    res.status(204).end();
  });
  app.get(metadataPaths, (_req, res) => {
    res.json({ resource: config.oauth.resourceUrl, authorization_servers: [config.oauth.issuer],
      scopes_supported: config.oauth.scopes, bearer_methods_supported: ['header'], resource_name: 'IMAP MCP Server' });
  });
  app.use((req, res, next) => {
    if (req.headers.origin !== undefined && !config.allowedOrigins.includes(req.headers.origin)) {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }
    next();
  });
  // Minimal liveness response, no account or mailbox data.
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/mcp', (req, res, next) => {
    if (req.headers.origin) {
      res.set('Access-Control-Allow-Origin', req.headers.origin);
      res.vary('Origin');
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, Mcp-Method, Mcp-Name');
        res.status(204).end();
        return;
      }
    }
    next();
  });
  app.use('/mcp', (req, res, next) => {
    // Only one Authorization header credential; never cookies/query/body.
    if (req.headers.authorization === undefined) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl(config.oauth)}", scope="${config.oauth.scopes.join(' ')}"`);
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(req.headers.authorization ?? '');
    if (!match || req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length !== 1) {
      res.set('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl(config.oauth)}", scope="${config.oauth.scopes.join(' ')}"`);
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    next();
  });
  app.use('/mcp', requireBearerAuth({ verifier, requiredScopes: config.oauth.scopes, resourceMetadataUrl: resourceMetadataUrl(config.oauth) }));
  // Parse after authorization; 40 MiB accommodates a 25 MiB base64 upload.
  app.post('/mcp', express.json({ limit: '40mb' }), async (req, res) => {
    if (await handleModernRequest(req, res, createServer, events)) return;
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void server.close().catch(() => {});
    };
    res.on('close', close);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      // Never log requests, provider errors, tokens or message bodies.
      if (!res.headersSent) res.status(500).json({
        jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' },
      });
      close();
    }
  });
  app.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({
      jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' },
    });
  });
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'Request too large' : 'Invalid request' });
  });
  return app;
}
