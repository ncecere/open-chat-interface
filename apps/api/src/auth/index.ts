import { sso } from '@better-auth/sso';
import { eq, schema } from '@oci/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { admin as adminPlugin } from 'better-auth/plugins';
import { loadEnv } from '../config/env.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email.js';
import { getDefaultOrganizationId } from '../services/organization.js';
import { ac, roles } from './permissions.js';
import { enforceAuthRequestPolicy, isEmailVerificationEnforced } from './policy.js';
import { applySsoProvisioning } from './provisioning.js';

const env = loadEnv();

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
      provisionUser: async ({ user, token, provider }) => {
        try {
          await applySsoProvisioning({
            userId: user.id,
            email: user.email,
            providerId: provider.providerId,
            claims: (token as Record<string, unknown> | undefined) ?? undefined,
          });
        } catch (error) {
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
