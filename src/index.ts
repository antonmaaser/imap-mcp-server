import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { createRuntime } from './runtime.js';
import { createHttpApp, readHttpConfig } from './http-server.js';
import { createOAuthVerifier } from './oauth.js';

dotenv.config({ quiet: true });

async function main() {
  const mode = process.env.IMAP_MCP_TRANSPORT ?? 'stdio';
  if (mode !== 'stdio' && mode !== 'http') throw new Error('IMAP_MCP_TRANSPORT must be stdio or http.');
  // Validate auth before touching account files or opening a listener.
  const config = mode === 'http' ? readHttpConfig() : undefined;
  const verifier = config ? await createOAuthVerifier(config.oauth) : undefined;
  const runtime = await createRuntime();
  const closeTransport = config
    ? await new Promise<() => Promise<void>>((resolve, reject) => {
      const listener = createHttpApp(config, runtime.createServer, verifier!, runtime.events).listen(config.port, config.host, error => {
        if (error) { reject(error); return; }
        console.error(`IMAP MCP HTTP server listening on ${config.host}:${config.port}/mcp`);
        resolve(() => new Promise<void>((done) => { listener.close(() => done()); }));
      });
      listener.on('error', reject);
    })
    : await (async () => {
      const server = runtime.createServer();
      await server.connect(new StdioServerTransport());
      console.error('IMAP MCP stdio server started');
      return () => server.close();
    })();
  runtime.startMonitoring();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    // Drain HTTP requests and bound slow mail-server logout.
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    try {
      await runtime.stopMonitoring();
      await closeTransport();
      await runtime.close();
      process.exit(0);
    } catch { process.exit(1); }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(() => {
  console.error('IMAP MCP startup failed. Check transport, authentication, configuration and permissions.');
  process.exit(1);
});
