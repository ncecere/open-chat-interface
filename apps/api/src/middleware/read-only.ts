import { ERROR_CODES, READ_ONLY_STATUS, type ReadOnlyStatus } from '@oci/shared';
import { createMiddleware } from 'hono/factory';
import { logger } from '../lib/logger.js';
import {
  jobPausedByReadOnly,
  readOnlyStatus,
  retryAfterSeconds,
} from '../services/maintenance/read-only.js';
import type { AppBindings } from './context.js';

/**
 * Read-only maintenance mode, enforced (v0.11 design, section 9;
 * docs/admin/maintenance.md).
 *
 * Every request that is not GET, HEAD or OPTIONS is refused while read-only,
 * before anything else is done with it (no body is read, nothing is stored),
 * unless it matches the allowlist below. A route added later is therefore
 * refused by default; the test that enumerates every registered route
 * (read-only-allowlist.unit.test.ts) keeps it so.
 *
 * **Why 423 Locked**, with the stable error code `READ_ONLY`:
 *
 * - not `503`: the bundled proxy (and most load balancers) takes a replica
 *   that answers 503 out of rotation, and every replica would answer it at
 *   once; 503 is also what a draining replica answers, which the web app
 *   retries;
 * - not `500` (with `retryable`): that is a database failover, retried at once;
 * - not `409`: the API already answers 409 for conflicts with one resource
 *   (a reply still generating, no worker alive), which clients handle per
 *   resource;
 * - `423 Locked` (RFC 4918) says the target is locked against changes, is a
 *   client-side refusal that no proxy treats as an unhealthy server (and
 *   that error budgets do not count as a server error), and carries
 *   `Retry-After` (seconds) when the end is known. `X-OCI-Read-Only` names
 *   the source (`environment`, `administrator` or `schedule`).
 */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ReadOnlyAllowance {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A full path; `:name` matches one segment and a final `*` the rest. */
  path: string;
  /** Why this write keeps working while read-only. */
  why: string;
  /** Allowed only when this holds (checked only while read-only). */
  when?: () => Promise<boolean>;
}

/**
 * The writes that stay allowed while read-only. Keep it short: each entry is
 * a write that happens during maintenance.
 */
export const READ_ONLY_ALLOWLIST: readonly ReadOnlyAllowance[] = [
  // Signing in and out (Better Auth). Session refresh happens on GET.
  { method: 'POST', path: '/api/auth/sign-in/*', why: 'Signing in' },
  { method: 'POST', path: '/api/auth/sign-out', why: 'Signing out' },
  {
    method: 'POST',
    path: '/api/auth/sso/saml2/*',
    why: 'Signing in with SAML (the identity provider posts back here)',
  },
  {
    method: 'POST',
    path: '/api/auth/accept-invite/validate',
    why: 'Checks an invitation; changes nothing',
  },
  {
    method: 'POST',
    path: '/api/me/onboarding/*',
    why: 'The first sign-in’s policy step, without which nobody new could read',
  },
  {
    method: 'POST',
    path: '/api/me/sessions/revoke-others',
    why: 'Signing out other devices (security comes before maintenance)',
  },
  { method: 'DELETE', path: '/api/me/sessions/:id', why: 'Signing out a device' },
  {
    method: 'POST',
    path: '/api/admin/users/:id/revoke-sessions',
    why: 'Signing a person out everywhere (incident response)',
  },
  {
    method: 'DELETE',
    path: '/api/chat/:threadId/stream',
    why: 'Stopping a reply in progress (a reply admitted before the switch finishes)',
  },
  {
    method: 'POST',
    path: '/api/me/broadcasts/:id/dismiss',
    why: 'Hiding an announcement, such as the maintenance one (harmless if lost)',
  },
  {
    method: 'PUT',
    path: '/api/admin/maintenance',
    why: 'The read-only switch itself (administrators only)',
  },
  {
    method: 'POST',
    path: '/api/admin/backups/run',
    why: 'A backup before the risky part, while backups are chosen to keep running',
    when: async () => !(await jobPausedByReadOnly('backups.run')),
  },
  {
    method: 'POST',
    path: '/api/admin/compliance/run',
    why: 'A compliance export, while exports are chosen to keep running',
    when: async () => !(await jobPausedByReadOnly('compliance.export')),
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

const compiled = READ_ONLY_ALLOWLIST.map((entry) => ({ entry, pattern: compile(entry.path) }));

/** The allowlist entry for a write, or null when read-only refuses it. Exported for tests. */
export function readOnlyAllowance(method: string, path: string): ReadOnlyAllowance | null {
  const upper = method.toUpperCase();
  return (
    compiled.find(({ entry, pattern }) => entry.method === upper && pattern.test(path))?.entry ??
    null
  );
}

function formatUntil(until: string): string {
  return `${until.slice(0, 16).replace('T', ' ')} UTC`;
}

/** The message people see; the web app words its own from `details`. */
export function readOnlyMessage(status: ReadOnlyStatus): string {
  const reason = status.reason ? ` (${status.reason.replace(/[.\s]+$/, '')})` : '';
  const until = status.until
    ? ` until maintenance ends, expected ${formatUntil(status.until)}`
    : ' until maintenance ends';
  return `This service is read-only for maintenance${reason}. You can read, search and export, but changes cannot be saved${until}.`;
}

let lastFailureLog = 0;

export const readOnlyGuard = createMiddleware<AppBindings>(async (c, next) => {
  if (READ_METHODS.has(c.req.method)) return next();
  let status: ReadOnlyStatus;
  try {
    status = await readOnlyStatus();
  } catch (error) {
    // The setting cannot be read (the database is away and nothing is
    // cached): let the request through rather than refuse every write on a
    // guess; it fails on the database the same way anyway.
    if (Date.now() - lastFailureLog > 60_000) {
      lastFailureLog = Date.now();
      logger.warn({ err: String(error) }, 'Could not read the read-only setting; not enforcing it');
    }
    return next();
  }
  if (!status.active) return next();

  const allowance = readOnlyAllowance(c.req.method, c.req.path);
  if (allowance && (!allowance.when || (await allowance.when()))) return next();

  const retryAfter = retryAfterSeconds(status);
  return c.json(
    {
      error: {
        code: ERROR_CODES.READ_ONLY,
        message: readOnlyMessage(status),
        details: { readOnly: status },
      },
    },
    READ_ONLY_STATUS,
    {
      'X-OCI-Read-Only': status.source ?? 'administrator',
      ...(retryAfter === null ? {} : { 'Retry-After': String(retryAfter) }),
    },
  );
});
