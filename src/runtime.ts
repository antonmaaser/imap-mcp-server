import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from './services/account-manager.js';
import { ImapService } from './services/imap-service.js';
import { SmtpService } from './services/smtp-service.js';
import { SpamService } from './services/spam-service.js';
import { registerTools } from './tools/index.js';

// Stateless requests get separate MCP servers but share storage/connections.
export function createRuntime() {
  const accountManager = new AccountManager();
  const imapService = new ImapService();
  const smtpService = new SmtpService();
  const spamService = new SpamService();
  imapService.setAccountManager(accountManager);
  return {
    createServer() {
      const server = new McpServer({ name: 'imap-mcp-server', version: '2.1.0' });
      registerTools(server, imapService, accountManager, smtpService, spamService);
      return server;
    },
    async close() {
      smtpService.disconnectAll();
      await imapService.disconnectAll();
    },
  };
}
