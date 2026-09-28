import { eq, schema } from '@oci/db';
import { APIError } from 'better-auth/api';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
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

/** Missing/malformed storage is unavailable policy, never an implicit opt-out. */
export async function getAuthPolicySettings(): Promise<AuthSettings> {
  try {
    const settings = await getSetting('auth');
    if (
      typeof settings?.emailVerificationRequired !== 'boolean' ||
      typeof settings.localAuthEnabled !== 'boolean' ||
      !['open', 'invite_only', 'closed'].includes(settings.registrationMode)
    ) {
      throw new Error('Invalid authentication policy settings');
    }
    return settings;
  } catch (error) {
    logger.error({ error }, 'Could not resolve authentication policy');
    throw new APIError('SERVICE_UNAVAILABLE', {
      code: 'AUTH_POLICY_UNAVAILABLE',
      message: 'Authentication settings are temporarily unavailable',
    });
  }
}

/** Delivery availability is not permission to waive a configured requirement. */
export async function isEmailVerificationEnforced(): Promise<boolean> {
  return (await getAuthPolicySettings()).emailVerificationRequired;
}

export interface AuthRequestPolicy {
  requireEmailVerification: boolean;
}

/** Resolve dynamic policy for Better Auth's email/password endpoints. */
export async function enforceAuthRequestPolicy(
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<AuthRequestPolicy | null> {
  if (path === '/send-verification-email') {
    // A policy outage must produce the same response for existing and unknown
    // addresses, rather than failing only when the delivery callback runs.
    return { requireEmailVerification: await isEmailVerificationEnforced() };
  }
  if (path !== '/sign-in/email' && path !== '/sign-up/email') return null;

  const email = normalizedEmail(body?.email);
  const user = path === '/sign-in/email' ? await localUserPolicy(email) : null;
  const recoveryAdmin = path === '/sign-in/email' && isRecoveryAdmin(user);

  let settings: AuthSettings;
  try {
    settings = await getAuthPolicySettings();
  } catch (error) {
    // Preserve only the verified administrator recovery path.
    if (recoveryAdmin) return { requireEmailVerification: false };
    throw error;
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

  // The SDK checks the password before refusing an unverified account. Do not
  // expose verification state through a pre-password error in this hook.
  return { requireEmailVerification: recoveryAdmin ? false : settings.emailVerificationRequired };
}
