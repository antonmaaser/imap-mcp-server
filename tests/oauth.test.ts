import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPair } from 'jose';
import { readOAuthConfig, createOAuthVerifier } from '../src/oauth.js';
import { startOAuthFixture } from './helpers/oauth-fixture.mjs';

let fixture: Awaited<ReturnType<typeof startOAuthFixture>>;
const env = () => ({ IMAP_MCP_OAUTH_ISSUER: fixture.issuer, IMAP_MCP_OAUTH_RESOURCE_URL: fixture.state.resource,
  IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP: 'true' });
beforeAll(async () => { fixture = await startOAuthFixture(); });
afterAll(async () => { await fixture.close(); });

describe('OAuth configuration', () => {
  it.each([
    { IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP: 'false' }, { IMAP_MCP_OAUTH_ALLOW_INSECURE_HTTP: 'yes' },
    { IMAP_MCP_OAUTH_ISSUER: 'https://auth.test/realms/mail/' },
    { IMAP_MCP_OAUTH_ISSUER: 'https://user:password@auth.test/realms/mail' },
    { IMAP_MCP_OAUTH_ISSUER: 'https://auth.test/realms/mail?query=1' },
    { IMAP_MCP_OAUTH_RESOURCE_URL: 'https://mail.test/mcp/' },
    { IMAP_MCP_OAUTH_RESOURCE_URL: 'https://mail.test/mcp#fragment' },
    { IMAP_MCP_OAUTH_SCOPES: '' }, { IMAP_MCP_OAUTH_SCOPES: 'unsafe"scope' },
  ])('rejects unsafe OAuth config', overrides => {
    expect(() => readOAuthConfig({ ...env(), ...overrides })).toThrow();
  });
  it('uses HTTPS by default and preserves the exact resource/audience', () => {
    expect(readOAuthConfig({ IMAP_MCP_OAUTH_ISSUER: 'https://auth.test/realms/mail',
      IMAP_MCP_OAUTH_RESOURCE_URL: 'https://mail.test/prefix/mcp' })).toEqual({
      issuer: 'https://auth.test/realms/mail', resourceUrl: 'https://mail.test/prefix/mcp', scopes: ['imap:access'], allowInsecureHttp: false,
    });
  });
});

describe('Keycloak discovery and signed access tokens', () => {
  it('fails closed on issuer mismatch, untrusted JWKS and discovery failure', async () => {
    for (const overrides of [{ issuer: 'https://evil.test' }, { jwks_uri: 'https://evil.test/keys' },
      { code_challenge_methods_supported: ['plain'] }, { response_types_supported: ['token'] },
      { jwks_uri: `${fixture.issuer}/certs?query=1` }]) {
      fixture.state.discoveryOverrides = overrides;
      await expect(createOAuthVerifier(readOAuthConfig(env()))).rejects.toThrow(/Cannot discover/);
    }
    fixture.state.discoveryOverrides = {};
    fixture.state.discoveryStatus = 503;
    await expect(createOAuthVerifier(readOAuthConfig(env()))).rejects.toThrow(/Cannot discover/);
    fixture.state.discoveryStatus = 200;
  });
  it('validates real signatures and returns SDK auth context while caching keys', async () => {
    const verifier = await createOAuthVerifier(readOAuthConfig(env()));
    const before = fixture.state.jwksCalls;
    const token = await fixture.token({ aud: ['another-resource', fixture.state.resource] });
    expect(await verifier.verifyAccessToken(token)).toMatchObject({ clientId: 'test-client', scopes: ['imap:access'], extra: { sub: 'authorized-user' } });
    await verifier.verifyAccessToken(token);
    expect(fixture.state.jwksCalls - before).toBe(1);
  });
  it('rejects expired, future, wrong issuer/audience, ID/refresh and incomplete tokens', async () => {
    const verifier = await createOAuthVerifier(readOAuthConfig(env()));
    const now = Math.floor(Date.now() / 1000);
    const invalid = [
      { exp: now - 1 }, { nbf: now + 60 }, { iat: now + 60 }, { iss: 'https://evil.test' },
      { aud: 'different-resource' }, { aud: undefined }, { typ: 'ID' }, { typ: 'Refresh' },
      { exp: undefined }, { azp: undefined }, { sub: '' }, { iat: undefined }, { scope: ['imap:access'] },
    ];
    for (const payload of invalid) {
      await expect(verifier.verifyAccessToken(await fixture.token(payload))).rejects.toThrow('Invalid or expired access token');
    }
    const attacker = await generateKeyPair('RS256');
    await expect(verifier.verifyAccessToken(await fixture.token({}, attacker.privateKey))).rejects.toThrow();
    await expect(verifier.verifyAccessToken('not-a-jwt')).rejects.toThrow();
  });
  it('fails closed when keys are unavailable', async () => {
    const verifier = await createOAuthVerifier(readOAuthConfig(env()));
    fixture.state.jwksStatus = 503;
    try { await expect(verifier.verifyAccessToken(await fixture.token())).rejects.toThrow(); }
    finally { fixture.state.jwksStatus = 200; }
  });
  it('retrieves rotated keys after the bounded cooldown', async () => {
    const verifier = await createOAuthVerifier(readOAuthConfig(env()));
    await verifier.verifyAccessToken(await fixture.token());
    await fixture.rotate();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const token = await fixture.token();
      expect((await verifier.verifyAccessToken(token)).clientId).toBe('test-client');
    } finally { vi.useRealTimers(); }
  });
});
