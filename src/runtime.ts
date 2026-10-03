import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from './services/account-manager.js';
import { ImapService } from './services/imap-service.js';
import { SmtpService } from './services/smtp-service.js';
import { SpamService } from './services/spam-service.js';
import { registerTools } from './tools/index.js';
import { readMonitorConfig } from './monitoring/config.js';
import type { MailMonitor } from './monitoring/monitor.js';
import type { MailEvents } from './monitoring/events.js';
import path from 'node:path';
import os from 'node:os';

// Stateless requests get separate MCP servers but share storage/connections.
export async function createRuntime() {
  const accountManager = new AccountManager();
  const imapService = new ImapService();
  const smtpService = new SmtpService();
  const spamService = new SpamService();
  imapService.setAccountManager(accountManager);
  const config = readMonitorConfig();
  let monitor: MailMonitor | undefined;
  let events: MailEvents | undefined;
  if (config.enabled) {
    const [{ MonitorStore }, { MailMonitor }, { MailEvents }] = await Promise.all([
      import('./monitoring/state.js'), import('./monitoring/monitor.js'), import('./monitoring/events.js'),
    ]);
    const store = new MonitorStore(process.env.IMAP_MCP_CONFIG_DIR || path.join(os.homedir(), '.imap-mcp'));
    monitor = new MailMonitor(store, accountManager, config);
    events = new MailEvents(monitor);
  }
  return {
    events,
    startMonitoring() { if (monitor && events) monitor.start(() => events!.deliver()); },
    async stopMonitoring() { await monitor?.stop(); },
    createServer() {
      const server = new McpServer({ name: 'imap-mcp-server', version: '2.1.0' });
      registerTools(server, imapService, accountManager, smtpService, spamService, monitor);
      return server;
    },
    async close() {
      await monitor?.stop();
      monitor?.store.close();
      smtpService.disconnectAll();
      await imapService.disconnectAll();
    },
  };
}
