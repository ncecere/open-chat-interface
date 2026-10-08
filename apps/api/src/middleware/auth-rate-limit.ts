import { ERROR_CODES } from '@oci/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { clientIp } from '../lib/client-ip.js';
import { hashToken } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../services/audit.js';
import {
  type AuthRequestKind,
  authRateLimit,
  refundRateLimit,
} from '../services/limits/rate-limit.js';

/**
 * OCI's authentication limits, applied in front of Better Auth's handler
 * (v0.11 design, item 22; docs/OPERATIONS.md, "Sign-in limits"). They are the
 * only ones: Better Auth's own limiter (three sign-ins per address per ten
 * seconds, in each replica's memory) is turned off in auth/index.ts, because
 * a campus behind one NAT address met it on its first morning.
 *
 * Counted in Redis, so every replica shares the counts, falling back to
 * per-process counting when Redis is down (services/limits/rate-limit.ts):
 *
 * - failed sign-ins per account (`RATE_LIMIT_AUTH_PER_MINUTE`, or "Sign-in
 *   attempts per minute" on People → Roles & access) and per address
 *   (`RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE`); a successful sign-in is refunded;
 * - sign-up, password reset and verification requests per account and per
 *   address, every request counted;
 * - password and email changes per session;
 * - single sign-on callbacks per identity provider
 *   (`RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE`), with failed ones also per
 *   address;
 * - every request from one address, at ten times the address allowance.
 *
 * Paths are relative to /api/auth.
 */
const POST_KINDS = new Map<string, AuthRequestKind>([
  ['/sign-in/email', 'credential'],
  ['/sign-up/email', 'request'],
  ['/sign-in/sso', 'sso-start'],
  ['/request-password-reset', 'request'],
  // Older name of the same endpoint, still answered by some clients.
  ['/forget-password', 'request'],
  ['/reset-password', 'request'],
  ['/send-verification-email', 'request'],
  ['/change-password', 'session'],
  ['/change-email', 'session'],
]);
const GET_KINDS = new Map<string, AuthRequestKind>([['/verify-email', 'request']]);
const GET_PREFIXES: Array<[string, AuthRequestKind]> = [['/reset-password/', 'request']];
/** Single sign-on callbacks, each ending in the provider id. */
const SSO_CALLBACK_PREFIXES = ['/sso/callback/'];

export const AUTH_RATE_LIMIT_MESSAGE = 'Too many attempts. Wait a minute and try again.';

/** The path below /auth, or null for a path outside it. */
function authPath(path: string): string | null {
  const index = path.indexOf('/auth/');
  return index === -1 ? null : path.slice(index + '/auth'.length);
}

/** What kind of limited request this is, and its identity provider; null when not limited. */
export function authRequestKind(
  method: string,
  path: string,
): { kind: AuthRequestKind; provider: string | null } | null {
  if (method === 'GET' || method === 'POST') {
    for (const prefix of SSO_CALLBACK_PREFIXES) {
      if (path.startsWith(prefix)) {
        const provider = path.slice(prefix.length).split('/')[0] ?? '';
        return { kind: 'sso-callback', provider: provider ? decodeURIComponent(provider) : null };
      }
    }
    // The shared callback carries the provider in its state only.
    if (path === '/sso/callback') return { kind: 'sso-callback', provider: '(shared callback)' };
  }
  if (method === 'POST') {
    const kind = POST_KINDS.get(path);
    return kind ? { kind, provider: null } : null;
  }
  if (method === 'GET') {
    const kind =
      GET_KINDS.get(path) ?? GET_PREFIXES.find(([prefix]) => path.startsWith(prefix))?.[1];
    return kind ? { kind, provider: null } : null;
  }
  return null;
}

export function isRateLimitedAuthPath(method: string, path: string): boolean {
  return authRequestKind(method, path) !== null;
}

/** The submitted address, from a JSON or form body; never throws. */
async function submittedEmail(c: Context): Promise<string | null> {
  if (c.req.method !== 'POST') return null;
  const type = c.req.header('content-type') ?? '';
  try {
    let value: unknown;
    if (type.includes('application/json')) {
      // A clone, so Better Auth still reads the original body.
      const body = (await c.req.raw.clone().json()) as { email?: unknown } | null;
      value = body?.email;
    } else if (type.includes('application/x-www-form-urlencoded')) {
      value = new URLSearchParams(await c.req.raw.clone().text()).get('email');
    }
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return email && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

/** A hash of the session cookie, so a session's attempts are counted without storing it. */
function sessionKey(c: Context): string | null {
  const token =
    getCookie(c, 'oci.session_token') ?? getCookie(c, '__Secure-oci.session_token') ?? null;
  return token ? hashToken(token).slice(0, 32) : null;
}

/**
 * The trusted client address (lib/client-ip.ts); without a proxy header, the
 * connecting socket, which a client cannot choose.
 */
function limitAddress(c: Context): string | null {
  const forwarded = clientIp(c);
  if (forwarded) return forwarded;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

/**
 * Whether the attempt succeeded, for refunding its failure counters: a
 * sign-in answers 2xx; a single sign-on callback redirects, to an address
 * carrying `error=` when it failed.
 */
function succeeded(kind: AuthRequestKind, response: Response): boolean {
  if (kind === 'credential') return response.status >= 200 && response.status < 300;
  if (kind === 'sso-callback') {
    if (response.status < 300 || response.status >= 400) return false;
    const location = response.headers.get('location') ?? '';
    return !/[?&]error=/.test(location);
  }
  return false;
}

export const authRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const path = authPath(c.req.path);
  const match = path ? authRequestKind(c.req.method, path) : null;
  if (!path || !match) return next();

  const ipAddress = limitAddress(c);
  const email =
    match.kind === 'credential' || match.kind === 'request' ? await submittedEmail(c) : null;
  const result = await authRateLimit({
    kind: match.kind,
    ipAddress,
    identifier: email,
    session: match.kind === 'session' ? sessionKey(c) : null,
    provider: match.provider,
  });
  if (result.allowed) {
    await next();
    if (result.refundOnSuccess.length > 0 && succeeded(match.kind, c.res)) {
      await Promise.all(result.refundOnSuccess.map((key) => refundRateLimit(key))).catch((error) =>
        logger.warn({ error }, 'Could not refund an authentication attempt'),
      );
    }
    return;
  }

  // Once per window per address, account or provider, so a flood of refused
  // requests cannot flood the audit log as well.
  if (result.firstRefusal) {
    logger.warn(
      { path, scope: result.scope, provider: match.provider ?? undefined },
      'Authentication rate limit reached',
    );
    await recordAudit({
      actorEmail: email,
      action: 'auth.rate_limited',
      targetType: 'session',
      targetId: null,
      ipAddress: clientIp(c),
      metadata: {
        path,
        scope: result.scope,
        limit: result.limit,
        retryAfterSeconds: result.retryAfterSeconds,
        ...(match.provider ? { provider: match.provider } : {}),
      },
    });
  }

  // Better Auth's client reads `message` and `code` at the top level; the
  // rest of the API's clients read `error`. Both are present.
  return c.json(
    {
      code: 'TOO_MANY_REQUESTS',
      message: AUTH_RATE_LIMIT_MESSAGE,
      error: { code: ERROR_CODES.RATE_LIMITED, message: AUTH_RATE_LIMIT_MESSAGE },
    },
    429,
    { 'retry-after': String(result.retryAfterSeconds) },
  );
};
