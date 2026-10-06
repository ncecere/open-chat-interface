import { eq, schema } from '@oci/db';
import { APIError } from 'better-auth/api';
import { db } from '../db/index.js';
import { isConnectionError } from '../lib/db-connection.js';
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
    // An unreachable database is an outage, not a policy problem: passed on,
    // the API answers it as a lost connection (500, retryable), not with a
    // 503, which takes the replica out of the proxy's rotation (#288).
    if (isConnectionError(error)) throw error;
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

/** How a person signs in, from their linked accounts (Settings → Account). */
export interface SignInMethods {
  /** They have a password (a `credential` account) and may use it right now. */
  password: boolean;
  /** They have a password at all, whether or not local sign-in allows it. */
  credential: boolean;
  /** The organisation sign-in providers linked to the account, by label. */
  sso: string[];
}

const CREDENTIAL_PROVIDER = 'credential';

async function linkedAccounts(userId: string) {
  return db
    .select({ providerId: schema.account.providerId, label: schema.ssoProvider.label })
    .from(schema.account)
    .leftJoin(schema.ssoProvider, eq(schema.ssoProvider.providerId, schema.account.providerId))
    .where(eq(schema.account.userId, userId));
}

/**
 * Whether a password may be used now: local sign-in is on, or the person is a
 * verified administrator (the break-glass path above). An unreadable policy
 * leaves only that break-glass path, as sign-in does.
 */
async function passwordUsable(user: LocalUserPolicy): Promise<boolean> {
  if (isRecoveryAdmin(user)) return true;
  try {
    return (await getAuthPolicySettings()).localAuthEnabled;
  } catch {
    return false;
  }
}

export async function signInMethodsFor(user: {
  id: string;
  role: string;
  emailVerified: boolean;
}): Promise<SignInMethods> {
  const accounts = await linkedAccounts(user.id);
  const credential = accounts.some((account) => account.providerId === CREDENTIAL_PROVIDER);
  const sso = [
    ...new Set(
      accounts
        .filter((account) => account.providerId !== CREDENTIAL_PROVIDER)
        .map((account) => account.label?.trim() || account.providerId),
    ),
  ];
  return { password: credential && (await passwordUsable(user)), credential, sso };
}

export const MAX_PROFILE_NAME_LENGTH = 100;

/**
 * Rules for Better Auth endpoints a signed-in person calls about themselves,
 * so Settings → Account is not the only thing enforcing them:
 *
 * - `/change-password` needs a usable password: local sign-in on, or a
 *   verified administrator.
 * - `/update-user` changes the name only (1–100 characters, trimmed), and
 *   only on an account that does not sign in through the organisation, whose
 *   name comes from there.
 *
 * Returns a replacement body for `/update-user`, otherwise null.
 */
export async function enforceSelfServicePolicy(
  path: string,
  userId: string | null,
  body: Record<string, unknown> | undefined,
): Promise<{ body: Record<string, unknown> } | null> {
  if (path !== '/change-password' && path !== '/update-user') return null;
  // Better Auth answers an anonymous request with its own 401.
  if (!userId) return null;

  const [user] = await db
    .select({ role: schema.user.role, emailVerified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  if (!user) return null;

  if (path === '/change-password') {
    if (isRecoveryAdmin(user)) return null;
    // A policy outage refuses (getAuthPolicySettings throws), as sign-in does.
    if (!(await getAuthPolicySettings()).localAuthEnabled) {
      throw new APIError('FORBIDDEN', {
        code: 'LOCAL_AUTH_DISABLED',
        message: 'Email and password sign-in is turned off on this instance',
      });
    }
    return null;
  }

  const keys = Object.keys(body ?? {});
  if (keys.length !== 1 || keys[0] !== 'name' || typeof body?.name !== 'string') {
    throw new APIError('BAD_REQUEST', {
      code: 'PROFILE_NAME_ONLY',
      message: 'Only your name can be changed here',
    });
  }
  const name = body.name.trim();
  if (name.length < 1 || name.length > MAX_PROFILE_NAME_LENGTH) {
    throw new APIError('BAD_REQUEST', {
      code: 'INVALID_NAME',
      message: `Your name must be 1 to ${MAX_PROFILE_NAME_LENGTH} characters`,
    });
  }
  const methods = await signInMethodsFor({ id: userId, ...user });
  if (!methods.credential || methods.sso.length > 0) {
    throw new APIError('FORBIDDEN', {
      code: 'PROFILE_MANAGED_BY_SSO',
      message: "Your name comes from your organisation's sign-in",
    });
  }
  return { body: { name } };
}
