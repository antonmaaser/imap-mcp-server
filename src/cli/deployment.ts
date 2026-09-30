import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AccountManager } from '../services/account-manager.js';
import { validateBearerToken } from '../http-server.js';

export async function ensureToken(configDir: string, rotate = false): Promise<string> {
  const tokenPath = path.join(configDir, 'bearer-token');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  if (!rotate) {
    try {
      validateBearerToken((await fs.readFile(tokenPath, 'utf8')).trim());
      await fs.chmod(tokenPath, 0o600);
      return tokenPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot use bearer-token. Check the file, or explicitly rotate it.');
    }
  }
  // Rotation is atomic; Compose recreates the secret mount on force-recreate.
  const temporaryPath = `${tokenPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    if (rotate) await fs.rename(temporaryPath, tokenPath);
    else {
      // Do not overwrite a token concurrently created by another setup process.
      await fs.link(temporaryPath, tokenPath);
    }
  } finally { await fs.unlink(temporaryPath).catch(() => {}); }
  return tokenPath;
}

export async function initializeDeployment(options: {
  configDir: string; downloadDir: string; envFile: string; uid?: number; gid?: number;
}) {
  const configDir = path.resolve(options.configDir);
  const downloadDir = path.resolve(options.downloadDir);
  const envFile = path.resolve(options.envFile);
  const uid = options.uid ?? process.getuid?.();
  const gid = options.gid ?? process.getgid?.();
  if (uid === undefined || gid === undefined || !Number.isInteger(uid) || !Number.isInteger(gid) || uid < 1 || gid < 1) {
    throw new Error('Set non-root numeric --uid and --gid for the host owner of the persistence directories.');
  }
  // Avoid dotenv/Compose interpolation in generated paths.
  if ([configDir, downloadDir].some(value => /[\r\n$"\\]/.test(value))) throw new Error('Persistence paths cannot contain newlines, dollars, quotes or backslashes.');
  const manager = new AccountManager(configDir);
  await manager.initialize();
  const tokenPath = await ensureToken(configDir);
  await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const data = [
    `IMAP_MCP_CONFIG_DIR="${configDir}"`, `IMAP_MCP_DOWNLOAD_DIR="${downloadDir}"`,
    `IMAP_MCP_TOKEN_FILE="${tokenPath}"`, `IMAP_MCP_UID=${uid}`, `IMAP_MCP_GID=${gid}`,
    'IMAP_MCP_LOCAL_PORT=47863', 'IMAP_MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]',
    'IMAP_MCP_ALLOWED_ORIGINS=', 'IMAP_MCP_READ_ONLY=false', 'IMAP_MCP_ENABLED_TOOLS=', '',
  ].join('\n');
  let createdEnv = false;
  try { await fs.writeFile(envFile, data, { mode: 0o600, flag: 'wx' }); createdEnv = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot write deployment .env file.'); }
  return { configDir, downloadDir, envFile, tokenPath, createdEnv };
}
