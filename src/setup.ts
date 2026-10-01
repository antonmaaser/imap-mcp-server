import { Command } from 'commander';
import dotenv from 'dotenv';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { AccountManager } from './services/account-manager.js';
import { ImapService } from './services/imap-service.js';
import { emailProviders, getProviderByEmail, getProviderById } from './providers/email-providers.js';
import type { ImapAccount } from './types/index.js';
import { accountFromInput, accountUpdatesFromInput, parseAccountInput, requiredCredentialVariables, stripAccountSecrets } from './cli/account-config.js';
import { initializeDeployment } from './cli/deployment.js';
import { readOAuthConfig, createOAuthVerifier, resourceMetadataUrl } from './oauth.js';

async function readInput(filename: string): Promise<unknown> {
  try {
    if (filename !== '-') return JSON.parse(await fs.readFile(filename, 'utf8'));
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) throw new Error();
    }
    return JSON.parse(input);
  } catch { throw new Error('Cannot read setup JSON. Supply a valid JSON object using --input file or --input -.'); }
}

async function promptAccount(existing?: ImapAccount) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive setup requires a terminal. Use --input file or --input - for automation.');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (label: string, fallback = '') => {
    const answer = (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    return answer || fallback;
  };
  const yes = async (label: string, fallback: boolean) => {
    const answer = await ask(`${label} (y/n)`, fallback ? 'y' : 'n');
    if (!['y', 'yes', 'n', 'no'].includes(answer.toLowerCase())) throw new Error('Answer y or n.');
    return ['y', 'yes'].includes(answer.toLowerCase());
  };
  const secret = async (label: string) => {
    process.stdout.write(`${label}: `);
    muted = true;
    try { return await rl.question(''); }
    finally { muted = false; process.stdout.write('\n'); }
  };
  try {
    const email = await ask('Email address', existing?.email || existing?.user);
    const name = await ask('Account name', existing?.name || email);
    const providerId = existing ? undefined : await ask('Provider ID (imap-setup providers lists IDs)', getProviderByEmail(email)?.id || 'custom');
    const provider = providerId ? getProviderById(providerId) : undefined;
    if (providerId && !provider) throw new Error('Unknown provider ID.');
    const host = await ask('IMAP host', existing?.host || provider?.imapHost);
    const port = Number(await ask('IMAP port', String(existing?.port || provider?.imapPort || 993)));
    const tls = await yes('IMAP implicit TLS', existing?.tls ?? (provider?.imapSecurity !== 'STARTTLS'));
    const allowStartTLS = tls ? undefined : await yes('Allow STARTTLS upgrade', existing?.allowStartTLS !== false);
    const imapUsernameFromEnv = await yes('Supply IMAP username via environment', existing?.user === '');
    const imapUsername = imapUsernameFromEnv ? undefined : await ask('IMAP username', existing?.user || email);
    const imapPasswordFromEnv = await yes('Supply IMAP password via environment', existing?.password === '');
    const password = imapPasswordFromEnv ? undefined : await secret(existing ? 'IMAP password (blank keeps current)' : 'IMAP password (hidden)');
    let smtp: Record<string, unknown> | null = null;
    let smtpUsernameFromEnv = false;
    let smtpPasswordFromEnv = false;
    if (await yes('Configure SMTP', Boolean(existing?.smtp || provider?.smtpHost))) {
      const smtpHost = await ask('SMTP host', existing?.smtp?.host || provider?.smtpHost || host);
      const smtpPort = Number(await ask('SMTP port', String(existing?.smtp?.port || provider?.smtpPort || 587)));
      const secure = await yes('SMTP implicit TLS (465; 587 uses STARTTLS)', existing?.smtp?.secure ?? (smtpPort === 465));
      smtpUsernameFromEnv = await yes('Supply SMTP username via environment', existing?.smtp?.user === '');
      const user = smtpUsernameFromEnv ? undefined : await ask('SMTP username (blank inherits IMAP)', existing?.smtp?.user);
      smtpPasswordFromEnv = await yes('Supply SMTP password via environment', existing?.smtp?.password === '');
      const smtpPassword = smtpPasswordFromEnv ? undefined : await secret('SMTP password (blank keeps current/inherits IMAP)');
      smtp = { host: smtpHost, port: smtpPort, secure, ...(user ? { user } : {}), ...(smtpPassword ? { password: smtpPassword } : {}) };
    }
    const saveToSent = await yes('Save outgoing messages to Sent', existing?.saveToSent !== false);
    // Clearing these fields is useful, so do not substitute the existing value.
    const sentFolder = (await rl.question('Sent folder (blank auto-detects): ')).trim();
    const defaultBcc = (await rl.question('Default BCC addresses, comma-separated (blank clears): ')).trim();
    return parseAccountInput({
      email, name, ...(providerId ? { provider: providerId } : {}), host, port, tls, allowStartTLS,
      imapUsername, imapUsernameFromEnv, imapPasswordFromEnv,
      ...((password || !existing) && password !== undefined ? { password } : {}),
      smtp, smtpUsernameFromEnv, smtpPasswordFromEnv, saveToSent, sentFolder, defaultBcc,
    });
  } finally { rl.close(); }
}

