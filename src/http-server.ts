import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpConfig {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  tokenDigest: Buffer;
}

export function validateBearerToken(token: string): string {
  if (token.length < 32 || token.length > 4096 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
    throw new Error('Bearer token must be 32–4096 characters of RFC 6750 token syntax.');
  }
  return token;
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const inlineToken = env.IMAP_MCP_BEARER_TOKEN;
  delete env.IMAP_MCP_BEARER_TOKEN;
  const tokenFile = env.IMAP_MCP_BEARER_TOKEN_FILE;
  if ((inlineToken !== undefined) === (tokenFile !== undefined)) {
    throw new Error('HTTP requires exactly one of IMAP_MCP_BEARER_TOKEN or IMAP_MCP_BEARER_TOKEN_FILE.');
  }
  let token: string;
  if (inlineToken !== undefined) token = inlineToken;
  else {
    try { token = readFileSync(tokenFile!, 'utf8').trim(); }
    catch { throw new Error('Cannot read IMAP_MCP_BEARER_TOKEN_FILE. Check the file and permissions.'); }
  }
  validateBearerToken(token);
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
    tokenDigest: crypto.createHash('sha256').update(token).digest(),
  };
}

export function createHttpApp(config: HttpConfig, createServer: () => McpServer) {
  const app = express();
  app.disable('x-powered-by');
  // The proxy must preserve Host; never trust forwarded host/origin headers.
  app.use(hostHeaderValidation(config.allowedHosts));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin !== undefined && !config.allowedOrigins.includes(req.headers.origin)) {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }
    next();
  });
  // Minimal liveness response, no account or mailbox data.
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/mcp', (req, res, next) => {
    // Only one Authorization header credential; never cookies/query/body.
    const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(req.headers.authorization ?? '');
    const digest = crypto.createHash('sha256').update(match?.[1] ?? '').digest();
    if (!match || req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length !== 1 || !crypto.timingSafeEqual(digest, config.tokenDigest)) {
      res.set('WWW-Authenticate', 'Bearer realm="imap-mcp", error="invalid_token"');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
  // Parse after authorization; 40 MiB accommodates a 25 MiB base64 upload.
  app.post('/mcp', express.json({ limit: '40mb' }), async (req, res) => {
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
