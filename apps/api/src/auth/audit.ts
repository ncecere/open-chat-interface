import { recordAudit } from '../services/audit.js';

/**
 * Authentication events worth recording.
 *
 * Everything else the audit log holds is administrative — who changed a
 * setting, who edited a model. An investigation almost always starts somewhere
 * else: who signed in, from where, and when. Without these the log cannot
 * answer that at all.
 *
 * Only outcomes are recorded, never credentials, tokens, or the body of the
 * request that produced them.
 */
const AUDITED_PATHS = new Map<string, string>([
  ['/sign-in/email', 'auth.signin.local'],
  ['/sign-up/email', 'auth.signup.local'],
  ['/sign-out', 'auth.signout'],
  ['/sign-in/sso', 'auth.signin.sso.start'],
  ['/forget-password', 'auth.password.reset_requested'],
  // The endpoint's current name (Better Auth 1.4+); the line above is the old one.
  ['/request-password-reset', 'auth.password.reset_requested'],
  ['/reset-password', 'auth.password.reset_completed'],
  ['/change-password', 'auth.password.changed'],
  ['/change-email', 'auth.email.change_requested'],
  ['/verify-email', 'auth.email.verified'],
  // Settings "Account" (v0.9.1): a person's own name and devices. The devices
  // list uses /api/me/sessions, which records the same actions; these cover
  // Better Auth's own endpoints when called directly.
  ['/update-user', 'auth.profile.updated'],
  ['/revoke-session', 'auth.session.revoked'],
  ['/revoke-sessions', 'auth.sessions.revoked'],
  ['/revoke-other-sessions', 'auth.sessions.revoked_others'],
]);

/** Path prefixes whose outcome is a completed SSO sign-in. */
const SSO_CALLBACK_PREFIXES = ['/sso/callback/', '/sso/saml2/sp/acs/'];

function actionFor(path: string): string | null {
  const direct = AUDITED_PATHS.get(path);
  if (direct) return direct;

  if (SSO_CALLBACK_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'auth.signin.sso';
  }
  return null;
}

/**
 * A failed attempt is worth more than a successful one.
 *
 * Better Auth answers a bad password with 401 and an unknown account the same
 * way, deliberately, so the log records that an attempt failed rather than
 * guessing why.
 */
function outcomeFor(status: number): 'success' | 'failure' {
  return status >= 200 && status < 400 ? 'success' : 'failure';
}

export interface AuthAuditContext {
  path: string;
  status: number;
  ipAddress: string | null;
  userAgent: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
}

export async function recordAuthEvent(context: AuthAuditContext): Promise<void> {
  const action = actionFor(context.path);
  if (!action) return;

  const outcome = outcomeFor(context.status);

  // A sign-in that begins a redirect to an identity provider has not succeeded
  // yet, and recording it as such would double-count against the callback.
  if (action === 'auth.signin.sso.start' && outcome === 'success') return;

  await recordAudit({
    actorUserId: context.actorUserId,
    actorEmail: context.actorEmail,
    action: `${action}.${outcome}`,
    targetType: 'session',
    targetId: null,
    ipAddress: context.ipAddress,
    metadata: {
      status: context.status,
      ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 300) } : {}),
    },
  });
}
