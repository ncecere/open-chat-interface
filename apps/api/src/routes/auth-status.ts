import { eq, schema } from '@oci/db';
import { type AuthStatus, acceptInviteSchema, validateInviteSchema } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../db/index.js';
import type { AppBindings } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { isSmtpUsable } from '../services/email.js';
import { acceptInvitation, validateInvitation } from '../services/invitations.js';
import { getSetting } from '../services/settings.js';

export const authStatusRoutes = new Hono<AppBindings>();

authStatusRoutes.post('/accept-invite/validate', async (c) => {
  const { token } = await parseBody(c, validateInviteSchema);
  return c.json(await validateInvitation(token));
});

authStatusRoutes.post('/accept-invite', async (c) => {
  const input = await parseBody(c, acceptInviteSchema);
  return c.json(await acceptInvitation(input), 201);
});

/**
 * Public bootstrap payload for the login screen: which auth methods exist and
 * how the instance is branded.
 */
authStatusRoutes.get('/status', async (c) => {
  const [authSettings, branding, smtpConfigured, providers] = await Promise.all([
    getSetting('auth'),
    getSetting('branding'),
    isSmtpUsable(),
    db
      .select({
        providerId: schema.ssoProvider.providerId,
        label: schema.ssoProvider.label,
        kind: schema.ssoProvider.kind,
      })
      .from(schema.ssoProvider)
      .where(eq(schema.ssoProvider.enabled, true)),
  ]);

  const payload: AuthStatus = {
    registrationMode: authSettings.registrationMode,
    emailVerificationRequired: authSettings.emailVerificationRequired && smtpConfigured,
    smtpConfigured,
    localAuthEnabled: authSettings.localAuthEnabled,
    ssoProviders: providers.map((provider) => ({
      providerId: provider.providerId,
      label: provider.label || provider.providerId,
      kind: provider.kind === 'saml' ? 'saml' : 'oidc',
      iconUrl: null,
    })),
    branding: {
      appName: branding.appName,
      logoUrl: branding.logoUrl,
      loginMessage: branding.loginMessage,
      colorTheme: branding.colorTheme,
      defaultTheme: branding.defaultTheme,
    },
  };

  return c.json(payload);
});
