import { eq, schema } from '@oci/db';
import type { AuthStatus } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../db/index.js';
import type { AppBindings } from '../middleware/context.js';
import { isSmtpConfigured } from '../services/email.js';
import { getSetting } from '../services/settings.js';

export const authStatusRoutes = new Hono<AppBindings>();

/**
 * Public bootstrap payload for the login screen: which auth methods exist and
 * how the instance is branded.
 */
authStatusRoutes.get('/status', async (c) => {
  const [authSettings, branding, smtpConfigured, providers] = await Promise.all([
    getSetting('auth'),
    getSetting('branding'),
    isSmtpConfigured(),
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
    },
  };

  return c.json(payload);
});
