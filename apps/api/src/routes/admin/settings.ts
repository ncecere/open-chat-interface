import { type InstanceSettings, updateInstanceSettingsSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { encryptSecret } from '../../lib/crypto.js';
import { providerError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getSetting, updateSetting } from '../../services/settings.js';
import {
  applyS3SettingsPatch,
  getS3ConfigurationIssues,
  toPublicS3Settings,
} from '../../services/storage/config.js';
import { invalidateStorageDriver, testConfiguredS3Storage } from '../../services/storage/index.js';

export const settingsRoutes = new Hono<AppBindings>();

const storageTestSchema = z.object({
  mode: z.enum(['read', 'write']).default('read'),
});

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
    colorTheme: branding.colorTheme,
    registrationMode: authSettings.registrationMode,
    emailVerificationRequired: authSettings.emailVerificationRequired,
    localAuthEnabled: authSettings.localAuthEnabled,
    defaultSystemPrompt: chat.defaultSystemPrompt,
    features,
    storage: {
      driver: storage.driver,
      maxFileBytes: storage.maxFileBytes,
      maxFilesPerMessage: storage.maxFilesPerMessage,
      allowedMimeTypes: storage.allowedMimeTypes,
      s3: toPublicS3Settings(storage.s3),
    },
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

settingsRoutes.post('/storage/test', async (c) => {
  const actor = currentUser(c);
  const { mode } = await parseBody(c, storageTestSchema);
  const storage = await getSetting('storage');
  const issues = getS3ConfigurationIssues(storage.s3);
  if (issues.length > 0) {
    throw validationFailed(
      'Complete the required S3 settings before testing the connection.',
      issues.map((issue) => ({ path: ['storage', 's3', issue.field], message: issue.message })),
    );
  }

  try {
    await testConfiguredS3Storage(mode);
  } catch (error) {
    logger.warn({ error, mode }, 'S3 storage health check failed');
    throw providerError(
      mode === 'write'
        ? 'S3 put/read/delete test failed. Verify the endpoint, bucket, credentials, and object permissions.'
        : 'S3 read-only bucket check failed. Verify the endpoint, bucket, credentials, and bucket permissions.',
    );
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'storage.test',
    targetType: 'instance',
    metadata: { mode },
  });

  return c.json({ ok: true, mode });
});

settingsRoutes.patch('/', async (c) => {
  const actor = currentUser(c);
  const patch = await parseBody(c, updateInstanceSettingsSchema);

  if (
    patch.appName !== undefined ||
    patch.logoUrl !== undefined ||
    patch.accentColor !== undefined ||
    patch.loginMessage !== undefined ||
    patch.defaultTheme !== undefined ||
    patch.colorTheme !== undefined
  ) {
    await updateSetting('branding', {
      ...(patch.appName !== undefined && { appName: patch.appName }),
      ...(patch.logoUrl !== undefined && { logoUrl: patch.logoUrl }),
      ...(patch.accentColor !== undefined && { accentColor: patch.accentColor }),
      ...(patch.loginMessage !== undefined && { loginMessage: patch.loginMessage }),
      ...(patch.defaultTheme !== undefined && { defaultTheme: patch.defaultTheme }),
      ...(patch.colorTheme !== undefined && { colorTheme: patch.colorTheme }),
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
    const current = await getSetting('storage');
    const { s3: s3Patch, ...storagePatch } = patch.storage;
    let s3 = current.s3;

    if (s3Patch) {
      s3 = applyS3SettingsPatch(current.s3, s3Patch, encryptSecret);
    }

    const next = { ...current, ...storagePatch, s3 };
    if (next.driver === 's3') {
      const issues = getS3ConfigurationIssues(next.s3);
      if (issues.length > 0) {
        throw validationFailed(
          'Complete the required S3 settings before selecting the S3 driver.',
          issues.map((issue) => ({
            path: ['storage', 's3', issue.field],
            message: issue.message,
          })),
        );
      }
    }

    await updateSetting('storage', next);
    invalidateStorageDriver();
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
