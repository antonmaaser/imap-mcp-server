import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('retains stdio MCP compatibility, loads dotenv before tool settings and keeps logs off stdout', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-stdio-'));
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const configDir = path.join(directory, 'config');
  try {
    await fs.writeFile(path.join(directory, '.env'), `IMAP_MCP_TRANSPORT=stdio\nIMAP_MCP_CONFIG_DIR=${configDir}\nIMAP_MCP_ENABLED_TOOLS=imap_list_accounts\n`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('src/index.ts')],
      cwd: directory,
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '' },
    });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['imap_list_accounts']);
    const result = await client.callTool({ name: 'imap_list_accounts', arguments: {} });
    expect(JSON.parse((result.content as any)[0].text)).toEqual({ accounts: [] });
    expect((await fs.readdir(configDir))).toEqual(['.key']);
  } finally {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
