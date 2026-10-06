import { sso } from '@better-auth/sso';
import { schema } from '@oci/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin as adminPlugin } from 'better-auth/plugins';
import { loadEnv } from '../config/env.js';
import { db } from '../db/index.js';
import { clientIpFromHeaders } from '../lib/client-ip.js';
import { logger } from '../lib/logger.js';
import {
  RESET_LINK_TTL_SECONDS,
  sendPasswordResetEmail,
  VERIFY_LINK_TTL_SECONDS,
} from '../services/email.js';
import { getDefaultOrganizationId } from '../services/organization.js';
import { getSetting } from '../services/settings.js';
import { recordAuthEvent } from './audit.js';
import { deliverVerificationEmail } from './email-verification.js';
import { logBetterAuth } from './log.js';
import { ac, roles } from './permissions.js';
import { enforceAuthRequestPolicy, enforceSelfServicePolicy } from './policy.js';
import { applySsoProvisioning, SsoRoleRequiredError } from './provisioning.js';
import { assertSsoLinkAllowed } from './sso-linking.js';

const env = loadEnv();

/** Signing in with a banned account (docs/user/getting-started.md). */
export const BANNED_USER_MESSAGE =
  'This account has been suspended, so it cannot sign in. If you think this is a mistake, ask an administrator of this service.';

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
  // Through the application logger and its redaction: Better Auth's console
  // logger printed a failed session lookup with the raw session token (#264).
  // No `level` here: setting one also makes Better Auth echo API errors to its
  // console logger.
  logger: { log: logBetterAuth },

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
    account: {
      create: {
        // "Trust for account linking": an untrusted SSO provider may not attach
        // its login to an account that already exists (auth/sso-linking.ts).
        before: async (account) => {
          await assertSsoLinkAllowed(account);
        },
      },
    },
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
    // Set here, not left to Better Auth's default, because the email states it (#184).
    resetPasswordTokenExpiresIn: RESET_LINK_TTL_SECONDS,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({
        to: user.email,
        url,
        expiresInSeconds: RESET_LINK_TTL_SECONDS,
      });
    },
    // A reset is what someone uses after losing control of their account, so
    // it ends every session, as Change Password does with "Sign out of all
    // other devices" ticked; the person signs in again with the new password
    // (#139).
    revokeSessionsOnPasswordReset: true,
  },

  emailVerification: {
    // Set here, not left to Better Auth's default, because the email states it (#236).
    expiresIn: VERIFY_LINK_TTL_SECONDS,
    autoSignInAfterVerification: true,
    sendOnSignUp: true,
    sendOnSignIn: true,
    sendVerificationEmail: (data) => deliverVerificationEmail(data),
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/change-password' || ctx.path === '/update-user') {
        const session = await getSessionFromCtx(ctx).catch(() => null);
        const replaced = await enforceSelfServicePolicy(
          ctx.path,
          session?.user?.id ?? null,
          ctx.body as Record<string, unknown> | undefined,
        );
        return replaced ? { context: { body: replaced.body } } : undefined;
      }

      const policy = await enforceAuthRequestPolicy(
        ctx.path,
        ctx.body as Record<string, unknown> | undefined,
      );
      if (!policy) return;

      // The hook return patches the endpoint context, whose `context` field is
      // the AuthContext. Returning options one level higher silently leaves the
      // SDK's signup auto-session policy unchanged. Never mutate shared options.
      return {
        context: {
          context: {
            options: {
              ...ctx.context.options,
              emailVerification: {
                ...ctx.context.options.emailVerification,
                sendVerificationEmail: (data: Parameters<typeof deliverVerificationEmail>[0]) =>
                  deliverVerificationEmail(data, policy.requireEmailVerification),
              },
              emailAndPassword: {
                ...ctx.context.options.emailAndPassword,
                requireEmailVerification: policy.requireEmailVerification,
              },
            },
          },
        },
      };
    }),

    /**
     * Records the outcome of each authentication request.
     *
     * Placed here rather than at each call site because Better Auth owns these
     * routes: there is no handler of ours to add it to, and a hook sees every
     * path including ones added by a plugin later.
     */
    after: createAuthMiddleware(async (ctx) => {
      // A failure returns an APIError carrying `statusCode`, not a Response.
      // Checking only for a Response records every failed attempt as a success,
      // which is precisely backwards for the events worth having.
      const returned = ctx.context.returned as { status?: number; statusCode?: number } | undefined;
      const status = returned instanceof Response ? returned.status : (returned?.statusCode ?? 200);
      // A new session (sign-in, or a password change that signs other devices
      // out) names the actor; otherwise the session the request was made with.
      const session = ctx.context.newSession ?? ctx.context.session;

      await recordAuthEvent({
        path: ctx.path,
        status,
        ipAddress: clientIpFromHeaders(ctx.headers),
        userAgent: ctx.headers?.get('user-agent') ?? null,
        actorUserId: session?.user?.id ?? null,
        // Falls back to the submitted address so a failed attempt still says
        // which account was tried, which is the point of recording it.
        actorEmail:
          session?.user?.email ??
          (typeof (ctx.body as { email?: unknown } | undefined)?.email === 'string'
            ? (ctx.body as { email: string }).email
            : null),
      });
    }),
  },

  session: {
    // Fallback only. The database hook above stamps the configured lifetime on
    // each session as it is created.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    /**
     * Off: every request reads the session and the person from the database,
     * so a role change, a ban or an ended session applies on the next request
     * on every replica. With the cache on (it was five minutes), the signed
     * `session_data` cookie answered instead, and the API authorizes from what
     * getSession returns (middleware/context.ts), so a demoted administrator
     * kept administering for up to five minutes. Measured: about 0.2 ms more
     * per request (session-revocation.live.test.ts).
     */
    cookieCache: { enabled: false },
  },

  /**
   * Better Auth's own limiter is off: OCI's (middleware/auth-rate-limit.ts)
   * is the only one. Better Auth's counted three sign-ins per address per ten
   * seconds in each replica's memory, in production only, so a campus behind
   * one NAT address was refused on its first morning (v0.11 design, item 22),
   * and with several replicas the limit was per replica. OCI's limits live in
   * Redis, count failed attempts per account, give an address far more room,
   * and budget single sign-on per identity provider.
   */
  rateLimit: { enabled: false },

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
      // Better Auth's default sends people to a "support" this instance does
      // not have (#165).
      bannedUserMessage: BANNED_USER_MESSAGE,
    }),
    sso({
      /**
       * With domain verification on, the plugin refuses every sign-in from a
       * provider whose `domainVerified` is false, and links a login to an
       * existing account when it is true and the email domain matches. OCI
       * keeps `domainVerified` true for every provider, so they can all sign
       * people in, and enforces "trust for account linking" itself in the
       * account hook above (auth/sso-linking.ts).
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
