import { USER_ROLES, type UserRole } from '@oci/shared';
import { createMiddleware } from 'hono/factory';
import { auth } from '../auth/index.js';
import { forbidden, unauthorized } from '../lib/errors.js';

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

/** Resolves the session for every request without rejecting anonymous ones. */
export const sessionMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

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
