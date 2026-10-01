// Isolated signing authority for tests; private keys/tokens stay in memory.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export async function startOAuthFixture(host = '127.0.0.1', publicHost = host) {
  let pair = await generateKeyPair('RS256');
  let kid = 'test-key-1';
  let jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'RS256', use: 'sig' };
  const state = { discoveryOverrides: {}, discoveryStatus: 200, jwksStatus: 200, jwksCalls: 0,
    tokenRequests: [], authorizationUrl: undefined, resource: 'https://mail-mcp.example.test/mcp' };
  let issuer;
  const token = (overrides = {}, key = pair.privateKey, tokenKid = kid) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: issuer, aud: state.resource, sub: 'authorized-user', azp: 'test-client',
      typ: 'Bearer', scope: 'imap:access', iat: now, exp: now + 300, ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: tokenKid, typ: 'JWT' }).sign(key);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/realms/test/.well-known/openid-configuration') {
      res.statusCode = state.discoveryStatus;
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/certs`, authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['imap:access'], ...state.discoveryOverrides }));
    } else if (req.url === '/realms/test/certs') {
      state.jwksCalls++;
      res.statusCode = state.jwksStatus;
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (req.url === '/realms/test/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      state.tokenRequests.push(Object.fromEntries(params));
      const grant = params.get('grant_type');
      const validCode = grant === 'authorization_code' && params.get('code') === 'test-code' && state.authorizationUrl &&
        createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') === state.authorizationUrl.searchParams.get('code_challenge');
      const validRefresh = grant === 'refresh_token' && params.get('refresh_token') === 'test-refresh';
      if ((!validCode && !validRefresh) || params.get('resource') !== state.resource || params.get('client_id') !== 'test-client') {
        res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return;
      }
      res.end(JSON.stringify({ access_token: await token(), token_type: 'Bearer', expires_in: 300,
        refresh_token: 'test-refresh', scope: 'imap:access' }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, host, resolve);
  });
  issuer = `http://${publicHost}:${server.address().port}/realms/test`;
  return { issuer, state, token,
    async rotate() {
      pair = await generateKeyPair('RS256'); kid = 'test-key-2';
      jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'RS256', use: 'sig' };
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
