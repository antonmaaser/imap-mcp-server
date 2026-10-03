import { createServer, type Socket, type AddressInfo } from 'node:net';

export interface FixtureMailbox {
  uidValidity: number;
  uidNext: number;
  messages: Map<number, string>;
}

// Minimal IMAP4rev1 peer for wire-level integration tests. Authentication and
// synthetic MIME bytes stay in memory; command evidence contains neither.
export async function startImapFixture() {
  const mailboxes = new Map<string, FixtureMailbox>();
  const commands: { user: string; command: string; range?: string; body?: boolean }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let user = '';
    let input = '';
    let selected = false;
    let authTag = '';
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] Isolated fixture ready\r\n');
    const authenticated = (tag: string, encoded: string) => {
      user = Buffer.from(encoded, 'base64').toString('utf8').split('\0')[1] ?? '';
      if (!mailboxes.has(user)) socket.write(`${tag} NO Authentication failed\r\n`);
      else socket.write(`${tag} OK Authenticated\r\n`);
    };
    const run = (line: string) => {
      if (authTag) { const tag = authTag; authTag = ''; authenticated(tag, line); return; }
      const match = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
      if (!match) { socket.destroy(); return; }
      const [, tag, verb, args = ''] = match;
      const command = verb.toUpperCase();
      const mailbox = mailboxes.get(user);
      commands.push({ user, command });
      const ok = (text = 'Completed') => socket.write(`${tag} OK ${text}\r\n`);
      if (command === 'CAPABILITY') {
        socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n'); ok();
      } else if (command === 'AUTHENTICATE') {
        const encoded = /^PLAIN\s+(\S+)/i.exec(args)?.[1];
        if (encoded) authenticated(tag, encoded);
        else { authTag = tag; socket.write('+ \r\n'); }
      } else if (command === 'LOGIN') {
        user = /^(?:"([^"]*)"|(\S+))/.exec(args)?.slice(1).find(Boolean) ?? '';
        if (mailboxes.has(user)) ok('Authenticated'); else socket.write(`${tag} NO Authentication failed\r\n`);
      } else if (command === 'LIST' || command === 'LSUB') {
        socket.write(`* ${command} (\\HasNoChildren) "/" "INBOX"\r\n`); ok();
      } else if (command === 'STATUS' && mailbox) {
        socket.write(`* STATUS "INBOX" (UIDNEXT ${mailbox.uidNext} UIDVALIDITY ${mailbox.uidValidity})\r\n`); ok();
      } else if (command === 'EXAMINE' && mailbox) {
        selected = true;
        socket.write(`* FLAGS (\\Seen)\r\n* ${mailbox.messages.size} EXISTS\r\n* 0 RECENT\r\n` +
          `* OK [UIDVALIDITY ${mailbox.uidValidity}] Validity\r\n* OK [UIDNEXT ${mailbox.uidNext}] Next\r\n` +
          `* OK [PERMANENTFLAGS ()] No writable flags\r\n${tag} OK [READ-ONLY] Selected\r\n`);
      } else if (command === 'UID' && selected && mailbox) {
        const fetch = /^FETCH (\S+) (.*)$/i.exec(args);
        if (!fetch) { socket.write(`${tag} BAD Only FETCH is supported\r\n`); return; }
        const [, range, query] = fetch;
        const includeBody = /BODY(?:\.PEEK)?\[\]/i.test(query);
        commands.at(-1)!.range = range;
        commands.at(-1)!.body = includeBody;
        const [first, last = first] = range.split(':').map(Number);
        const messages = [...mailbox.messages].sort((a, b) => a[0] - b[0]);
        messages.forEach(([uid, source], index) => {
          if (uid < first || uid > last) return;
          if (includeBody) {
            const bytes = Buffer.from(source);
            socket.write(`* ${index + 1} FETCH (UID ${uid} BODY[] {${bytes.length}}\r\n`);
            socket.write(bytes); socket.write(')\r\n');
          } else socket.write(`* ${index + 1} FETCH (UID ${uid})\r\n`);
        });
        ok();
      } else if (command === 'NOOP' || command === 'CLOSE') { selected = false; ok(); }
      else if (command === 'LOGOUT') { socket.end(`* BYE Closing\r\n${tag} OK Logged out\r\n`); }
      else socket.write(`${tag} BAD Unsupported fixture command\r\n`);
    };
    socket.on('data', data => {
      input += data.toString('utf8');
      let end: number;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 2); run(line);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: (server.address() as AddressInfo).port, mailboxes, commands,
    get activeConnections() { return sockets.size; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
