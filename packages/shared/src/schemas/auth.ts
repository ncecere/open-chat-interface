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
    }),
  ),
  branding: z.object({
    appName: z.string(),
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
