import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { MailEvents } from './monitoring/events.js';
import { EventError } from './monitoring/event-error.js';

export const MODERN_VERSION = '2026-07-28';
const versionKey = 'io.modelcontextprotocol/protocolVersion';
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';

// A bounded HTTP-only adapter keeps the existing SDK v1 schemas, handlers and
// tool allowlists as the single source of truth. It advertises only tools and
// webhooks: no sampling, elicitation, resources, sessions or streaming promises.
export async function handleModernRequest(req: Request, res: Response, createServer: () => McpServer, events?: MailEvents): Promise<boolean> {
  const body = req.body;
  const modern = req.headers['mcp-protocol-version'] === MODERN_VERSION || body?.params?._meta?.[versionKey] !== undefined ||
    req.headers['mcp-method'] !== undefined || body?.method === 'server/discover' || String(body?.method).startsWith('events/');
  if (!modern) return false;
  const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null;
  const error = (status: number, code: number, message: string, data?: unknown) => {
    res.status(status).json({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
    return true;
  };
  if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || id === null ||
    !body.params || typeof body.params !== 'object' || Array.isArray(body.params)) return error(400, -32600, 'Invalid request');
  const meta = body.params._meta;
  if (!meta || typeof meta[versionKey] !== 'string' || !meta[capabilitiesKey] || typeof meta[capabilitiesKey] !== 'object' || Array.isArray(meta[capabilitiesKey])) {
    return error(400, -32600, 'Missing required request metadata');
  }
  const expectedName = body.method === 'tools/call' ? body.params.name : undefined;
  if (req.headers['mcp-protocol-version'] !== meta[versionKey] || req.headers['mcp-method'] !== body.method ||
    (expectedName !== undefined && req.headers['mcp-name'] !== expectedName)) return error(400, -32020, 'Header mismatch');
  if (meta[versionKey] !== MODERN_VERSION) return error(400, -32022, 'Unsupported protocol version', { requested: meta[versionKey], supported: [MODERN_VERSION] });
  const accept = req.headers.accept ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return error(406, -32600, 'Accept must include application/json and text/event-stream');
  const respond = (result: object) => res.json({ jsonrpc: '2.0', id, result: { ...result, resultType: 'complete' } });
  try {
    if (body.method === 'server/discover') {
      respond({ supportedVersions: [MODERN_VERSION], capabilities: { tools: {}, ...(events ? { events: {} } : {}) },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'imap-mcp-server', version: '2.1.0' } } });
    } else if (events && body.method === 'events/list') {
      // This catalog has one page; invalid pagination must not silently loop.
      if (body.params.cursor != null) throw new EventError(-32602, 'Invalid events cursor.');
      respond(events.list());
    } else if (events && body.method === 'events/subscribe') respond(await events.subscribe(body.params, req.auth!));
    else if (events && body.method === 'events/unsubscribe') respond(events.unsubscribe(body.params, req.auth!));
    else if (body.method === 'ping') respond({});
    else if (body.method === 'tools/list' || body.method === 'tools/call') {
      const server = createServer();
      const client = new Client({ name: 'imap-http-adapter', version: '1.0.0' }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', cancel);
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        if (body.method === 'tools/list') respond(await client.listTools({ cursor: body.params.cursor }, { signal: controller.signal }));
        else respond(await client.callTool({ name: body.params.name, arguments: body.params.arguments }, undefined, { signal: controller.signal }));
      } finally {
        res.off('close', cancel);
        await client.close();
        await server.close();
      }
    } else return error(404, -32601, 'Method not found');
  } catch (cause) {
    if (cause instanceof EventError) return error(200, cause.code, cause.message, cause.data);
    if (cause instanceof McpError && [-32601, -32602].includes(cause.code)) return error(cause.code === -32601 ? 404 : 200, cause.code, 'Invalid tool request');
    return error(500, -32603, 'Internal server error');
  }
  return true;
}
