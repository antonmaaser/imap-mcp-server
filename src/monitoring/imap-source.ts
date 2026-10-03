import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { ImapAccount } from '../types/index.js';
import { assertCredentialsResolved } from '../utils/env-credentials.js';
import { htmlToMarkdown } from '../services/html-to-markdown.js';
import type { FolderState } from './state.js';

export interface ScanResult {
  uidValidity: string; nextUid: number; uids: number[]; baseline: boolean; reset: boolean; caughtUp: boolean;
}
export interface MailSource {
  scan(account: ImapAccount, folder: string, previous: FolderState | undefined, initial: 'baseline' | 'existing'): Promise<ScanResult>;
  read(account: ImapAccount, folder: string, uidValidity: string, uid: number, maxLength: number): Promise<unknown>;
  close(): void;
}

function identity(value: { uidValidity?: bigint | number; uidNext?: number }) {
  const uidValidity = String(value.uidValidity ?? '');
  const uidNext = Number(value.uidNext);
  if (!/^[1-9]\d*$/.test(uidValidity) || BigInt(uidValidity) > 4294967295n ||
    !Number.isInteger(uidNext) || uidNext < 1 || uidNext > 4294967296) {
    throw new Error('Missing or invalid IMAP UID metadata; state was not advanced.');
  }
  return { uidValidity, uidNext };
}

// Dedicated short-lived connections avoid contention with foreground tool calls
// and leave no idle sockets or IMAP IDLE work between polls.
export class ImapMonitorSource implements MailSource {
  private active = new Set<ImapFlow>();
  private async withClient<T>(account: ImapAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    assertCredentialsResolved(account, 'imap');
    const client = new ImapFlow({ host: account.host, port: account.port, secure: account.tls,
      tls: { host: account.host }, ...(account.allowStartTLS === false ? { doSTARTTLS: false } : {}),
      auth: { user: account.user, pass: account.password, loginMethod: account.loginMethod },
      logger: false, disableAutoIdle: true, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    client.on('error', () => {});
    this.active.add(client);
    const deadline = setTimeout(() => client.close(), 45000);
    try {
      await client.connect();
      return await fn(client);
    } finally {
      // A hard close saves a logout round trip and bounds shutdown even on a
      // provider that never answers LOGOUT. All monitoring access is read-only.
      clearTimeout(deadline);
      client.close();
      this.active.delete(client);
    }
  }

  async scan(account: ImapAccount, folder: string, previous: FolderState | undefined, initial: 'baseline' | 'existing'): Promise<ScanResult> {
    return this.withClient(account, async client => {
      const status = identity(await client.status(folder, { uidValidity: true, uidNext: true }));
      if (!previous && initial === 'baseline') {
        return { uidValidity: status.uidValidity, nextUid: status.uidNext, uids: [], baseline: true, reset: false, caughtUp: true };
      }
      if (previous?.uidValidity === status.uidValidity && previous.nextUid === status.uidNext) {
        return { uidValidity: status.uidValidity, nextUid: status.uidNext, uids: [], baseline: false, reset: false, caughtUp: true };
      }
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        if (!client.mailbox) throw new Error('Mailbox is not selected.');
        const snapshot = identity(client.mailbox);
        const reset = !!previous && previous.uidValidity !== snapshot.uidValidity;
        const from = !previous || reset ? 1 : previous.nextUid;
        if (snapshot.uidNext < from) throw new Error('UIDNEXT regressed without UIDVALIDITY changing.');
        // Bound memory and each poll's work, including an explicit initial backlog.
        const nextUid = Math.min(snapshot.uidNext, from + 10000);
        const uids: number[] = [];
        if (nextUid > from) {
          for await (const message of client.fetch(`${from}:${nextUid - 1}`, { uid: true }, { uid: true })) {
            // IMAP treats reversed ranges inclusively; never use n:* or accept
            // out-of-range replies when an empty mailbox races with this fetch.
            if (message.uid >= from && message.uid < nextUid) uids.push(message.uid);
          }
        }
        return { uidValidity: snapshot.uidValidity, nextUid, uids, baseline: false, reset, caughtUp: nextUid === snapshot.uidNext };
      } finally { lock.release(); }
    });
  }

  async read(account: ImapAccount, folder: string, uidValidity: string, uid: number, maxLength: number) {
    return this.withClient(account, async client => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        if (!client.mailbox || identity(client.mailbox).uidValidity !== uidValidity) {
          throw new Error('UIDVALIDITY changed. Poll again and obtain the current pending identifiers.');
        }
        // PEEK is the SDK default; read-only EXAMINE also prevents flag writes.
        const message = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
        if (!message || !message.source) return { accountId: account.id, folder, uidValidity, uid, vanished: true };
        const parsed = await simpleParser(message.source);
        const markdown = parsed.html ? htmlToMarkdown(parsed.html) : (parsed.text ?? '');
        return { accountId: account.id, folder, uidValidity, uid, vanished: false,
          messageId: parsed.messageId, subject: parsed.subject, from: parsed.from?.text,
          to: Array.isArray(parsed.to) ? parsed.to.map(v => v.text) : parsed.to?.text,
          date: parsed.date?.toISOString(), markdownContent: markdown.slice(0, maxLength),
          truncated: markdown.length > maxLength,
          attachments: parsed.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
        };
      } finally { lock.release(); }
    });
  }
  close() { for (const client of this.active) client.close(); }
}
