import { USER_ROLES, type UserRole } from '@oci/shared';
import { APIError } from 'better-auth/api';
import { createMiddleware } from 'hono/factory';
import { auth } from '../auth/index.js';
import { SESSION_LOOKUP_FAILED } from '../lib/db-connection.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { noteSessionActivity } from '../services/account-sessions.js';
import { isNewTurnRequest, retryTurnStep, turnDeadline } from '../services/chat/turn-patience.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: UserRole;
  emailVerified: boolean;
  organizationId: string;
}

export interface AppBindings {
  Variables: {
    user: AuthenticatedUser | null;
    sessionId: string | null;
  };
}

/** Fail closed for absent, corrupt, or unexpected persisted role values. */
export function normalizeSessionRole(value: unknown): UserRole {
  return typeof value === 'string' && USER_ROLES.some((role) => role === value)
    ? (value as UserRole)
    : 'restricted';
}

/**
 * The person's session. Better Auth re-throws a failed lookup query as a bare
 * INTERNAL_SERVER_ERROR APIError, without its cause; nothing else has run
 * for the request yet, so it is reported as a lost database connection: the
 * error handler then marks the answer retryable, and reads are run again
 * (middleware/read-retry.ts) instead of answering a plain 500.
 */
async function lookUpSession(headers: Headers) {
  try {
    return await auth.api.getSession({ headers });
  } catch (error) {
    if (error instanceof APIError && error.status === 'INTERNAL_SERVER_ERROR') {
      throw Object.assign(new Error('The session could not be looked up', { cause: error }), {
        code: SESSION_LOOKUP_FAILED,
      });
    }
    throw error;
  }
}

/** Resolves the session for every request without rejecting anonymous ones. */
export const sessionMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  // A new message waits out a database outage rather than failing at once and
  // losing its text (#326); the lookup changes nothing, so it is safe to repeat.
  const request = c.req.raw;
  const session = isNewTurnRequest(request)
    ? await retryTurnStep(turnDeadline(request), 'session', () => lookUpSession(request.headers))
    : await lookUpSession(request.headers);

  if (session?.user) {
    const raw = session.user as typeof session.user & {
      role?: string;
      organizationId?: string;
      banned?: boolean;
    };

    c.set('user', {
      id: raw.id,
      email: raw.email,
      name: raw.name,
      image: raw.image ?? null,
      role: normalizeSessionRole(raw.role),
      emailVerified: raw.emailVerified,
      organizationId: raw.organizationId ?? '',
    });
    c.set('sessionId', session.session.id);
    // Settings → Devices shows when each session was last active. Not awaited:
    // a failed write must never fail or slow the request it rides on.
    void noteSessionActivity(session.session.id, new Date(session.session.updatedAt)).catch(
      (error) => logger.debug({ error }, 'Could not record session activity'),
    );
  } else {
    c.set('user', null);
    c.set('sessionId', null);
  }

  await next();
});

export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
});

/** Methods that only observe. Everything else changes something. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Guards the administration API.
 *
 * An auditor may read every administrative surface and change none of it.
 * Enforced on the request method here rather than annotated onto each route:
 * there are forty-nine mutating admin endpoints, and a list that has to be
 * kept in step with them is one somebody will eventually forget to extend —
 * failing open, which is the wrong direction for a permission check.
 */
export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();

  if (user.role === 'admin') {
    await next();
    return;
  }

  if (user.role === 'auditor') {
    if (!READ_METHODS.has(c.req.method)) {
      throw forbidden('This account has read-only administrative access');
    }
    await next();
    return;
  }

  throw forbidden('Administrator access required');
});

export function currentUser(c: { get: (key: 'user') => AuthenticatedUser | null }) {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}
