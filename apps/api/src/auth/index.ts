import { sso } from '@better-auth/sso';
import { eq, schema } from '@oci/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin as adminPlugin } from 'better-auth/plugins';
import { loadEnv } from '../config/env.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email.js';
import { getDefaultOrganizationId } from '../services/organization.js';
import { getSetting } from '../services/settings.js';
import { ac, roles } from './permissions.js';
import { enforceAuthRequestPolicy, isEmailVerificationEnforced } from './policy.js';
import { applySsoProvisioning, SsoRoleRequiredError } from './provisioning.js';

const env = loadEnv();

/**
 * The claims a role mapping can be written against.
 *
 * `token` carries OAuth tokens rather than identity, and `userInfo` is
 * normalised by the plugin down to id, email, name, and image — so group
 * membership survives in neither. Decoding the id token recovers the full set
 * the provider actually asserted, which is where a claim such as `groups`
 * lives.
 *
 * The decode is not verified here because the plugin has already validated the
 * same token against the provider's JWKS before this runs; re-verifying would
 * duplicate that work without adding a check.
 */
function ssoClaims(source: {
  token?: unknown;
  userInfo?: unknown;
}): Record<string, unknown> | undefined {
  const userInfo = (source.userInfo ?? {}) as Record<string, unknown>;
  const idToken = (source.token as { idToken?: unknown } | undefined)?.idToken;

  if (typeof idToken !== 'string') {
    return Object.keys(userInfo).length > 0 ? userInfo : undefined;
  }

  try {
    const payload = idToken.split('.')[1];
    if (!payload) return userInfo;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    // userInfo last: the plugin may have applied an administrator's own
    // mapping, which should win over the raw claim of the same name.
    return { ...decoded, ...userInfo };
  } catch (error) {
    logger.warn({ error }, 'Could not decode the SSO id token; falling back to userInfo');
    return userInfo;
  }
}

function configuredTrustedOrigins(): string[] {
  const configured = env.AUTH_TRUSTED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([env.APP_URL, ...(configured ?? [])].map((origin) => new URL(origin).origin))];
}

export const auth = betterAuth({
  appName: 'Open Chat Interface',
  baseURL: env.APP_URL,
  basePath: '/api/auth',
  secret: env.AUTH_SECRET,
  // Internal/self-hosted IdPs must be explicitly allowlisted to permit OIDC
  // discovery while retaining Better Auth's private-network SSRF protection.
  trustedOrigins: configuredTrustedOrigins(),

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      ssoProvider: schema.ssoProvider,
    },
  }),

  user: {
    additionalFields: {
      organizationId: { type: 'string', required: false, input: false },
      lastSeenAt: { type: 'date', required: false, input: false },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Every user belongs to the single seeded organization.
          const organizationId = await getDefaultOrganizationId();
          return { data: { ...user, organizationId } };
        },
      },
    },
    session: {
      create: {
        /**
         * Applies the configured session lifetime as each session is issued.
         *
         * The static `session.expiresIn` below is fixed when this object is
         * built, so it cannot follow a setting an administrator changes later.
         * Stamping the expiry here means a change takes effect on the next
         * sign-in rather than on the next restart.
         *
         * Sessions already issued keep their original expiry; shortening the
         * lifetime does not retroactively end them.
         */
        before: async (session) => {
          try {
            const { sessionLifetimeDays } = await getSetting('auth');
            const expiresAt = new Date(Date.now() + sessionLifetimeDays * 24 * 60 * 60 * 1000);
            return { data: { ...session, expiresAt } };
          } catch (error) {
            // Falling back to the static lifetime is safe; refusing to issue a
            // session because a setting could not be read is not.
            logger.error({ error }, 'Could not read session lifetime; using the default');
            return { data: session };
          }
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 200,
    autoSignIn: true,
    // This value is safely overridden on each request by the before hook.
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, url });
    },
  },

  emailVerification: {
    autoSignInAfterVerification: true,
    // Always enter this callback on sign-up. When verification is not viable,
    // mark the account verified so enabling SMTP later does not lock it out.
    sendOnSignUp: true,
    sendOnSignIn: true,
    sendVerificationEmail: async ({ user, url }) => {
      const enforced = await isEmailVerificationEnforced();
      const result = enforced
        ? await sendVerificationEmail({ to: user.email, url })
        : { delivered: false };

      if (!enforced || !result.delivered) {
        await db
          .update(schema.user)
          .set({ emailVerified: true })
          .where(eq(schema.user.id, user.id));
        if (enforced) {
          logger.warn({ userId: user.id }, 'Verification email failed; account left accessible');
        }
      }
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const policy = await enforceAuthRequestPolicy(
        ctx.path,
        ctx.body as Record<string, unknown> | undefined,
      );
      if (!policy) return;

      // Better Auth options are otherwise static. Return a request-scoped copy
      // instead of mutating the shared options object (which would race under
      // concurrent sign-ins with different policy outcomes).
      return {
        context: {
          options: {
            ...ctx.context.options,
            emailAndPassword: {
              ...ctx.context.options.emailAndPassword,
              requireEmailVerification: policy.requireEmailVerification,
            },
          },
        },
      };
    }),
  },

  session: {
    // Fallback only. The database hook above stamps the configured lifetime on
    // each session as it is created.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },

  advanced: {
    cookiePrefix: 'oci',
    database: { generateId: () => crypto.randomUUID() },
  },

  plugins: [
    adminPlugin({
      ac,
      roles,
      defaultRole: 'user',
      adminRoles: ['admin'],
    }),
    sso({
      /**
       * The SSO plugin links a login to an existing account only when the
       * provider is domain-verified and the email domain matches. OCI drives
       * `domainVerified` from the administrator's "trust for account linking"
       * toggle, so linking stays off until an operator vouches for the IdP.
       */
      domainVerification: { enabled: true },
      provisionUser: async ({ user, token, userInfo, provider }) => {
        try {
          await applySsoProvisioning({
            userId: user.id,
            email: user.email,
            providerId: provider.providerId,
            claims: ssoClaims({ token, userInfo }),
          });
        } catch (error) {
          if (error instanceof SsoRoleRequiredError) {
            // Re-thrown as an APIError carrying a code, which is the only shape
            // the SSO plugin converts into a redirect back to the sign-in page.
            // A plain Error escapes as a 500, so a deliberate refusal would look
            // to the user exactly like the service being broken.
            logger.warn({ userId: user.id }, 'SSO login refused: no role mapping matched');
            throw new APIError('FORBIDDEN', {
              code: 'ROLE_REQUIRED',
              message: error.message,
            });
          }

          logger.error({ error, userId: user.id }, 'SSO provisioning failed');
          throw error;
        }
      },
      provisionUserOnEveryLogin: true,
    }),
  ],
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
