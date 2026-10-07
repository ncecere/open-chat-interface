import { ERROR_CODES } from '@oci/shared';
import { createMiddleware } from 'hono/factory';
import { AppError } from '../lib/errors.js';
import { isNewTurnRequest, retryTurnStep, turnDeadline } from '../services/chat/turn-patience.js';
import { pendingPolicyFor } from '../services/policy-gate.js';
import type { AppBindings } from './context.js';

/**
 * The acceptable use policy, enforced on the server (#367; docs/admin/governance.md).
 *
 * While a published policy exists that the signed-in person has not accepted
 * (the browser's rule: the highest published version, accepted by that exact
 * version), every request that is not GET, HEAD or OPTIONS is refused with
 * `403 POLICY_ACCEPTANCE_REQUIRED` unless it is on the allowlist below. So a
 * route added later is refused by default, and the test that enumerates every
 * registered route (policy-acceptance-allowlist.unit.test.ts) keeps it so.
 *
 * What stays open:
 *
 * - every read, so the acceptance page can show the policy and the person
 *   can see and export their own data (`GET /api/me`, the policy, threads);
 * - the writes the acceptance page itself needs, signing in and out, and
 *   what a person must always be able to do about their own account
 *   (deleting it, signing out devices, withdrawing a share link);
 * - the whole administration API. An administrator who has not accepted can
 *   still publish, edit and manage, so a new policy cannot lock out the
 *   people who run the instance, and automation that manages the instance
 *   keeps working. What an administrator does as a *user* (chat, uploads,
 *   memory) is gated like anyone's, as the browser's page is.
 *
 * Product decision: it applies to every role, as the browser's gate does.
 * An API-only client that has never accepted now gets 403 on writes.
 */
export interface PolicyAllowance {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A full path; `:name` matches one segment and a final `*` the rest. */
  path: string;
  /** Why this write works before the policy is accepted. */
  why: string;
}

export const POLICY_ALLOWLIST: readonly PolicyAllowance[] = [
  {
    method: 'POST',
    path: '/api/auth/*',
    why: 'Signing in and out, password reset, verification and the rest of Better Auth: identity, not use',
  },
  {
    method: 'POST',
    path: '/api/me/onboarding/accept-policy',
    why: 'Accepting the policy, which is the way out of this refusal',
  },
  {
    method: 'POST',
    path: '/api/me/delete-account',
    why: 'Somebody who does not agree can delete their account',
  },
  {
    method: 'POST',
    path: '/api/me/sessions/revoke-others',
    why: 'Signing out other devices (security)',
  },
  { method: 'DELETE', path: '/api/me/sessions/:id', why: 'Signing out a device (security)' },
  {
    method: 'POST',
    path: '/api/me/share-links/revoke-all',
    why: 'Withdrawing shared links only reduces what is exposed',
  },
  {
    method: 'DELETE',
    path: '/api/share-links/links/:linkId',
    why: 'Withdrawing a shared link only reduces what is exposed',
  },
  {
    method: 'DELETE',
    path: '/api/chat/:threadId/stream',
    why: 'Stopping a reply that was admitted before the policy was published',
  },
  ...(['POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => ({
    method,
    path: '/api/admin/*',
    why: 'The administration API: publishing and managing the policy must not depend on accepting it',
  })),
];

function compile(pattern: string): RegExp {
  const parts = pattern.split('/').map((segment) => {
    if (segment === '*') return '.*';
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}/?$`);
}

const compiled = POLICY_ALLOWLIST.map((entry) => ({ entry, pattern: compile(entry.path) }));

/** The allowlist entry for a write, or null when an unaccepted policy refuses it. Exported for tests. */
export function policyAllowance(method: string, path: string): PolicyAllowance | null {
  const upper = method.toUpperCase();
  return (
    compiled.find(({ entry, pattern }) => entry.method === upper && pattern.test(path))?.entry ??
    null
  );
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const policyAcceptanceMessage = (version: number) =>
  `You must accept the acceptable use policy (version ${version}) before you can do this. Open the app, read the policy and choose "I accept".`;

export const policyAcceptanceGuard = createMiddleware<AppBindings>(async (c, next) => {
  if (READ_METHODS.has(c.req.method)) return next();
  const user = c.get('user');
  // No session: the route's own check answers 401.
  if (!user) return next();
  if (policyAllowance(c.req.method, c.req.path)) return next();

  // A new message waits out a database outage like the rest of its steps (#326).
  const request = c.req.raw;
  const pending = await retryTurnStep(
    isNewTurnRequest(request) ? turnDeadline(request) : undefined,
    'policy',
    () => pendingPolicyFor(user.id),
  );
  if (!pending) return next();

  throw new AppError(
    ERROR_CODES.POLICY_ACCEPTANCE_REQUIRED,
    policyAcceptanceMessage(pending.version),
    403,
    { policy: pending },
  );
});
