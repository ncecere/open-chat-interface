/**
 * A minimal OpenID Connect identity provider for sign-in storm tests
 * (tools/scale k6 `storm.js`, apps/api `sso-storm.live.test.ts`).
 *
 * Authorization code flow only, enough for Better Auth's SSO plugin:
 * discovery, `authorize` (no login page: it signs in whoever `login_hint`
 * names and redirects straight back), `token` (client_secret_basic or
 * client_secret_post, PKCE S256 checked when a challenge was sent), `userinfo`
 * and `jwks` (RS256 id tokens from a key made at start-up).
 *
 * Test-only behaviour, chosen by the login hint:
 * - `fail-…`: `authorize` redirects back with `error=access_denied`, as an
 *   identity provider refusing a person does;
 * - `STUB_OIDC_DELAY_MS`: the token endpoint answers after this long, as a
 *   slow identity provider would.
 *
 * Nothing here is a real credential; never expose it outside a test network.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const CODE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 200_000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readForm(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function bounded(map, key, value) {
  if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value);
  map.set(key, value);
}

/**
 * @param {{ issuer: string, clientId?: string, clientSecret?: string, delayMs?: number }} options
 *   `issuer` is the public base URL of the mount point, such as
 *   `http://stub:4181/oidc`.
 */
export function createOidcProvider(options) {
  const issuer = options.issuer.replace(/\/$/, '');
  const clientId = options.clientId ?? 'scale-client';
  const clientSecret = options.clientSecret ?? 'scale-client-secret';
  const delayMs = options.delayMs ?? 0;
  const mount = new URL(issuer).pathname.replace(/\/$/, '');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'stub-1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const tokens = new Map();
  const stats = { authorize: 0, refused: 0, token: 0, tokenErrors: 0, userinfo: 0, jwks: 0 };

  function sign(claims) {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }));
    const payload = base64url(JSON.stringify(claims));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
    return `${header}.${payload}.${signature.toString('base64url')}`;
  }

  function claimsFor(email) {
    const local = email.split('@')[0] ?? email;
    return {
      sub: createHash('sha256').update(email).digest('hex').slice(0, 24),
      email,
      email_verified: true,
      name: local.replace(/[._-]+/g, ' '),
      groups: ['students'],
    };
  }

  function clientFrom(request, form) {
    const header = request.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
    }
    return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? '' };
  }

  async function token(request, response) {
    stats.token++;
    const form = await readForm(request);
    const client = clientFrom(request, form);
    const entry = codes.get(form.get('code') ?? '');
    codes.delete(form.get('code') ?? '');
    const verifier = form.get('code_verifier');
    const pkceOk =
      !entry?.challenge ||
      (verifier && createHash('sha256').update(verifier).digest('base64url') === entry.challenge);
    if (
      client.id !== clientId ||
      client.secret !== clientSecret ||
      form.get('grant_type') !== 'authorization_code' ||
      !entry ||
      entry.expiresAt < Date.now() ||
      entry.redirectUri !== form.get('redirect_uri') ||
      !pkceOk
    ) {
      stats.tokenErrors++;
      return json(response, 400, { error: 'invalid_grant' });
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const now = Math.floor(Date.now() / 1000);
    const claims = claimsFor(entry.email);
    const accessToken = randomBytes(24).toString('base64url');
    bounded(tokens, accessToken, { claims, expiresAt: Date.now() + 3_600_000 });
    return json(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: entry.scope,
      id_token: sign({
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 3600,
        ...(entry.nonce ? { nonce: entry.nonce } : {}),
        ...claims,
      }),
    });
  }

  /** Handles a request under the mount point; false when the path is not ours. */
  function handle(request, response, url) {
    if (url.pathname !== mount && !url.pathname.startsWith(`${mount}/`)) return false;
    const path = url.pathname.slice(mount.length);
    if (request.method === 'GET' && path === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        claims_supported: ['sub', 'email', 'email_verified', 'name', 'groups'],
      });
      return true;
    }
    if (request.method === 'GET' && path === '/jwks') {
      stats.jwks++;
      json(response, 200, { keys: [jwk] });
      return true;
    }
    if (request.method === 'GET' && path === '/authorize') {
      stats.authorize++;
      const redirectUri = url.searchParams.get('redirect_uri');
      const email = url.searchParams.get('login_hint');
      if (url.searchParams.get('client_id') !== clientId || !redirectUri || !email) {
        json(response, 400, { error: 'invalid_request' });
        return true;
      }
      const back = new URL(redirectUri);
      const state = url.searchParams.get('state');
      if (state) back.searchParams.set('state', state);
      if (email.startsWith('fail-')) {
        stats.refused++;
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'refused by the stub identity provider');
      } else {
        const code = randomBytes(24).toString('base64url');
        bounded(codes, code, {
          email: email.toLowerCase(),
          redirectUri,
          nonce: url.searchParams.get('nonce'),
          challenge: url.searchParams.get('code_challenge'),
          scope: url.searchParams.get('scope') ?? 'openid email profile',
          expiresAt: Date.now() + CODE_TTL_MS,
        });
        back.searchParams.set('code', code);
      }
      response.writeHead(302, { location: back.toString(), 'cache-control': 'no-store' });
      response.end();
      return true;
    }
    if (request.method === 'POST' && path === '/token') {
      token(request, response).catch(() => json(response, 400, { error: 'invalid_request' }));
      return true;
    }
    if (request.method === 'GET' && path === '/userinfo') {
      stats.userinfo++;
      const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      const entry = tokens.get(bearer);
      if (!entry || entry.expiresAt < Date.now()) {
        json(response, 401, { error: 'invalid_token' });
        return true;
      }
      json(response, 200, entry.claims);
      return true;
    }
    if (request.method === 'GET' && path === '/stats') {
      json(response, 200, stats);
      return true;
    }
    json(response, 404, { error: 'unknown OIDC stub endpoint' });
    return true;
  }

  return { handle, stats, clientId, clientSecret, issuer };
}
