import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapMonitorSource } from '../src/monitoring/imap-source.js';
import type { FolderState } from '../src/monitoring/state.js';

const mock = vi.hoisted(() => ({
  status: vi.fn(), lock: vi.fn(), fetch: vi.fn(), fetchOne: vi.fn(), release: vi.fn(), connect: vi.fn(), close: vi.fn(),
  mailbox: { uidValidity: 111n, uidNext: 10 }, options: undefined as any,
}));
vi.mock('imapflow', () => ({ ImapFlow: class {
  constructor(options: unknown) { mock.options = options; }
  get mailbox() { return mock.mailbox; }
  connect = mock.connect; close = mock.close; status = mock.status;
  getMailboxLock = mock.lock; fetch = mock.fetch; fetchOne = mock.fetchOne; on() {}
} }));
const account = { id: 'a', name: 'Test', host: 'imap.test', port: 993, user: 'u', password: 'secret', tls: true };
const previous: FolderState = { fingerprint: 'f', uidValidity: '111', nextUid: 10, pending: [], lastSuccess: '2026-10-01T00:00:00Z', lastResult: 'baseline' };
beforeEach(() => {
  vi.clearAllMocks(); mock.connect.mockResolvedValue(undefined);
  mock.status.mockResolvedValue({ uidValidity: 111n, uidNext: 10 });
  mock.mailbox = { uidValidity: 111n, uidNext: 10 };
  mock.lock.mockResolvedValue({ release: mock.release });
  mock.fetch.mockImplementation(async function* () {});
});

describe('resource-efficient IMAP monitoring', () => {
  it('uses only STATUS for the baseline and unchanged mailbox, closes the socket and disables idle', async () => {
    const source = new ImapMonitorSource();
    expect(await source.scan(account, 'INBOX', undefined, 'baseline')).toMatchObject({ baseline: true, nextUid: 10 });
    expect(await source.scan(account, 'INBOX', previous, 'baseline')).toMatchObject({ baseline: false, uids: [] });
    expect(mock.lock).not.toHaveBeenCalled(); expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.options).toMatchObject({ disableAutoIdle: true, logger: false });
    expect(mock.close).toHaveBeenCalledTimes(2);
  });
  it('detects new UIDs with read-only bounded UID FETCH even when message counts stay unchanged', async () => {
    mock.status.mockResolvedValue({ uidValidity: 111n, uidNext: 13, messages: 2 });
    mock.mailbox.uidNext = 13;
    mock.fetch.mockImplementation(async function* () { yield { uid: 10 }; yield { uid: 12 }; });
    const result = await new ImapMonitorSource().scan(account, 'INBOX', previous, 'baseline');
    expect(result).toMatchObject({ uids: [10, 12], nextUid: 13 });
    expect(mock.lock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(mock.fetch).toHaveBeenCalledWith('10:12', { uid: true }, { uid: true });
    expect(mock.release).toHaveBeenCalled();
  });
  it('handles UIDVALIDITY reset and a change between STATUS and EXAMINE', async () => {
    mock.status.mockResolvedValue({ uidValidity: 111n, uidNext: 12 });
    mock.mailbox = { uidValidity: 222n, uidNext: 3 };
    mock.fetch.mockImplementation(async function* () { yield { uid: 1 }; yield { uid: 2 }; });
    expect(await new ImapMonitorSource().scan(account, 'INBOX', previous, 'baseline')).toMatchObject({ uidValidity: '222', reset: true, uids: [1, 2] });
    expect(mock.fetch).toHaveBeenCalledWith('1:2', { uid: true }, { uid: true });
  });
  it('does not request a reversed range for an empty reset and filters out-of-range server replies', async () => {
    mock.status.mockResolvedValue({ uidValidity: 222n, uidNext: 1 });
    mock.mailbox = { uidValidity: 222n, uidNext: 1 };
    expect(await new ImapMonitorSource().scan(account, 'INBOX', previous, 'baseline')).toMatchObject({ nextUid: 1, uids: [] });
    expect(mock.fetch).not.toHaveBeenCalled();
    mock.status.mockResolvedValue({ uidValidity: 111n, uidNext: 11 }); mock.mailbox = { uidValidity: 111n, uidNext: 11 };
    mock.fetch.mockImplementation(async function* () { yield { uid: 9 }; yield { uid: 10 }; yield { uid: 11 }; });
    expect(await new ImapMonitorSource().scan(account, 'INBOX', previous, 'baseline')).toMatchObject({ uids: [10] });
  });
  it('bounds backlog work and leaves a precise continuation cursor', async () => {
    mock.status.mockResolvedValue({ uidValidity: 111n, uidNext: 1000000 }); mock.mailbox.uidNext = 1000000;
    expect(await new ImapMonitorSource().scan(account, 'INBOX', undefined, 'existing')).toMatchObject({ nextUid: 10001, caughtUp: false });
    expect(mock.fetch).toHaveBeenCalledWith('1:10000', { uid: true }, { uid: true });
  });
  it('fails closed on missing metadata, UIDNEXT regression and fetch errors and releases locks', async () => {
    const source = new ImapMonitorSource();
    mock.status.mockResolvedValue({});
    await expect(source.scan(account, 'INBOX', previous, 'baseline')).rejects.toThrow('metadata');
    mock.status.mockResolvedValue({ uidValidity: 111n, uidNext: 9 }); mock.mailbox.uidNext = 9;
    await expect(source.scan(account, 'INBOX', previous, 'baseline')).rejects.toThrow('regressed');
    mock.status.mockResolvedValue({ uidValidity: 111n, uidNext: 12 }); mock.mailbox.uidNext = 12;
    mock.fetch.mockImplementation(async function* () { yield { uid: 10 }; throw new Error('fetch failed'); });
    await expect(source.scan(account, 'INBOX', previous, 'baseline')).rejects.toThrow('fetch failed');
    expect(mock.release).toHaveBeenCalledTimes(2);
  });
  it('checks mailbox generation before body fetching and reports expunged pending mail', async () => {
    const source = new ImapMonitorSource();
    await expect(source.read(account, 'INBOX', '222', 10, 100)).rejects.toThrow('UIDVALIDITY');
    expect(mock.fetchOne).not.toHaveBeenCalled();
    mock.fetchOne.mockResolvedValue(false);
    expect(await source.read(account, 'INBOX', '111', 10, 100)).toMatchObject({ vanished: true, uid: 10 });
  });
});
