import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MailMonitor } from '../monitoring/monitor.js';

export function monitorTools(server: McpServer, monitor: MailMonitor) {
  const location = {
    accountId: z.string().min(1).describe('Account ID from imap_list_accounts; must be configured for background monitoring.'),
    folder: z.string().min(1).default('INBOX').describe('Exact monitored folder name; defaults to INBOX.'),
  };
  const generation = z.string().regex(/^[1-9]\d*$/).describe('UIDVALIDITY returned by imap_get_pending_emails. Prevents addressing a reused UID after a mailbox reset.');
  const uid = z.number().int().min(1).max(4294967295).describe('Exact pending IMAP UID from imap_get_pending_emails.');
  const result = async (fn: () => unknown | Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] }; }
    catch { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Monitoring operation failed. Verify the monitored account, folder, UIDVALIDITY and pending UID; retry after the next successful poll.' }) }] }; }
  };
  server.registerTool('imap_get_pending_emails', {
    description: 'List durable pending email UIDs and poll status. Pending means discovered by background polling and not explicitly acknowledged by an MCP client; it is independent of IMAP unread flags. After an email.arrived event, paginate using nextAfterUid, retrieve each email with imap_get_pending_email, then acknowledge successfully processed UIDs. Poll failures retain the previous state and report lastError; an empty list during a failure is not proof that no new mail exists.',
    inputSchema: { ...location,
      afterUid: z.number().int().min(0).max(4294967295).default(0).describe('Pagination cursor: pass nextAfterUid from the preceding page; reset to zero if UIDVALIDITY changes.'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Maximum pending UIDs to return, from 1 to 1000.'),
    }, annotations: { readOnlyHint: true, destructiveHint: false },
  }, ({ accountId, folder, afterUid, limit }) => result(() => monitor.pending(accountId, folder, afterUid, limit)));
  server.registerTool('imap_get_pending_email', {
    description: 'Read the body and attachment metadata of one pending email with a UIDVALIDITY guard and read-only IMAP access. Does not set Seen or acknowledge processing. If vanished=true, it was removed from this mailbox and may be explicitly acknowledged as unavailable. After successful processing use imap_acknowledge_emails. Body and attachment bytes are not cached on disk.',
    inputSchema: { ...location, uidValidity: generation, uid,
      maxContentLength: z.number().int().min(1).max(1000000).default(10000).describe('Maximum Markdown body characters to return. Raise when truncated=true and the full body is needed.'),
    }, annotations: { readOnlyHint: true, destructiveHint: false },
  }, ({ accountId, folder, uidValidity, uid, maxContentLength }) => result(() => monitor.read(accountId, folder, uidValidity, uid, maxContentLength)));
  server.registerTool('imap_acknowledge_emails', {
    description: 'Explicitly acknowledge successful processing of concrete pending UIDs in one mailbox generation. Only removes them from the local pending queue; does not delete mail, move it, or change flags. Reading alone never acknowledges processing. This is shared server state across clients, so acknowledge only after the intended work has completed; repeated acknowledgements are idempotent.',
    inputSchema: { ...location, uidValidity: generation,
      uids: z.array(uid).min(1).max(1000).describe('Concrete UIDs successfully processed, or confirmed vanished. Never infer acknowledgement from unread status.'),
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ accountId, folder, uidValidity, uids }) => result(() => monitor.acknowledge(accountId, folder, uidValidity, uids)));
}
