import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createHmac } from 'node:crypto';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const ipv6Public = new BlockList();
ipv6Public.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

export function publicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && ipv6Public.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function callbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
    (url.port && url.port !== '443') || value.length > 4096 ||
    url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('Invalid callback URL.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw new Error('Invalid callback address.');
  return url;
}

export function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('Invalid webhook signing secret.');
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('Invalid webhook signing secret.');
  }
  return key;
}
export function webhookSignature(secret: string, id: string, seconds: number, body: string) {
  return `v1,${createHmac('sha256', signingKey(secret)).update(`${id}.${seconds}.${body}`).digest('base64')}`;
}

export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

// Resolve for every connection and pin that connection to the checked address.
// A separate check followed by ordinary fetch would permit DNS rebinding.
export const postWebhook: WebhookPost = async (value, body, headers) => {
  const url = callbackUrl(value);
  if (Buffer.byteLength(body) > 262144) throw new Error('Webhook payload exceeds 256 KiB.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const expires = Date.now() + 10000;
  let dnsDeadline: ReturnType<typeof setTimeout> | undefined;
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => { dnsDeadline = setTimeout(() => reject(new Error('Callback DNS timed out.')), 10000); }),
    ]);
  } finally { clearTimeout(dnsDeadline); }
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Callback destination is not public.');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', agent: false, headers: {
      ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)),
    }, lookup: ((_host: string, _options: unknown, callback: Function) => {
      // Node may request an array of addresses when autoSelectFamily is enabled.
      if ((_options as { all?: boolean }).all) callback(null, [address]);
      else callback(null, address.address, address.family);
    }) as any }, res => {
      let response = '';
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) req.destroy(new Error('Callback response too large.'));
        else response += chunk.toString('utf8');
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: response }));
    });
    // No redirects; preserve the URL hostname for certificate validation/SNI.
    const deadline = setTimeout(() => req.destroy(new Error('Callback timed out.')), Math.max(1, expires - Date.now()));
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(body);
  });
};
