import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachmentSavePath } from '../src/utils/attachment-path.js';

let directory: string;
let previous: string | undefined;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-path-'));
  previous = process.env.IMAP_MCP_TRANSPORT;
  process.env.IMAP_MCP_TRANSPORT = 'http';
});
afterEach(async () => {
  if (previous === undefined) delete process.env.IMAP_MCP_TRANSPORT;
  else process.env.IMAP_MCP_TRANSPORT = previous;
  await fs.rm(directory, { recursive: true, force: true });
});
describe('HTTP attachment confinement', () => {
  it('strips sender traversal and accepts nested caller paths inside the directory', () => {
    expect(attachmentSavePath(directory, '../../file.bin')).toBe(path.join(directory, 'file.bin'));
    const nested = path.join(directory, 'subdir', 'file.bin');
    expect(attachmentSavePath(directory, 'file.bin', nested)).toBe(nested);
  });
  it('rejects paths to configuration files and sibling paths with matching prefixes', () => {
    expect(() => attachmentSavePath(directory, 'file', path.join(directory, '..', '.key'))).toThrow(/inside/);
    expect(() => attachmentSavePath(directory, 'file', `${directory}-other/file`)).toThrow(/inside/);
    expect(() => attachmentSavePath(directory, 'file', directory)).toThrow(/inside/);
  });
  it('rejects symlinked parents and targets', async () => {
    await fs.symlink(os.tmpdir(), path.join(directory, 'link'));
    expect(() => attachmentSavePath(directory, 'file', path.join(directory, 'link', 'file'))).toThrow(/symbolic/);
    await fs.writeFile(path.join(directory, 'target'), 'test');
    await fs.symlink(path.join(directory, 'target'), path.join(directory, 'file'));
    expect(() => attachmentSavePath(directory, 'file')).toThrow(/symbolic/);
  });
  it('preserves caller-selected paths for local stdio', () => {
    process.env.IMAP_MCP_TRANSPORT = 'stdio';
    expect(attachmentSavePath(directory, 'file', '/tmp/caller-file')).toBe('/tmp/caller-file');
  });
});
