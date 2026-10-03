import { z } from 'zod';
import { COLOR_THEMES, REGISTRATION_MODES, THEME_MODES, USER_ROLES } from '../constants.js';

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200);

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  rememberMe: z.boolean().optional(),
});

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120),
  inviteToken: z.string().trim().min(1).max(200).optional(),
});

export const requestPasswordResetSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const inviteTokenSchema = z.string().trim().min(32).max(200);

export const validateInviteSchema = z.object({
  token: inviteTokenSchema,
});

export const acceptInviteSchema = z.object({
  token: inviteTokenSchema,
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120),
});

export const authStatusSchema = z.object({
  registrationMode: z.enum(REGISTRATION_MODES),
  emailVerificationRequired: z.boolean(),
  smtpConfigured: z.boolean(),
  localAuthEnabled: z.boolean(),
  ssoProviders: z.array(
    z.object({
      providerId: z.string(),
      label: z.string(),
      kind: z.enum(['oidc', 'saml']),
      iconUrl: z.string().url().nullable(),
      /** Whether the sign-in page should go straight to this provider. */
      autoRedirect: z.boolean().default(false),
    }),
  ),
  branding: z.object({
    appName: z.string(),
    shortName: z.string().nullable(),
    logoUrl: z.string().nullable(),
    loginMessage: z.string().nullable(),
    colorTheme: z.enum(COLOR_THEMES),
    defaultTheme: z.enum(THEME_MODES),
  }),
});

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  role: z.enum(USER_ROLES),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type AuthStatus = z.infer<typeof authStatusSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** Settings → Account: a name a person may set for themselves (v0.9.1). */
export const PROFILE_NAME_MAX_LENGTH = 100;
export const profileNameSchema = z.string().trim().min(1).max(PROFILE_NAME_MAX_LENGTH);

/** How the signed-in person signs in (GET /api/me, `signIn`). */
export const signInMethodsSchema = z.object({
  /** They have a password and may use it now (local sign-in on, or a verified administrator). */
  password: z.boolean(),
  /** They have a password at all, usable or not. */
  credential: z.boolean(),
  /** Organisation sign-in providers linked to the account, by label. */
  sso: z.array(z.string()),
});

/** One place the person is signed in (GET /api/me/sessions). */
export const accountSessionSchema = z.object({
  id: z.string(),
  /** The session this request was made with. */
  current: z.boolean(),
  userAgent: z.string().nullable(),
  /** Shortened (the last part replaced) so the list is safe to show on screen. */
  ipAddress: z.string().nullable(),
  /** Started by an administrator signing in as this person. */
  impersonated: z.boolean(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
});

export type SignInMethods = z.infer<typeof signInMethodsSchema>;
export type AccountSession = z.infer<typeof accountSessionSchema>;
