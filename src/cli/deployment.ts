import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AccountManager } from '../services/account-manager.js';
import { readOAuthConfig, readOAuthScopes } from '../oauth.js';

export async function initializeDeployment(options: {
  configDir: string; downloadDir: string; envFile: string; uid?: number; gid?: number;
  oauthIssuer?: string; oauthResourceUrl?: string; oauthScopes?: string; oauthAllowInsecureHttp?: boolean;
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
  const oauthEnv = {
    IMAP_MCP_OAUTH_ISSUER: options.oauthIssuer ?? '',
    IMAP_MCP_OAUTH_RESOURCE_URL: options.oauthResourceUrl ?? '',
    IMAP_MCP_OAUTH_SCOPES: options.oauthScopes ?? 'imap:access',
    IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP: String(options.oauthAllowInsecureHttp ?? false),
  };
  if (Object.values(oauthEnv).some(value => /[\r\n$"\\]/.test(value))) throw new Error('OAuth setup values cannot contain newlines, dollars, quotes or backslashes.');
  readOAuthScopes(oauthEnv.IMAP_MCP_OAUTH_SCOPES);
  if (options.oauthIssuer !== undefined || options.oauthResourceUrl !== undefined || options.oauthAllowInsecureHttp) {
    readOAuthConfig(oauthEnv);
  }
  const manager = new AccountManager(configDir);
  await manager.initialize();
  await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const data = [
    `IMAP_MCP_CONFIG_DIR="${configDir}"`, `IMAP_MCP_DOWNLOAD_DIR="${downloadDir}"`,
    `IMAP_MCP_UID=${uid}`, `IMAP_MCP_GID=${gid}`,
    ...Object.entries(oauthEnv).map(([name, value]) => `${name}="${value}"`),
    'IMAP_MCP_LOCAL_PORT=47863', 'IMAP_MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]',
    'IMAP_MCP_ALLOWED_ORIGINS=', 'IMAP_MCP_READ_ONLY=false', 'IMAP_MCP_ENABLED_TOOLS=', '',
  ].join('\n');
  let createdEnv = false;
  try { await fs.writeFile(envFile, data, { mode: 0o600, flag: 'wx' }); createdEnv = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot write deployment .env file.'); }
  return { configDir, downloadDir, envFile, createdEnv };
}
