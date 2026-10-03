import { z } from 'zod';

const ruleSchema = z.object({
  account: z.string().min(1),
  folders: z.array(z.string().min(1).max(1024)).min(1).max(100).default(['INBOX']),
  intervalSeconds: z.number().int().min(10).max(86400).optional(),
}).strict();

export function readMonitorConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.IMAP_MCP_POLL_ENABLED === 'true';
  if (env.IMAP_MCP_POLL_ENABLED && !['true', 'false'].includes(env.IMAP_MCP_POLL_ENABLED)) {
    throw new Error('IMAP_MCP_POLL_ENABLED must be true or false.');
  }
  const intervalSeconds = Number(env.IMAP_MCP_POLL_INTERVAL_SECONDS ?? '60');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 86400) {
    throw new Error('IMAP_MCP_POLL_INTERVAL_SECONDS must be an integer from 10 to 86400.');
  }
  let rules: z.infer<typeof ruleSchema>[] | undefined;
  try {
    rules = env.IMAP_MCP_POLL_ACCOUNTS ? z.array(ruleSchema).min(1).max(100).parse(JSON.parse(env.IMAP_MCP_POLL_ACCOUNTS)) : undefined;
  } catch { throw new Error('Invalid IMAP_MCP_POLL_ACCOUNTS configuration.'); }
  const initial = env.IMAP_MCP_POLL_INITIAL ?? 'baseline';
  if (!['baseline', 'existing'].includes(initial)) throw new Error('IMAP_MCP_POLL_INITIAL must be baseline or existing.');
  return { enabled, intervalSeconds, rules, initial: initial as 'baseline' | 'existing' };
}

export type MonitorConfig = ReturnType<typeof readMonitorConfig>;
