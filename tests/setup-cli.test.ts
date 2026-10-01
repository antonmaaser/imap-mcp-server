import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountManager } from '../src/services/account-manager.js';
import { accountFromInput, accountUpdatesFromInput, parseAccountInput, requiredCredentialVariables, stripAccountSecrets } from '../src/cli/account-config.js';
import { initializeDeployment } from '../src/cli/deployment.js';
import { setupClaudeIntegration } from '../src/setup.js';
import { getProviderByEmail } from '../src/providers/email-providers.js';

const exec = promisify(execFile);
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-cli-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('CLI replaces account wizard logic', () => {
  it('uses provider presets for IMAP and SMTP with custom username and From address', () => {
    expect(accountFromInput({ email: 'me@gmail.com', imapUsername: 'custom-login', password: 'test-password' })).toMatchObject({
      name: 'me@gmail.com', host: 'imap.gmail.com', port: 993, tls: true, user: 'custom-login', email: 'me@gmail.com',
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    });
    expect(accountFromInput({ email: 'me@outlook.com', password: 'test-password' }).smtp?.secure).toBe(false);
    expect(getProviderByEmail('me@notgmail.com')).toBeUndefined();
  });
  it('supports all four environment placeholders with shared variable names', () => {
    const input = { name: 'Work Gmail', email: 'me@gmail.com', imapUsernameFromEnv: true, imapPasswordFromEnv: true,
      smtpUsernameFromEnv: true, smtpPasswordFromEnv: true };
    const account = accountFromInput(input);
    expect(account.user).toBe(''); expect(account.password).toBe('');
    expect(account.smtp?.user).toBe(''); expect(account.smtp?.password).toBe('');
    expect(requiredCredentialVariables(input, account.name)).toEqual([
      'IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_USERNAME', 'IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD',
      'IMAP_MCP_ACCOUNT_WORK_GMAIL_SMTP_USERNAME', 'IMAP_MCP_ACCOUNT_WORK_GMAIL_SMTP_PASSWORD',
    ]);
  });
  it('preserves custom settings, supports no SMTP, Sent override, BCC and STARTTLS', () => {
    const account = accountFromInput({ name: 'Custom', email: 'me@example.test', host: 'mail.example.test', port: 143,
      tls: false, allowStartTLS: false, password: 'test-password', smtp: null, saveToSent: false,
      sentFolder: 'Gesendet', defaultBcc: ['archive@example.test'] });
    expect(account).toMatchObject({ port: 143, tls: false, allowStartTLS: false, saveToSent: false, sentFolder: 'Gesendet', defaultBcc: ['archive@example.test'] });
    expect(account.smtp).toBeUndefined();
  });
  it('retains omitted fields during edit and supports clearing overrides', () => {
    expect(accountUpdatesFromInput({ name: 'New name' })).toEqual({ name: 'New name' });
    expect(accountUpdatesFromInput({ sentFolder: '', defaultBcc: [], smtp: null })).toEqual({ sentFolder: undefined, defaultBcc: undefined, smtp: undefined });
    expect(accountUpdatesFromInput({ imapPasswordFromEnv: true, smtpPasswordFromEnv: true })).toEqual({ password: '', smtp: { password: '' } });
  });
  it.each([{ email: 'bad', password: 'private-test-value' }, { email: 'me@example.test', host: '', password: 'private-test-value' },
    { email: 'me@gmail.com', password: 'private-test-value', port: 70000 }, { password: 123, unexpected: 'private-test-value' }])('rejects invalid input without echoing values', input => {
    try { accountFromInput(input); throw new Error('Should have rejected input'); }
    catch (error) { expect((error as Error).message).not.toContain('private-test-value'); }
    expect(() => accountFromInput(input)).toThrow();
  });
  it('never returns account passwords in CLI list output', () => {
    const account = { ...accountFromInput({ email: 'me@gmail.com', password: 'test-password', smtp: { host: 'smtp.test', password: 'smtp-test-password' } }), id: 'test' };
    const raw = JSON.stringify(stripAccountSecrets(account));
    expect(raw).not.toContain('test-password');
    expect(raw).not.toContain('smtp-test-password');
  });
});

