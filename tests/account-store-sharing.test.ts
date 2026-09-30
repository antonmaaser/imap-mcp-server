import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AccountManager } from '../src/services/account-manager.js';
import { accountTools } from '../src/tools/account-tools.js';

const input = { name: 'Work', host: 'imap.example.test', port: 993, user: 'me@example.test', password: 'test-password', tls: true,
  smtp: { host: 'smtp.example.test', port: 587, secure: false, user: 'smtp-user', password: 'smtp-test-password' } };
let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-shared-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('shared account persistence', () => {
  it('reloads host edits for lists, name lookups and MCP updates without losing accounts', async () => {
    const host = new AccountManager(directory);
    const container = new AccountManager(directory);
    const original = await host.addAccount(input);
    expect(container.getAllAccounts()).toHaveLength(1);
    const second = await host.addAccount({ ...input, name: 'Personal' });
    await container.updateAccount(original.id, { name: 'Renamed' });
    expect(host.getAllAccounts()).toHaveLength(2);
    expect(host.getAccountByName('Renamed')?.id).toBe(original.id);
    await host.removeAccount(second.id);
    expect(container.getAllAccounts()).toHaveLength(1);
  });
  it('serializes concurrent writers across manager instances', async () => {
    const writers = Array.from({ length: 10 }, () => new AccountManager(directory));
    await Promise.all(writers.map((store, index) => store.addAccount({ ...input, name: `Account ${index}` })));
    expect(new AccountManager(directory).getAllAccounts()).toHaveLength(10);
    expect((await fs.readdir(directory)).sort()).toEqual(['.key', 'accounts.json']);
  });
  it('retains encrypted SMTP passwords when only SMTP host changes, and handles empty placeholders', async () => {
    const store = new AccountManager(directory);
    const account = await store.addAccount(input);
    await store.updateAccount(account.id, { smtp: { host: 'new.example.test', port: 587, secure: false } });
    expect(store.getAccount(account.id)?.smtp?.password).toBe(input.smtp.password);
    await store.updateAccount(account.id, { smtp: { host: 'new.example.test', port: 587, secure: false, password: '' } });
    expect(store.getAccount(account.id)?.smtp?.password).toBe('');
    const raw = await fs.readFile(path.join(directory, 'accounts.json'), 'utf8');
    expect(raw).not.toContain(input.password);
    expect(raw).not.toContain(input.smtp.password);
  });
  it('MCP SMTP edits never persist environment-managed usernames/passwords', async () => {
    const initial = new AccountManager(directory);
    const account = await initial.addAccount({ ...input, smtp: { ...input.smtp, user: '', password: '' } });
    process.env.IMAP_MCP_ACCOUNT_WORK_SMTP_USERNAME = 'runtime-test-user';
    process.env.IMAP_MCP_ACCOUNT_WORK_SMTP_PASSWORD = 'runtime-test-password';
    const running = new AccountManager(directory);
    let handler: Function;
    accountTools({ registerTool(name: string, _schema: unknown, callback: Function) {
      if (name === 'imap_update_account') handler = callback;
    } } as any, running, {} as any, { disconnect() {} } as any);
    await handler!({ accountId: account.id, smtpHost: 'changed.example.test' });
    const stored = new AccountManager(directory).getAccount(account.id);
    expect(stored?.smtp?.user).toBe('');
    expect(stored?.smtp?.password).toBe('');
    expect(running.getAccount(account.id)?.smtp?.user).toBe('runtime-test-user');
    const raw = await fs.readFile(path.join(directory, 'accounts.json'), 'utf8');
    expect(raw).not.toContain('runtime-test-user');
    expect(raw).not.toContain('runtime-test-password');
  });
  it('never overwrites corrupt JSON or logs offending bytes', async () => {
    const store = new AccountManager(directory);
    const raw = '["private-test-value';
    await fs.writeFile(path.join(directory, 'accounts.json'), raw);
    await expect(store.addAccount(input)).rejects.toThrow(/Cannot load accounts.json/);
    expect(await fs.readFile(path.join(directory, 'accounts.json'), 'utf8')).toBe(raw);
    expect(() => store.getAllAccounts()).toThrow(/Cannot load accounts.json/);
    expect((await fs.readdir(directory))).not.toContain('.accounts.lock');
  });
  it('refuses to replace a lost or malformed encryption key', async () => {
    const store = new AccountManager(directory);
    await store.addAccount(input);
    await fs.unlink(path.join(directory, '.key'));
    expect(() => new AccountManager(directory)).toThrow(/original key/);
    await fs.writeFile(path.join(directory, '.key'), 'bad-key');
    expect(() => new AccountManager(directory)).toThrow(/original encryption key/);
    expect(await fs.readFile(path.join(directory, '.key'), 'utf8')).toBe('bad-key');
  });
  it('uses IMAP_MCP_CONFIG_DIR without changing the home directory', async () => {
    const previous = process.env.IMAP_MCP_CONFIG_DIR;
    process.env.IMAP_MCP_CONFIG_DIR = directory;
    try {
      await new AccountManager().addAccount(input);
      expect(new AccountManager(directory).getAllAccounts()).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.IMAP_MCP_CONFIG_DIR;
      else process.env.IMAP_MCP_CONFIG_DIR = previous;
    }
  });
});
