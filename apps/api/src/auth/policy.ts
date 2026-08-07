import { eq, schema } from '@oci/db';
import { APIError } from 'better-auth/api';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { isSmtpUsable } from '../services/email.js';
import { type AuthSettings, getSetting } from '../services/settings.js';

interface LocalUserPolicy {
  role: string;
  emailVerified: boolean;
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

async function localUserPolicy(email: string | null): Promise<LocalUserPolicy | null> {
  if (!email) return null;
  const [user] = await db
    .select({ role: schema.user.role, emailVerified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  return user ?? null;
}

/**
 * Administrators are an intentional local-auth break glass path. This covers
 * both the seeded administrator and an account promoted by the recovery CLI.
 */
function isRecoveryAdmin(user: LocalUserPolicy | null): boolean {
  return user?.role === 'admin' && user.emailVerified;
}

/** Fail open if settings storage is unavailable: auth policy must not lock out recovery. */
export async function isEmailVerificationEnforced(): Promise<boolean> {
  try {
    const [settings, smtpUsable] = await Promise.all([getSetting('auth'), isSmtpUsable()]);
    return settings.emailVerificationRequired && smtpUsable;
  } catch (error) {
    logger.error({ error }, 'Could not resolve email verification policy; allowing sign-in');
    return false;
  }
}

export interface AuthRequestPolicy {
  requireEmailVerification: boolean;
}

/**
 * Better Auth resolves `requireEmailVerification` from its static options, so a
 * request-scoped option override does not reach the sign-in handler. Enforce
 * the database-backed setting here instead of relying on that override.
 */
function assertEmailVerified(user: LocalUserPolicy | null): void {
  // An unknown email must fall through to Better Auth so invalid credentials
  // and unverified accounts stay indistinguishable.
  if (user && !user.emailVerified) {
    throw new APIError('FORBIDDEN', {
      code: 'EMAIL_NOT_VERIFIED',
      message: 'Verify your email address before signing in',
    });
  }
}

/** Resolve dynamic policy for Better Auth's email/password endpoints. */
export async function enforceAuthRequestPolicy(
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<AuthRequestPolicy | null> {
  if (path !== '/sign-in/email' && path !== '/sign-up/email') return null;

  const email = normalizedEmail(body?.email);
  const user = path === '/sign-in/email' ? await localUserPolicy(email) : null;
  const recoveryAdmin = path === '/sign-in/email' && isRecoveryAdmin(user);

  let settings: AuthSettings;
  try {
    settings = await getSetting('auth');
  } catch (error) {
    // Preserve the administrator recovery path if settings cannot be read.
    logger.error({ error }, 'Could not resolve local authentication policy');
    if (recoveryAdmin) return { requireEmailVerification: false };
    throw new APIError('SERVICE_UNAVAILABLE', {
      code: 'AUTH_POLICY_UNAVAILABLE',
      message: 'Authentication settings are temporarily unavailable',
    });
  }

  if (!settings.localAuthEnabled && !recoveryAdmin) {
    throw new APIError('FORBIDDEN', {
      code: 'LOCAL_AUTH_DISABLED',
      message: 'Email and password sign-in is disabled',
    });
  }

  if (path === '/sign-up/email' && settings.registrationMode !== 'open') {
    throw new APIError('FORBIDDEN', {
      code: 'REGISTRATION_DISABLED',
      message:
        settings.registrationMode === 'invite_only'
          ? 'A valid invitation is required to create an account'
          : 'Account registration is closed',
    });
  }

  const requireEmailVerification = recoveryAdmin ? false : await isEmailVerificationEnforced();
  if (requireEmailVerification && path === '/sign-in/email') assertEmailVerified(user);

  return { requireEmailVerification };
}
