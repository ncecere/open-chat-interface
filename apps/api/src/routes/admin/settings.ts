import { type InstanceSettings, updateInstanceSettingsSchema } from '@oci/shared';
import { Hono } from 'hono';
import { encryptSecret } from '../../lib/crypto.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getSetting, updateSetting } from '../../services/settings.js';

export const settingsRoutes = new Hono<AppBindings>();

settingsRoutes.get('/', async (c) => {
  const [branding, authSettings, features, storage, search, smtp, chat] = await Promise.all([
    getSetting('branding'),
    getSetting('auth'),
    getSetting('features'),
    getSetting('storage'),
    getSetting('search'),
    getSetting('smtp'),
    getSetting('chat'),
  ]);

  const payload: InstanceSettings = {
    appName: branding.appName,
    logoUrl: branding.logoUrl,
    accentColor: branding.accentColor,
    loginMessage: branding.loginMessage,
    defaultTheme: branding.defaultTheme,
    registrationMode: authSettings.registrationMode,
    emailVerificationRequired: authSettings.emailVerificationRequired,
    localAuthEnabled: authSettings.localAuthEnabled,
    defaultSystemPrompt: chat.defaultSystemPrompt,
    features,
    storage,
    search: {
      enabled: search.enabled,
      provider: search.provider,
      baseUrl: search.baseUrl,
      hasCredential: Boolean(search.encryptedApiKey),
      maxResults: search.maxResults,
    },
    smtp: {
      configured: Boolean(smtp.host && smtp.port && smtp.fromAddress),
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      fromAddress: smtp.fromAddress,
    },
  };

  return c.json(payload);
});

settingsRoutes.patch('/', async (c) => {
  const actor = currentUser(c);
  const patch = await parseBody(c, updateInstanceSettingsSchema);

  if (
    patch.appName !== undefined ||
    patch.logoUrl !== undefined ||
    patch.accentColor !== undefined ||
    patch.loginMessage !== undefined ||
    patch.defaultTheme !== undefined
  ) {
    await updateSetting('branding', {
      ...(patch.appName !== undefined && { appName: patch.appName }),
      ...(patch.logoUrl !== undefined && { logoUrl: patch.logoUrl }),
      ...(patch.accentColor !== undefined && { accentColor: patch.accentColor }),
      ...(patch.loginMessage !== undefined && { loginMessage: patch.loginMessage }),
      ...(patch.defaultTheme !== undefined && { defaultTheme: patch.defaultTheme }),
    });
  }

  if (
    patch.registrationMode !== undefined ||
    patch.emailVerificationRequired !== undefined ||
    patch.localAuthEnabled !== undefined
  ) {
    await updateSetting('auth', {
      ...(patch.registrationMode !== undefined && { registrationMode: patch.registrationMode }),
      ...(patch.emailVerificationRequired !== undefined && {
        emailVerificationRequired: patch.emailVerificationRequired,
      }),
      ...(patch.localAuthEnabled !== undefined && { localAuthEnabled: patch.localAuthEnabled }),
    });
  }

  if (patch.defaultSystemPrompt !== undefined) {
    await updateSetting('chat', { defaultSystemPrompt: patch.defaultSystemPrompt });
  }

  if (patch.features) {
    await updateSetting('features', patch.features);
  }

  if (patch.storage) {
    await updateSetting('storage', patch.storage);
  }

  if (patch.search) {
    const { apiKey, ...rest } = patch.search;
    await updateSetting('search', {
      ...rest,
      ...(apiKey !== undefined && {
        encryptedApiKey: apiKey ? encryptSecret(apiKey) : null,
      }),
    });
  }

  if (patch.smtp) {
    const { password, ...rest } = patch.smtp;
    await updateSetting('smtp', {
      ...rest,
      ...(password !== undefined && {
        encryptedPassword: password ? encryptSecret(password) : null,
      }),
    });
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'settings.update',
    targetType: 'instance',
    metadata: { keys: Object.keys(patch) },
  });

  return c.json({ ok: true });
});