export async function setupClaudeIntegration(configDir: string, configPath?: string) {
  const defaultPath = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  const destination = configPath ?? defaultPath;
  let config: Record<string, any> = {};
  try { config = JSON.parse(await fs.readFile(destination, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read existing Claude config; it has not been overwritten.'); }
  const modulePath = fileURLToPath(import.meta.url);
  const serverEntryPath = path.extname(modulePath) === '.ts'
    ? path.resolve(path.dirname(modulePath), '../dist/index.js')
    : path.join(path.dirname(modulePath), 'index.js');
  config.mcpServers = { ...config.mcpServers, imap: {
    command: process.execPath, args: [serverEntryPath],
    env: { IMAP_MCP_TRANSPORT: 'stdio', IMAP_MCP_CONFIG_DIR: path.resolve(configDir) },
  } };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log('Claude Desktop stdio configuration updated. Build the server and restart Claude Desktop.');
}

export async function runSetup(argv = process.argv) {
  dotenv.config({ quiet: true });
  const program = new Command().name('imap-setup').description('Local CLI account and Docker deployment configuration')
    .option('--config-dir <directory>', 'Shared directory containing accounts.json and .key')
    .showHelpAfterError();
  const configDir = (docker = false) => path.resolve(program.opts().configDir || process.env.IMAP_MCP_CONFIG_DIR ||
    (docker ? './.imap-mcp' : path.join(os.homedir(), '.imap-mcp')));
  const manager = () => new AccountManager(configDir());
  program.command('init').description('Prepare Docker persistence and OAuth .env before building; never overwrite an existing .env')
    .option('--oauth-issuer <url>', 'Exact public Keycloak realm issuer URL')
    .option('--oauth-resource-url <url>', 'Canonical public HTTPS MCP endpoint ending in /mcp; also the token audience')
    .option('--oauth-scopes <scopes>', 'Space-separated required OAuth scopes', 'imap:access')
    .option('--oauth-allow-insecure-http', 'Allow HTTP OAuth URLs for isolated testing only')
    .option('--download-dir <directory>', 'Host attachment directory')
    .option('--compose-env-file <file>', 'Compose configuration file', '.env')
    .option('--uid <number>', 'Non-root numeric container user', Number)
    .option('--gid <number>', 'Non-root numeric container group', Number)
    .action(async options => {
      const result = await initializeDeployment({
        configDir: configDir(true), downloadDir: options.downloadDir || process.env.IMAP_MCP_DOWNLOAD_DIR || './downloads',
        envFile: options.composeEnvFile, uid: options.uid, gid: options.gid,
        oauthIssuer: options.oauthIssuer, oauthResourceUrl: options.oauthResourceUrl,
        oauthScopes: options.oauthScopes, oauthAllowInsecureHttp: options.oauthAllowInsecureHttp,
      });
      console.log(`Deployment prepared. Shared accounts directory: ${result.configDir}`);
      console.log('HTTP requires IMAP_MCP_OAUTH_ISSUER and IMAP_MCP_OAUTH_RESOURCE_URL in the deployment .env.');
      console.log(result.createdEnv ? `Created ${result.envFile}.` : `Existing ${result.envFile} preserved; verify its paths and UID/GID match these directories.`);
      console.log('Add accounts with imap-setup --config-dir <directory> add, then docker compose up --build -d.');
    });
  program.command('providers').description('List provider presets without connecting to any service').action(() => {
    console.log(JSON.stringify(emailProviders, null, 2));
  });
  program.command('list').description('List configured accounts without passwords').action(() => {
    console.log(JSON.stringify(manager().getAllAccounts().map(stripAccountSecrets), null, 2));
  });
  program.command('add').description('Add an account using provider presets or custom settings')
    .option('--input <file>', 'Wizard-compatible JSON; - reads stdin without putting secrets in command arguments')
    .action(async options => {
      const input = parseAccountInput(options.input ? await readInput(options.input) : await promptAccount());
      const account = await manager().addAccount(accountFromInput(input));
      console.log(`Account added: ${account.id}`);
      const variables = requiredCredentialVariables(input, account.name);
      if (variables.length) console.log(`Set these runtime variables, then restart: ${variables.join(', ')}`);
    });
  program.command('edit <accountId>').description('Update an existing account; omitted passwords are retained')
    .option('--input <file>', 'Partial wizard-compatible JSON; - reads stdin')
    .action(async (id, options) => {
      const store = manager();
      const existing = store.getAccount(id);
      if (!existing) throw new Error('Account not found. Use imap-setup list.');
      const input = parseAccountInput(options.input ? await readInput(options.input) : await promptAccount(existing));
      const account = await store.updateAccount(id, accountUpdatesFromInput(input));
      console.log(`Account updated: ${account.id}`);
      const variables = requiredCredentialVariables(input, account.name);
      if (variables.length) console.log(`Set these runtime variables, then restart: ${variables.join(', ')}`);
    });
  program.command('remove <accountId>').description('Remove only the explicitly specified local account configuration')
    .action(async id => { await manager().removeAccount(id); console.log('Account removed.'); });
  program.command('test <accountId>').description('Explicitly test IMAP login and folder listing against your mail server')
    .action(async id => {
      const account = manager().getAccount(id);
      if (!account) throw new Error('Account not found. Use imap-setup list.');
      const service = new ImapService();
      try {
        const result = await service.testConnection(account);
        if (!result.success) throw new Error('Connection test failed. Check credentials, environment overrides and provider settings.');
        console.log(JSON.stringify({ success: true, folders: result.folders, messageCount: result.messageCount }, null, 2));
      } finally { await service.disconnectAll(); }
    });
  program.command('oauth-check').description('Validate OAuth environment and contact the configured Keycloak discovery endpoint (no mailbox connection)')
    .action(async () => {
      const config = readOAuthConfig();
      await createOAuthVerifier(config);
      console.log(`OAuth discovery verified. Resource metadata URL: ${resourceMetadataUrl(config)}`);
      console.log('Token issuance, signing-key retrieval and client login still require an end-to-end client test.');
    });
  program.command('claude-config').description('Explicitly configure Claude Desktop for local stdio use (requires npm run build)')
    .action(() => setupClaudeIntegration(configDir()));
  await program.parseAsync(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetup().catch(error => {
    // All local validation errors omit credential values.
    console.error(error instanceof Error ? error.message : 'Setup failed.');
    process.exitCode = 1;
  });
}
