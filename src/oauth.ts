import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OpenIdProviderDiscoveryMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface OAuthConfig {
  issuer: string;
  resourceUrl: string;
  scopes: string[];
  allowInsecureHttp: boolean;
}

// These URLs are administrator configuration, never derived from request headers
// or unverified token claims. HTTPS is mandatory except for explicit local testing.
export function oauthUrl(value: string | undefined, name: string, allowHttp: boolean): URL {
  try {
    if (!value || value.trim() !== value) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))) throw new Error();
    return url;
  } catch { throw new Error(`${name} must be an absolute HTTPS URL without credentials, query or fragment (HTTP only with IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP=true for testing).`); }
}

export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const insecure = env.IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP ?? 'false';
  if (!['true', 'false'].includes(insecure)) throw new Error('IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP must be true or false.');
  const allowInsecureHttp = insecure === 'true';
  const issuer = oauthUrl(env.IMAP_MCP_OAUTH_ISSUER, 'IMAP_MCP_OAUTH_ISSUER', allowInsecureHttp);
  const resource = oauthUrl(env.IMAP_MCP_OAUTH_RESOURCE_URL, 'IMAP_MCP_OAUTH_RESOURCE_URL', allowInsecureHttp);
  // A single canonical resource URI is both advertised and checked as aud.
  // Path prefixes are supported when the proxy forwards them to local /mcp.
  if (!resource.pathname.endsWith('/mcp') || resource.href !== env.IMAP_MCP_OAUTH_RESOURCE_URL) {
    throw new Error('IMAP_MCP_OAUTH_RESOURCE_URL must be the canonical public MCP URL ending in /mcp.');
  }
  if (issuer.href !== env.IMAP_MCP_OAUTH_ISSUER || issuer.pathname.endsWith('/')) {
    throw new Error('IMAP_MCP_OAUTH_ISSUER must exactly match the Keycloak realm issuer, without a trailing slash.');
  }
  return { issuer: issuer.href, resourceUrl: resource.href, scopes: readOAuthScopes(env.IMAP_MCP_OAUTH_SCOPES), allowInsecureHttp };
}

export function readOAuthScopes(value = 'imap:access'): string[] {
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some(scope => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
    throw new Error('IMAP_MCP_OAUTH_SCOPES must contain space-separated OAuth scope names.');
  }
  return scopes;
}

export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

export function resourceMetadataUrl(config: OAuthConfig): string {
  const resource = new URL(config.resourceUrl);
  return new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource).href;
}

// Discover Keycloak's signing-key endpoint at startup. jose fetches/caches keys
// on token verification and refetches on rotation; no token exchange/forwarding.
export async function createOAuthVerifier(config: OAuthConfig): Promise<AccessTokenVerifier> {
  let jwksUrl: URL;
  try {
    const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
      redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' },
    });
    if (!response.ok || !response.body) throw new Error();
    let data = '';
    for await (const chunk of response.body) {
      data += Buffer.from(chunk).toString('utf8');
      if (data.length > 1024 * 1024) throw new Error();
    }
    const metadata = OpenIdProviderDiscoveryMetadataSchema.parse(JSON.parse(data));
    if (metadata.issuer !== config.issuer) throw new Error();
    if (!metadata.response_types_supported?.includes('code') ||
        !metadata.code_challenge_methods_supported?.includes('S256')) throw new Error();
    oauthUrl(metadata.authorization_endpoint, 'Keycloak authorization_endpoint', config.allowInsecureHttp);
    oauthUrl(metadata.token_endpoint, 'Keycloak token_endpoint', config.allowInsecureHttp);
    jwksUrl = oauthUrl(metadata.jwks_uri, 'Keycloak jwks_uri', config.allowInsecureHttp);
    if (jwksUrl.origin !== new URL(config.issuer).origin) throw new Error();
  } catch { throw new Error('Cannot discover Keycloak OAuth issuer/JWKS. Check IMAP_MCP_OAUTH_ISSUER, HTTPS trust and realm metadata.'); }

  const keys = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 5000, cacheMaxAge: 300_000, cooldownDuration: 30_000,
    [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'error' }),
  });
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: config.issuer, audience: config.resourceUrl, algorithms: ['RS256'],
          requiredClaims: ['exp', 'iat', 'sub', 'azp', 'typ'], clockTolerance: 0,
        });
        // Keycloak distinguishes access/ID/refresh tokens with payload.typ.
        // A correctly signed ID token is never an access token for this API.
        if (payload.typ !== 'Bearer' || typeof payload.sub !== 'string' || !payload.sub ||
            typeof payload.azp !== 'string' || !payload.azp || typeof payload.iat !== 'number' ||
            payload.iat > Date.now() / 1000 || payload.exp! <= payload.iat ||
            (payload.scope !== undefined && typeof payload.scope !== 'string')) throw new Error();
        return {
          token, clientId: payload.azp, scopes: ((payload.scope as string | undefined) ?? '').split(' ').filter(Boolean),
          expiresAt: payload.exp, resource: new URL(config.resourceUrl), extra: { sub: payload.sub },
        };
      } catch { throw new InvalidTokenError('Invalid or expired access token'); }
    },
  };
}
