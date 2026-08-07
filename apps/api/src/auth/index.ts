import { sso } from '@better-auth/sso';
import { schema } from '@oci/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin as adminPlugin } from 'better-auth/plugins';
import { loadEnv } from '../config/env.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email.js';
import { getDefaultOrganizationId } from '../services/organization.js';
import { getSetting } from '../services/settings.js';
import { ac, roles } from './permissions.js';
import { applySsoProvisioning } from './provisioning.js';

const env = loadEnv();

export const auth = betterAuth({
  appName: 'Open Chat Interface',
  baseURL: env.APP_URL,
  basePath: '/api/auth',
  secret: env.AUTH_SECRET,
  trustedOrigins: [env.APP_URL],

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
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, url });
    },
  },

  emailVerification: {
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const { emailVerificationRequired } = await getSetting('auth');
      if (!emailVerificationRequired) return;
      await sendVerificationEmail({ to: user.email, url });
    },
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
