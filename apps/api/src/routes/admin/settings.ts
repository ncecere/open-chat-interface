import {
  DEFAULT_MAX_TOOL_STEPS,
  type InstanceSettings,
  SEARCH_PROVIDERS,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { encryptSecret } from '../../lib/crypto.js';
import { providerError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { publicLogoUrl, storeInstanceLogo } from '../../services/branding-assets.js';
import { getSetting, updateSetting } from '../../services/settings.js';
import { diffSettings, redactSecrets } from '../../services/settings-diff.js';
import {
  applyS3SettingsPatch,
  getS3ConfigurationIssues,
  toPublicS3Settings,
} from '../../services/storage/config.js';
import { invalidateStorageDriver, testConfiguredS3Storage } from '../../services/storage/index.js';

export const settingsRoutes = new Hono<AppBindings>();

const AUTH_SETTING_KEYS = new Set([
  'registrationMode',
  'emailVerificationRequired',
  'localAuthEnabled',
  'sessionLifetimeDays',
  'sessionRefreshDays',
]);

const storageTestSchema = z.object({
  mode: z.enum(['read', 'write']).default('read'),
});

/**
 * The settings as they stand, flattened to the shape a patch arrives in.
 *
 * Mirrors the request body rather than the stored objects so a change can be
 * compared key for key. Nested branches are compared whole, which is enough to
 * show that storage or search configuration changed and what it was.
 */
async function currentSettingsSnapshot(): Promise<Record<string, unknown>> {
  const [branding, authSettings, features, storage, search, smtp, chat] = await Promise.all([
    getSetting('branding'),
    getSetting('auth'),
    getSetting('features'),
    getSetting('storage'),
    getSetting('search'),
    getSetting('smtp'),
    getSetting('chat'),
  ]);

  return {
    ...branding,
    ...authSettings,
    defaultSystemPrompt: chat.defaultSystemPrompt,
    defaultEffort: chat.defaultEffort ?? 'instant',
    maxToolSteps: chat.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS,
    features,
    // Redacted here rather than at the diff, because these arrive as whole
    // objects and carry encrypted credentials inside them.
    storage: redactSecrets(storage),
    search: redactSecrets(search),
    smtp: redactSecrets(smtp),
  };
}

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
    shortName: branding.shortName,
    logoUrl: publicLogoUrl(branding.logoUrl),
    accentColor: branding.accentColor,
    loginMessage: branding.loginMessage,
    defaultTheme: branding.defaultTheme,
    colorTheme: branding.colorTheme,
    registrationMode: authSettings.registrationMode,
    emailVerificationRequired: authSettings.emailVerificationRequired,
    localAuthEnabled: authSettings.localAuthEnabled,
    sessionLifetimeDays: authSettings.sessionLifetimeDays,
    sessionRefreshDays: authSettings.sessionRefreshDays,
    defaultSystemPrompt: chat.defaultSystemPrompt,
    defaultEffort: chat.defaultEffort ?? 'instant',
    maxToolSteps: chat.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS,
    features,
    storage: {
      driver: storage.driver,
      // Read-only: the path has to exist inside the container, so it stays
      // deployment-managed. Showing it saves an administrator from guessing
      // which volume to back up.
      localPath: loadEnv().STORAGE_LOCAL_PATH,
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

  // Captured before anything is written, so the audit entry can say what the
  // value was as well as what it became.
  const previous = await currentSettingsSnapshot();

  if (
    patch.appName !== undefined ||
    patch.shortName !== undefined ||
    patch.logoUrl !== undefined ||
    patch.accentColor !== undefined ||
    patch.loginMessage !== undefined ||
    patch.defaultTheme !== undefined ||
    patch.colorTheme !== undefined
  ) {
    await updateSetting('branding', {
      ...(patch.appName !== undefined && { appName: patch.appName }),
      ...(patch.shortName !== undefined && { shortName: patch.shortName }),
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
    patch.localAuthEnabled !== undefined ||
    patch.sessionLifetimeDays !== undefined ||
    patch.sessionRefreshDays !== undefined
  ) {
    await updateSetting('auth', {
      ...(patch.registrationMode !== undefined && { registrationMode: patch.registrationMode }),
      ...(patch.emailVerificationRequired !== undefined && {
        emailVerificationRequired: patch.emailVerificationRequired,
      }),
      ...(patch.localAuthEnabled !== undefined && { localAuthEnabled: patch.localAuthEnabled }),
      ...(patch.sessionLifetimeDays !== undefined && {
        sessionLifetimeDays: patch.sessionLifetimeDays,
      }),
      ...(patch.sessionRefreshDays !== undefined && {
        sessionRefreshDays: patch.sessionRefreshDays,
      }),
    });
  }

  if (
    patch.defaultSystemPrompt !== undefined ||
    patch.defaultEffort !== undefined ||
    patch.maxToolSteps !== undefined
  ) {
    await updateSetting('chat', {
      ...(patch.defaultSystemPrompt !== undefined && {
        defaultSystemPrompt: patch.defaultSystemPrompt,
      }),
      ...(patch.defaultEffort !== undefined && { defaultEffort: patch.defaultEffort }),
      ...(patch.maxToolSteps !== undefined && { maxToolSteps: patch.maxToolSteps }),
    });
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
    const stored = await getSetting('search');
    const provider = rest.provider === undefined ? stored.provider : rest.provider;
    const needs = provider ? SEARCH_PROVIDERS[provider].needs : null;
    const switched = rest.provider !== undefined && rest.provider !== stored.provider;
    await updateSetting('search', {
      ...rest,
      // Store only what the selected provider uses. A key belongs to one
      // provider, so switching drops it rather than sending it elsewhere.
      ...(needs !== 'baseUrl' && { baseUrl: null }),
      ...((switched || needs !== 'apiKey') && { encryptedApiKey: null }),
      ...(apiKey !== undefined &&
        needs === 'apiKey' && { encryptedApiKey: apiKey ? encryptSecret(apiKey) : null }),
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

  const changes = diffSettings(previous, patch as Record<string, unknown>);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'settings.update',
    targetType: 'instance',
    metadata: { keys: Object.keys(patch), changes },
  });

  // Sign-in policy is security configuration. A separate protected entry keeps
  // it beyond routine audit retention, which prunes ordinary settings changes.
  const authKeys = Object.keys(patch).filter((key) => AUTH_SETTING_KEYS.has(key));
  if (authKeys.length > 0) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'settings.auth.update',
      targetType: 'instance',
      metadata: {
        keys: authKeys,
        changes: changes.filter((change) => AUTH_SETTING_KEYS.has(change.key)),
      },
    });
  }

  return c.json({ ok: true });
});

/**
 * Uploads an instance logo.
 *
 * Stored rather than linked, so branding does not break when an external host
 * changes. The previous file is left in place: it is a single small object,
 * and deleting it eagerly would break any page still holding the old URL.
 */
settingsRoutes.post('/logo', async (c) => {
  const actor = currentUser(c);
  const form = await c.req.formData();

  interface UploadedFile {
    name?: string;
    type?: string;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }

  const entry = form.get('file') as unknown as UploadedFile | null;
  if (!entry || typeof entry.arrayBuffer !== 'function') {
    throw validationFailed('No file was provided');
  }

  const stored = await storeInstanceLogo({
    filename: entry.name ?? 'logo',
    declaredMimeType: entry.type ?? 'application/octet-stream',
    bytes: Buffer.from(await entry.arrayBuffer()),
  });

  await updateSetting('branding', {
    logoUrl: stored.storageKey,
    logoMimeType: stored.mimeType,
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'settings.branding.logo.upload',
    targetType: 'settings',
    targetId: 'branding',
    metadata: { sizeBytes: stored.sizeBytes, mimeType: stored.mimeType },
  });

  return c.json({ ok: true });
});
