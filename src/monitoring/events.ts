import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { MailMonitor, accountFingerprint } from './monitor.js';
import { callbackUrl, signingKey, postWebhook, webhookSignature, type WebhookPost } from './webhook.js';
import type { MailEvent, Subscription } from './state.js';
import { EventError } from './event-error.js';

const argumentsSchema = z.object({ accountId: z.string().min(1).max(128), folder: z.string().min(1).max(1024).default('INBOX') }).strict();
const deliverySchema = z.object({ mode: z.literal('webhook'), url: z.string().max(4096), secret: z.string().max(100) }).strict();
const subscribeSchema = z.object({ name: z.literal('email.arrived'), arguments: argumentsSchema,
  delivery: deliverySchema, ttlMs: z.number().int().positive().nullable().optional(), cursor: z.null().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();
const unsubscribeSchema = z.object({ name: z.literal('email.arrived'), arguments: argumentsSchema,
  delivery: deliverySchema.omit({ secret: true }), _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();

export class MailEvents {
  private readonly owner = randomUUID();
  constructor(readonly monitor: MailMonitor, private post: WebhookPost = postWebhook) {}
  list() {
    return { events: [{ name: 'email.arrived', description: 'IMAP messages newly discovered while this account/folder subscription is active. Subscribing or renewing after expiry does not notify about previously pending mail. Read pending emails and acknowledge UIDs after processing.',
      delivery: ['webhook'], inputSchema: {
        type: 'object', properties: { accountId: { type: 'string', description: 'Configured account ID from imap_list_accounts.' },
          folder: { type: 'string', description: 'Configured monitored folder; defaults to INBOX.', default: 'INBOX' } },
        required: ['accountId'], additionalProperties: false,
      }, payloadSchema: {
        type: 'object', properties: { accountId: { type: 'string' }, folder: { type: 'string' }, uidValidity: { type: 'string' },
          uidRanges: { type: 'array', items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 } },
          reason: { type: 'string', enum: ['arrival', 'reset'] } },
        required: ['accountId', 'folder', 'uidValidity', 'uidRanges', 'reason'], additionalProperties: false,
      } }] };
  }
  private principal(auth: AuthInfo) {
    if (typeof auth.extra?.sub !== 'string' || !auth.expiresAt || auth.expiresAt * 1000 <= Date.now()) throw new EventError(-32001, 'Authorization expired.');
    // Bind both subject and OAuth application. No access token is persisted.
    return createHash('sha256').update(JSON.stringify([auth.extra.sub, auth.clientId])).digest('hex');
  }
  private id(owner: string, accountId: string, folder: string, url: string) {
    return `sub_${createHash('sha256').update(JSON.stringify([owner, url, 'email.arrived', { accountId, folder }])).digest('hex')}`;
  }
  private headers(sub: Subscription, id: string, body: string) {
    const seconds = Math.floor(Date.now() / 1000);
    const signatures = [webhookSignature(sub.secret, id, seconds, body)];
    if (sub.previousSecret && (sub.rotateUntil ?? 0) > Date.now()) signatures.push(webhookSignature(sub.previousSecret, id, seconds, body));
    return { 'webhook-id': id, 'webhook-timestamp': String(seconds), 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': sub.id };
  }
  async subscribe(params: unknown, auth: AuthInfo) {
    const parsed = subscribeSchema.safeParse(params);
    if (!parsed.success) throw new EventError(-32602, 'Invalid event subscription parameters.');
    const { arguments: args, delivery, ttlMs } = parsed.data;
    const owner = this.principal(auth);
    const account = this.monitor.target(args.accountId, args.folder);
    let url: string;
    try { url = callbackUrl(delivery.url).href; signingKey(delivery.secret); }
    catch { throw new EventError(-32602, 'Invalid webhook URL or signing secret.'); }
    const id = this.id(owner, args.accountId, args.folder, url);
    const store = this.monitor.store;
    // Cross-process serialization of callback verification and refresh.
    const lease = `subscribe:${id}`;
    if (!store.lease(lease, this.owner, 30000)) throw new EventError(-32015, 'Subscription is being verified; retry.', { reason: 'timeout' });
    try {
      const existing = store.subscription(id);
      const now = Date.now();
      const expires = Math.min(now + Math.min(ttlMs ?? 3600000, 3600000), auth.expiresAt! * 1000);
      const sub: Subscription = { id, owner, accountId: args.accountId, folder: args.folder, fingerprint: accountFingerprint(account),
        url, secret: delivery.secret, expires };
      if (existing && existing.secret !== sub.secret && existing.expires > now) {
        sub.previousSecret = existing.secret; sub.rotateUntil = now + 60000;
      }
      // Reuse a verification only for the same principal, destination, key and
      // mailbox identity within the granted (at most one-hour) authorization.
      const verified = existing && existing.expires > now && existing.secret === sub.secret && existing.fingerprint === sub.fingerprint;
      if (!verified) {
        const challenge = randomUUID();
        const body = JSON.stringify({ type: 'verification', challenge });
        let response: Awaited<ReturnType<WebhookPost>>;
        try { response = await this.post(url, body, this.headers(sub, `verify_${randomUUID()}`, body)); }
        catch { throw new EventError(-32015, 'Callback verification failed.', { reason: 'timeout' }); }
        let echoed: unknown;
        try { echoed = JSON.parse(response.body).challenge; } catch { /* invalid response */ }
        if (response.status < 200 || response.status >= 300 || typeof echoed !== 'string' ||
          Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) || !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) {
          throw new EventError(-32015, 'Callback verification failed.', { reason: 'challenge_failed' });
        }
      }
      if (accountFingerprint(this.monitor.target(args.accountId, args.folder)) !== sub.fingerprint) throw new EventError(-32602, 'Account changed during subscription.');
      if (sub.expires <= Date.now()) throw new EventError(-32001, 'Authorization expired during callback verification.');
      store.transaction(() => {
        const current = store.subscription(id);
        const count = Number(store.db.prepare('SELECT count(*) AS n FROM subscriptions').get()!.n);
        if (!current && count >= 1000) throw new EventError(-32602, 'Subscription limit reached.');
        // Only an uninterrupted subscription to the same mailbox retains its
        // deliveries. Expired/replaced subscriptions start a fresh window,
        // even when their deterministic ID matches an earlier subscription.
        if (!current || current.expires <= Date.now() || current.fingerprint !== sub.fingerprint) store.removeSubscription(id);
        store.saveSubscription(sub);
      });
      this.monitor.wake();
      return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    } finally { store.release(lease, this.owner); }
  }
  unsubscribe(params: unknown, auth: AuthInfo) {
    const parsed = unsubscribeSchema.safeParse(params);
    if (!parsed.success) throw new EventError(-32602, 'Invalid unsubscribe parameters.');
    const owner = this.principal(auth);
    let url: string;
    try { url = callbackUrl(parsed.data.delivery.url).href; } catch { throw new EventError(-32602, 'Invalid callback URL.'); }
    const { accountId, folder } = parsed.data.arguments;
    const id = this.id(owner, accountId, folder, url);
    this.monitor.store.transaction(() => this.monitor.store.removeSubscription(id));
    return {};
  }
  async deliver() {
    const store = this.monitor.store;
    store.transaction(() => {
      store.db.prepare('DELETE FROM outbox WHERE subscription IN (SELECT id FROM subscriptions WHERE expires<=?)').run(Date.now());
      store.db.prepare('DELETE FROM subscriptions WHERE expires<=?').run(Date.now());
    });
    // Bound outbound work per scheduler cycle; no busy retry loops.
    const rows = store.db.prepare('SELECT * FROM outbox WHERE due<=? AND lease<=? AND failed=0 ORDER BY rowid LIMIT 10').all(Date.now(), Date.now());
    for (const row of rows) {
      const lease = `delivery:${row.id}`;
      if (!store.lease(lease, this.owner, 20000)) continue;
      try {
        // A different worker may have delivered/unsubscribed since the SELECT.
        if (!store.db.prepare('SELECT id FROM outbox WHERE id=?').get(row.id)) continue;
        const sub = store.subscription(row.subscription as string);
        const event: MailEvent = JSON.parse(row.event as string);
        let valid = !!sub && sub.expires > Date.now();
        try {
          valid = valid && accountFingerprint(this.monitor.target(sub!.accountId, sub!.folder)) === sub!.fingerprint;
        } catch { valid = false; }
        if (!valid) {
          store.transaction(() => { if (sub) store.removeSubscription(sub.id); else store.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id); });
          continue;
        }
        if (store.get(sub!.accountId, sub!.folder)?.uidValidity !== event.data.uidValidity) {
          // A reset invalidates this old event, not the subscription to the folder.
          store.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id);
          continue;
        }
        const body = row.event as string;
        let status = 503;
        try { status = (await this.post(sub!.url, body, this.headers(sub!, event.eventId, body))).status; } catch { /* bounded retry */ }
        if (status >= 200 && status < 300) store.db.prepare('DELETE FROM outbox WHERE id=?').run(row.id);
        else if (status === 410) store.transaction(() => store.removeSubscription(sub!.id));
        else {
          const attempts = Number(row.attempts) + 1;
          const terminal = status === 413 || (status >= 400 && status < 500 && status !== 408 && status !== 429) || attempts >= 8;
          store.db.prepare('UPDATE outbox SET attempts=?,due=?,failed=? WHERE id=?').run(attempts, Date.now() + Math.min(3600000, 1000 * 2 ** attempts), terminal ? 1 : 0, row.id);
          if (terminal) console.error('[imap-mcp] Event delivery failed; pending mail remains available.');
        }
      } finally { store.release(lease, this.owner); }
    }
  }
}