describe('deployment initialization and CLI execution', () => {
  const options = () => ({ configDir: path.join(dir, 'config'), downloadDir: path.join(dir, 'downloads'), envFile: path.join(dir, '.env'), uid: 1000, gid: 1000 });
  it('creates secure shared files before a build and preserves existing env/accounts on rerun', async () => {
    const result = await initializeDeployment(options());
    expect(result.createdEnv).toBe(true);
    const store = new AccountManager(result.configDir);
    await store.addAccount(accountFromInput({ email: 'me@gmail.com', password: 'test-password' }));
    expect(await fs.readdir(result.configDir)).not.toContain('bearer-token');
    expect(await fs.readFile(result.envFile, 'utf8')).toContain('IMAP_MCP_OAUTH_SCOPES=\"imap:access\"');
    const key = await fs.readFile(path.join(result.configDir, '.key'), 'utf8');
    await fs.appendFile(result.envFile, 'IMAP_MCP_READ_ONLY=true\n');
    expect((await initializeDeployment(options())).createdEnv).toBe(false);
    expect(await fs.readFile(path.join(result.configDir, '.key'), 'utf8')).toBe(key);
    expect(new AccountManager(result.configDir).getAllAccounts()).toHaveLength(1);
    expect(await fs.readFile(result.envFile, 'utf8')).toContain('IMAP_MCP_READ_ONLY=true');
    if (process.platform !== 'win32') {
      expect((await fs.stat(result.envFile)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(result.configDir)).mode & 0o777).toBe(0o700);
    }
  });
  it('writes validated OAuth configuration and rejects partial/unsafe values before touching storage', async () => {
    await expect(initializeDeployment({ ...options(), oauthIssuer: 'https://auth.test/realms/mail' })).rejects.toThrow();
    await expect(fs.stat(options().configDir)).rejects.toThrow();
    const result = await initializeDeployment({ ...options(), oauthIssuer: 'https://auth.test/realms/mail',
      oauthResourceUrl: 'https://mail.test/mcp', oauthScopes: 'imap:access' });
    expect(await fs.readFile(result.envFile, 'utf8')).toContain('IMAP_MCP_OAUTH_ISSUER="https://auth.test/realms/mail"');
    expect(await fs.readFile(result.envFile, 'utf8')).not.toContain('TOKEN_FILE');
  });
  it('generates Claude stdio configuration from the module location and retains unrelated entries', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = path.join(dir, 'claude.json');
    try {
      await fs.writeFile(file, JSON.stringify({ unrelated: true, mcpServers: { other: { command: 'other' } } }));
      await setupClaudeIntegration(dir, file);
      const config = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(config.unrelated).toBe(true); expect(config.mcpServers.other.command).toBe('other');
      expect(config.mcpServers.imap.command).toBe(process.execPath);
      expect(config.mcpServers.imap.args[0]).toBe(path.resolve('dist/index.js'));
      expect(config.mcpServers.imap.env.IMAP_MCP_CONFIG_DIR).toBe(dir);
      expect(config.mcpServers.imap.env.IMAP_MCP_TRANSPORT).toBe('stdio');
    } finally { log.mockRestore(); }
  });
  it('executes the CLI from an unrelated cwd and lists encrypted accounts without secrets', async () => {
    const cli = path.resolve('src/setup.ts');
    const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
    const configDir = path.join(dir, 'config');
    const inputPath = path.join(dir, 'input.json');
    await fs.writeFile(inputPath, JSON.stringify({ name: 'CLI Test', email: 'me@gmail.com', password: 'private-test-password' }));
    const invoke = (...args: string[]) => exec(process.execPath, [tsx, cli, '--config-dir', configDir, ...args], { cwd: dir });
    const init = await invoke('init', '--uid', '1000', '--gid', '1000', '--compose-env-file', path.join(dir, '.env'), '--oauth-issuer', 'https://auth.test/realms/mail', '--oauth-resource-url', 'https://mail.test/mcp');
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toContain('IMAP_MCP_OAUTH_RESOURCE_URL=\"https://mail.test/mcp\"');
    expect(init.stdout).not.toContain('private-test-password');
    const add = await invoke('add', '--input', inputPath);
    expect(add.stdout).toContain('Account added');
    const list = await invoke('list');
    expect(list.stdout).toContain('CLI Test'); expect(list.stdout).not.toContain('private-test-password');
    const account = new AccountManager(configDir).getAllAccounts()[0];
    await fs.writeFile(inputPath, JSON.stringify({ name: 'Renamed', smtp: { host: 'changed.example.test' } }));
    await invoke('edit', account.id, '--input', inputPath);
    const updated = new AccountManager(configDir).getAccount(account.id);
    expect(updated?.password).toBe('private-test-password');
    expect(updated?.smtp?.host).toBe('changed.example.test');
    expect(updated?.name).toBe('Renamed');
    await invoke('remove', account.id);
    expect(JSON.parse((await invoke('list')).stdout)).toEqual([]);
  });
});
