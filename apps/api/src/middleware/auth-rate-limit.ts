import { ERROR_CODES } from '@oci/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { clientIp } from '../lib/client-ip.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../services/audit.js';
import { authRateLimit } from '../services/limits/rate-limit.js';

/**
 * The authentication rate limit (`RATE_LIMIT_AUTH_PER_MINUTE`, or "Sign-in
 * attempts per minute" on People → Roles & access), applied in front of
 * Better Auth's own handler.
 *
 * Counted per client address and, where the request names one, per account
 * (email), in Redis so every replica shares the count, falling back to
 * per-process counting when Redis is down (services/limits/rate-limit.ts).
 * Better Auth's built-in limiter is per process and only runs in production;
 * it still applies on top.
 *
 * Paths are relative to /api/auth. Every attempt counts, successful or not:
 * the limit is on how fast credentials and tokens can be tried.
 */
const LIMITED_POSTS = new Set([
  '/sign-in/email',
  '/sign-up/email',
  '/sign-in/sso',
  '/request-password-reset',
  // Older name of the same endpoint, still answered by some clients.
  '/forget-password',
  '/reset-password',
  '/send-verification-email',
]);
const LIMITED_GETS = new Set(['/verify-email']);
const LIMITED_GET_PREFIXES = ['/reset-password/'];

export const AUTH_RATE_LIMIT_MESSAGE = 'Too many attempts. Wait a minute and try again.';

/** The path below /auth, or null for a path outside it. */
function authPath(path: string): string | null {
  const index = path.indexOf('/auth/');
  return index === -1 ? null : path.slice(index + '/auth'.length);
}

export function isRateLimitedAuthPath(method: string, path: string): boolean {
  if (method === 'POST') return LIMITED_POSTS.has(path);
  if (method === 'GET')
    return LIMITED_GETS.has(path) || LIMITED_GET_PREFIXES.some((prefix) => path.startsWith(prefix));
  return false;
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

export const authRateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const path = authPath(c.req.path);
  if (!path || !isRateLimitedAuthPath(c.req.method, path)) return next();

  const ipAddress = limitAddress(c);
  const email = await submittedEmail(c);
  const result = await authRateLimit({ ipAddress, identifier: email });
  if (result.allowed) return next();

  // Once per window per address or account, so a flood of refused requests
  // cannot flood the audit log as well.
  if (result.firstRefusal) {
    logger.warn({ path, scope: result.scope }, 'Authentication rate limit reached');
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
