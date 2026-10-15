import { ERROR_CODES, MFA_SETUP_PATH } from '@oci/shared';
import { createMiddleware } from 'hono/factory';
import { evaluateMfa } from '../auth/mfa.js';
import { AppError } from '../lib/errors.js';
import { hasCredentialAccount } from '../services/mfa/credential.js';
import { getSetting, normalizeMfaRequirement } from '../services/settings.js';
import type { AppBindings } from './context.js';

/**
 * The per-role requirement for two-step verification, enforced on the server
 * for every request (v0.14, #399; docs/admin/identity.md).
 *
 * A person is **limited** when their role is required, their session has not
 * passed a second step (or a passkey, or single sign-on), they can sign in with
 * a password at all, and the deadline (the later of when the role was required
 * and when the account was made, plus the grace days) has passed. A limited
 * session gets `403 MFA_ENROLMENT_REQUIRED` on everything but the allowlist
 * below: signing out, the second step, `GET /api/me` and `/api/me/mfa/*` (the
 * way out of being limited), ending sessions, and what a sign-in page needs.
 *
 * Unlike the acceptable use policy's guard, it covers **every method**: a
 * password-only session must not read conversations either. Deny by default,
 * like the read-only and policy guards: a route added later is refused for a
 * limited person, and the test that enumerates every registered route
 * (mfa-gate-allowlist.unit.test.ts) keeps it so. No role is exempt and there
 * is no environment bypass: the safeguards against locking out the
 * break-glass administrator are in the rules for *saving* a requirement
 * (services/mfa/requirement.ts) and in the operator CLI.
 *
 * It reads what the session lookup returned (the session cache is off, so it
 * is current on every request) and the cached `auth` setting; the one database
 * query (does the person have a password account) runs only for someone who is
 * otherwise limited. An unreadable setting is an error the client may retry,
 * never a bypass.
 */
export interface MfaAllowance {
  /** `*` is every method. */
  methods: readonly string[] | '*';
  /** A full path; `:name` matches one segment and a final `*` the rest. */
  path: string;
  /** Why this works while limited. */
  why: string;
}

const READS = ['GET', 'HEAD', 'OPTIONS'] as const;

export const MFA_ALLOWLIST: readonly MfaAllowance[] = [
  { methods: READS, path: '/api/health/*', why: 'Health checks, for the proxy and orchestrator' },
  { methods: READS, path: '/api/maintenance', why: 'The maintenance banner on the sign-in page' },
  { methods: READS, path: '/api/branding/*', why: 'The logo on the sign-in and setup pages' },
  {
    methods: '*',
    path: '/api/auth/*',
    why: 'Signing out, the second step, passkeys and the rest of Better Auth: identity, not use',
  },
  { methods: ['GET'], path: '/api/me', why: 'The web app learns it is limited, and what to show' },
  { methods: '*', path: '/api/me/mfa', why: 'Setting up two-step verification: the way out' },
  { methods: '*', path: '/api/me/mfa/*', why: 'Setting up two-step verification: the way out' },
  {
    methods: ['DELETE'],
    path: '/api/me/sessions/:id',
    why: 'Signing out a device (security)',
  },
  {
    methods: ['POST'],
    path: '/api/me/sessions/revoke-others',
    why: 'Signing out other devices (security)',
  },
];

function compile(pattern: string): RegExp {
  const parts = pattern.split('/').map((segment) => {
    if (segment === '*') return '.*';
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}/?$`);
}

const compiled = MFA_ALLOWLIST.map((entry) => ({ entry, pattern: compile(entry.path) }));

/** The allowlist entry for a request, or null when a limited session is refused. Exported for tests. */
export function mfaAllowance(method: string, path: string): MfaAllowance | null {
  const upper = method.toUpperCase();
  return (
    compiled.find(
      ({ entry, pattern }) =>
        (entry.methods === '*' || entry.methods.includes(upper)) && pattern.test(path),
    )?.entry ?? null
  );
}

export const MFA_ENROL_MESSAGE =
  'Your role requires two-step verification. Set it up in Settings before you continue.';
export const MFA_SECOND_STEP_MESSAGE =
  'Your role requires two-step verification. Sign out and sign in again with your authenticator code or a passkey.';

export const mfaGate = createMiddleware<AppBindings>(async (c, next) => {
  const user = c.get('user');
  // No session: the route's own check answers 401.
  if (!user) return next();
  if (mfaAllowance(c.req.method, c.req.path)) return next();

  const requirement = normalizeMfaRequirement((await getSetting('auth')).mfaRequirement);
  if (requirement.roles.length === 0) return next();

  const facts = c.get('mfa');
  const evaluation = evaluateMfa({
    role: user.role,
    authMethod: facts?.authMethod ?? null,
    twoFactorEnabled: facts?.twoFactorEnabled ?? false,
    // Without the session's facts (never in production), the account counts as old:
    // deny rather than guess a later deadline.
    accountCreatedAt: facts?.userCreatedAt ?? new Date(0),
    requirement,
    now: new Date(),
  });
  if (!evaluation.candidate) return next();
  // A person who cannot sign in with a password (single sign-on only) is never limited.
  if (!(await hasCredentialAccount(user.id))) return next();

  throw new AppError(
    ERROR_CODES.MFA_ENROLMENT_REQUIRED,
    evaluation.reason === 'second_step' ? MFA_SECOND_STEP_MESSAGE : MFA_ENROL_MESSAGE,
    403,
    {
      reason: evaluation.reason,
      deadline: evaluation.deadline?.toISOString() ?? null,
      setupPath: MFA_SETUP_PATH,
    },
  );
});
