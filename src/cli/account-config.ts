import { z } from 'zod';
import type { ImapAccount } from '../types/index.js';
import { getProviderByEmail, getProviderById } from '../providers/email-providers.js';
import { ENV_CREDENTIAL_SUFFIXES, envVarName } from '../utils/env-credentials.js';

const port = z.number().int().min(1).max(65535);
const smtpSchema = z.object({
  host: z.string().trim().min(1).optional(), port: port.optional(), secure: z.boolean().optional(),
  user: z.string().optional(), password: z.string().optional(),
  authMethod: z.enum(['PLAIN', 'LOGIN', 'CRAM-MD5', 'XOAUTH2']).optional(),
  tls: z.object({ rejectUnauthorized: z.boolean().optional() }).strict().optional(),
}).strict();
const inputSchema = z.object({
  name: z.string().trim().min(1).optional(), email: z.string().email().optional(),
  provider: z.string().optional(), host: z.string().trim().min(1).optional(),
  port: port.optional(), tls: z.boolean().optional(), allowStartTLS: z.boolean().optional(),
  imapUsername: z.string().optional(), password: z.string().optional(),
  smtp: smtpSchema.nullable().optional(), saveToSent: z.boolean().optional(),
  sentFolder: z.string().optional(), defaultBcc: z.union([z.string(), z.array(z.string())]).optional(),
  imapUsernameFromEnv: z.boolean().optional(), imapPasswordFromEnv: z.boolean().optional(),
  smtpUsernameFromEnv: z.boolean().optional(), smtpPasswordFromEnv: z.boolean().optional(),
}).strict();

export type AccountInput = z.infer<typeof inputSchema>;

export function parseAccountInput(value: unknown): AccountInput {
  const result = inputSchema.safeParse(value);
  if (!result.success) {
    // Never use Zod's raw error: some validators include the supplied value.
    throw new Error(`Invalid setup fields: ${[...new Set(result.error.issues.map(issue => issue.path.join('.') || 'input'))].join(', ')}`);
  }
  return result.data;
}

export function accountFromInput(value: unknown): Omit<ImapAccount, 'id'> {
  const input = parseAccountInput(value);
  const provider = input.provider ? getProviderById(input.provider) : getProviderByEmail(input.email ?? '');
  if (input.provider && !provider) throw new Error('Unknown provider. Use imap-setup providers to list provider IDs.');
  const host = input.host ?? provider?.imapHost;
  if (!host) throw new Error('An IMAP host is required for a custom provider.');
  const user = input.imapUsernameFromEnv ? '' : input.imapUsername ?? input.email;
  if (user === undefined) throw new Error('An email or IMAP username is required.');
  if (!input.imapPasswordFromEnv && !input.password) throw new Error('An IMAP password or imapPasswordFromEnv is required.');
  const name = input.name ?? input.email;
  if (!name) throw new Error('An account name or email is required.');
  const smtp = input.smtp === null ? undefined : input.smtp ?? (provider?.smtpHost ? {
    host: provider.smtpHost, port: provider.smtpPort, secure: provider.smtpSecurity !== 'STARTTLS',
  } : undefined);
  if (!smtp && (input.smtpUsernameFromEnv || input.smtpPasswordFromEnv)) throw new Error('SMTP environment credentials require SMTP settings.');
  return {
    name, host, port: input.port ?? provider?.imapPort ?? 993, user,
    password: input.imapPasswordFromEnv ? '' : input.password!,
    tls: input.tls ?? (provider?.imapSecurity !== 'STARTTLS'),
    ...(input.allowStartTLS !== undefined ? { allowStartTLS: input.allowStartTLS } : {}),
    ...(input.imapUsername !== undefined || input.imapUsernameFromEnv ? { email: input.email } : {}),
    ...(smtp ? { smtp: {
      ...smtp, host: smtp.host ?? host, port: smtp.port ?? 587, secure: smtp.secure ?? false,
      ...(input.smtpUsernameFromEnv ? { user: '' } : {}),
      ...(input.smtpPasswordFromEnv ? { password: '' } : {}),
    } } : {}),
    ...(input.saveToSent !== undefined ? { saveToSent: input.saveToSent } : {}),
    ...(input.sentFolder ? { sentFolder: input.sentFolder } : {}),
    ...(input.defaultBcc && input.defaultBcc.length ? { defaultBcc: input.defaultBcc } : {}),
  };
}

export function accountUpdatesFromInput(value: unknown): Partial<Omit<ImapAccount, 'id'>> {
  const input = parseAccountInput(value);
  if (input.provider !== undefined) throw new Error('Edit explicit host/port/TLS fields to change provider settings.');
  const updates: Partial<Omit<ImapAccount, 'id'>> = {};
  for (const field of ['name', 'host', 'port', 'tls', 'allowStartTLS', 'saveToSent'] as const) {
    if (input[field] !== undefined) Object.assign(updates, { [field]: input[field] });
  }
  if (input.imapUsernameFromEnv) {
    updates.user = '';
    if (input.email !== undefined) updates.email = input.email;
  } else if (input.imapUsername !== undefined) {
    updates.user = input.imapUsername;
    if (input.email !== undefined) updates.email = input.email;
  } else if (input.email !== undefined) {
    updates.user = input.email;
    updates.email = undefined;
  }
  if (input.imapPasswordFromEnv) updates.password = '';
  else if (input.password !== undefined) updates.password = input.password;
  if (input.smtp === null) updates.smtp = undefined;
  else if (input.smtp || input.smtpUsernameFromEnv || input.smtpPasswordFromEnv) {
    // AccountManager merges this partial SMTP update with the encrypted store.
    updates.smtp = {
      ...input.smtp,
      ...(input.smtpUsernameFromEnv ? { user: '' } : {}),
      ...(input.smtpPasswordFromEnv ? { password: '' } : {}),
    } as ImapAccount['smtp'];
  }
  if (input.sentFolder !== undefined) updates.sentFolder = input.sentFolder || undefined;
  if (input.defaultBcc !== undefined) updates.defaultBcc = input.defaultBcc.length ? input.defaultBcc : undefined;
  return updates;
}

export function requiredCredentialVariables(input: AccountInput, name: string): string[] {
  return [
    input.imapUsernameFromEnv && envVarName(name, ENV_CREDENTIAL_SUFFIXES.imapUser),
    input.imapPasswordFromEnv && envVarName(name, ENV_CREDENTIAL_SUFFIXES.imapPassword),
    input.smtpUsernameFromEnv && envVarName(name, ENV_CREDENTIAL_SUFFIXES.smtpUser),
    input.smtpPasswordFromEnv && envVarName(name, ENV_CREDENTIAL_SUFFIXES.smtpPassword),
  ].filter((value): value is string => typeof value === 'string');
}

export function stripAccountSecrets(account: ImapAccount) {
  const { password: _password, smtp, ...rest } = account;
  if (!smtp) return rest;
  const { password: _smtpPassword, ...safeSmtp } = smtp;
  return { ...rest, smtp: safeSmtp };
}
