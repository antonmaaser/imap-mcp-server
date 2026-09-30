// Uses only temporary test accounts; never contacts an IMAP/SMTP server.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-docker-smoke-'));
const envFile = path.join(temporary, '.env');
const configDir = path.join(temporary, 'config');
const downloadDir = path.join(temporary, 'attachments');
let stage = 'initialization';
const cli = (...args) => { stage = `CLI ${args[0]}`; return exec(process.execPath, [path.join(root, 'dist/setup.js'), '--config-dir', configDir, ...args], { cwd: temporary }); };
const composeArgs = ['compose', '--project-name', `imap-smoke-${process.pid}`, '--env-file', envFile, '-f', path.join(root, 'compose.yaml'), '-f', path.join(temporary, 'override.yaml')];
const compose = (...args) => { stage = `Compose ${args[0]}`; return exec('docker', [...composeArgs, ...args], { cwd: root, maxBuffer: 1024 * 1024 }); };
let started = false;
let client;
try {
  await cli('init', '--download-dir', downloadDir, '--compose-env-file', envFile);
  await fs.appendFile(envFile, 'IMAP_MCP_ENABLED_TOOLS=imap_list_accounts,imap_add_account,imap_update_account,imap_remove_account,imap_upload_file\n');
  const credentials = path.join(temporary, 'credentials.env');
  await fs.writeFile(credentials, 'IMAP_MCP_ACCOUNT_SMOKE_IMAP_USERNAME=runtime-user\nIMAP_MCP_ACCOUNT_SMOKE_IMAP_PASSWORD=runtime-test-password\n', { mode: 0o600 });
  // An ephemeral loopback port avoids disrupting an existing deployment.
  await fs.writeFile(path.join(temporary, 'override.yaml'), `services:\n  imap-mcp:\n    ports: !override\n      - "127.0.0.1::8787"\n    env_file: !override\n      - path: ${credentials}\n        format: raw\n`);
  const inputPath = path.join(temporary, 'input.json');
  await fs.writeFile(inputPath, JSON.stringify({ name: 'Smoke', email: 'test@example.test', host: 'imap.example.test',
    smtp: null, imapUsernameFromEnv: true, imapPasswordFromEnv: true }), { mode: 0o600 });
  await cli('add', '--input', inputPath);
  await compose('config', '--quiet');
  started = true;
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60');
  const portOutput = await compose('port', 'imap-mcp', '8787');
  let base = `http://${portOutput.stdout.trim()}`;
  const status = JSON.parse((await compose('ps', '--format', 'json')).stdout);
  const containerId = status.ID;
  const inspect = JSON.parse((await exec('docker', ['inspect', containerId])).stdout)[0];
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.PortBindings['8787/tcp'][0].HostIp, '127.0.0.1');
  assert.notEqual(inspect.Config.User.split(':')[0], '0');
  const token = (await fs.readFile(path.join(configDir, 'bearer-token'), 'utf8')).trim();
  assert.equal((await fetch(`${base}/mcp`)).status, 401);
  assert.equal((await fetch(`${base}/mcp?access_token=${token}`, { method: 'POST' })).status, 401);
  client = new Client({ name: 'docker-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name, args = {}) => {
    stage = `MCP ${name}`;
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, 'MCP smoke tool failed');
    return JSON.parse(result.content[0].text);
  };
  stage = 'SDK calls';
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
    ['imap_add_account', 'imap_list_accounts', 'imap_remove_account', 'imap_update_account', 'imap_upload_file']);
  const initial = await call('imap_list_accounts');
  const original = initial.accounts[0];
  assert.equal(original.user, 'runtime-user');
  await call('imap_update_account', { accountId: original.id, name: 'Container edit' });
  assert.equal(JSON.parse((await cli('list')).stdout)[0].name, 'Container edit');
  // Host-side additions become visible to the already-running container.
  await fs.writeFile(inputPath, JSON.stringify({ name: 'Host edit', email: 'test@example.test', host: 'imap.example.test', password: 'local-test-password', smtp: null }));
  await cli('add', '--input', inputPath);
  stage = 'host addition visibility';
  assert.equal(JSON.parse((await cli('list')).stdout).length, 2, 'Host store lost an account');
  stage = 'container addition visibility';
  await exec('docker', ['exec', containerId, 'node', '-e', "const fs=require('fs');const p='/data/config/accounts.json';process.exit(fs.existsSync(p)&&JSON.parse(fs.readFileSync(p,'utf8')).length===2?0:1)"]);
  assert.equal((await call('imap_list_accounts')).accounts.length, 2, 'Running MCP did not reload the host addition');
  const added = await call('imap_add_account', { name: 'MCP addition', host: 'imap.example.test', user: 'test', password: 'mcp-test-password' });
  assert.equal(JSON.parse((await cli('list')).stdout).length, 3);
  const upload = await call('imap_upload_file', { filename: 'smoke.txt', content: Buffer.from('attachment persistence').toString('base64') });
  assert.equal(await fs.readFile(path.join(downloadDir, path.relative('/data/attachments', upload.path)), 'utf8'), 'attachment persistence');
  await client.close(); client = undefined;
  await compose('restart');
  // Compose wait verifies restart health without reading any app logs.
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '60');
  base = `http://${(await compose('port', 'imap-mcp', '8787')).stdout.trim()}`;
  stage = 'SDK reconnect';
  client = new Client({ name: 'docker-smoke-restart', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal((await call('imap_list_accounts')).accounts.length, 3);
  await call('imap_remove_account', { accountId: added.accountId });
  assert.equal(JSON.parse((await cli('list')).stdout).length, 2, 'Host store did not reflect removal');
  const store = await fs.readFile(path.join(configDir, 'accounts.json'), 'utf8');
  assert.ok(!store.includes('runtime-test-password') && !store.includes('local-test-password') && !store.includes('mcp-test-password'));
  const logs = (await compose('logs', '--no-color')).stdout;
  assert.ok(!logs.includes(token) && !logs.includes('runtime-test-password') && !logs.includes('local-test-password'));
  const files = (await exec('docker', ['exec', containerId, 'node', '-e', "const fs=require('fs');process.exit(fs.existsSync('/app/.env')||fs.existsSync('/app/public')||fs.existsSync('/app/dist/web')?1:0)"]));
  assert.equal(files.stderr, '');
  console.log('Docker smoke test passed: auth, official SDK, tool gating, shared host/MCP edits, credential overrides, attachments, restart persistence and hardened runtime.');
} catch (error) {
  // Command failures may include environment contents; emit only the stage-neutral message.
  if (error.stack) console.error(`Failure location: ${error.stack.split('\n').find(line => line.includes('docker-smoke-test.mjs:')) ?? ''}`);
  console.error(`Docker smoke test failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : `${error.name}: ${error.code ?? error.cause?.code ?? 'unknown'}`}`);
  if (typeof error.stderr === 'string') {
    const safeLines = error.stderr.split('\n').filter(line => /(?:permission denied|mounts denied|invalid|unhealthy|not found|is not allowed|failed to|must be|error during connect|cannot|Error:)/i.test(line) && !/(?:password|token|secret|accounts\.json)/i.test(line));
    if (safeLines.length) console.error(safeLines.join('\n'));
  }
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  if (started) await compose('down', '--remove-orphans').catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
