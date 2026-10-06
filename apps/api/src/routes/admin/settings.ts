import {
  DEFAULT_MAX_TOOL_STEPS,
  type InstanceSettings,
  SEARCH_PROVIDERS,
  type SearchProviderKind,
  type SearchTestResult,
  searchTestSchema,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { encryptSecret } from '../../lib/crypto.js';
import { AppError, providerError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { publicLogoUrl, storeInstanceLogo } from '../../services/branding-assets.js';
import { sendTestEmail } from '../../services/email.js';
import {
  runSearch,
  storedFallbackSearchKey,
  storedSearchKey,
} from '../../services/search/index.js';
import { getSetting, type SearchSettings, updateSetting } from '../../services/settings.js';
import { diffSettings, redactSecrets } from '../../services/settings-diff.js';
import {
  applyS3SettingsPatch,
  getS3ConfigurationIssues,
  toPublicS3Settings,
} from '../../services/storage/config.js';
import { invalidateStorageDriver, testConfiguredS3Storage } from '../../services/storage/index.js';

/** A neutral query that every provider answers. */
const SEARCH_TEST_QUERY = 'Wikipedia';

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
    autoCompact: chat.autoCompact ?? true,
    diagramGuidance: chat.diagramGuidance ?? true,
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
    autoCompact: chat.autoCompact ?? true,
    diagramGuidance: chat.diagramGuidance ?? true,
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
      fallbackProvider: search.fallbackProvider ?? null,
      fallbackBaseUrl: search.fallbackBaseUrl ?? null,
      hasFallbackCredential: Boolean(search.encryptedFallbackApiKey),
    },
    smtp: {
      configured: Boolean(smtp.host && smtp.port && smtp.fromAddress),
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      fromAddress: smtp.fromAddress,
      // Whether credentials are stored, never the values (#115).
      hasUsername: Boolean(smtp.username),
      hasPassword: Boolean(smtp.encryptedPassword),
    },
  };

  return c.json(payload);
});

/** Sends a test message to the administrator asking, with the saved settings (#115). */
settingsRoutes.post('/smtp/test', async (c) => {
  const actor = currentUser(c);
  const result = await sendTestEmail(actor.email);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'smtp.test',
    targetType: 'instance',
    metadata: { ok: result.ok },
  });
  return c.json(result);
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

/**
 * One sample search with a provider's address or key, on its own: no retry
 * budget is shared and no fallback is tried, so each provider's own result is
 * reported. `storedKey` is used when no key was typed.
 */
async function testSearchProvider(
  target: { provider: SearchProviderKind; baseUrl?: string | null; apiKey?: string },
  storedKey: () => string | null,
): Promise<SearchTestResult> {
  const provider = SEARCH_PROVIDERS[target.provider];
  const apiKey = provider.needs !== 'apiKey' ? null : target.apiKey?.trim() || storedKey();
  const baseUrl = provider.needs === 'baseUrl' ? target.baseUrl?.trim() || null : null;
  try {
    const results = await runSearch(SEARCH_TEST_QUERY, {
      provider: target.provider,
      baseUrl,
      apiKey,
      maxResults: 3,
    });
    return results.length > 0
      ? { ok: true, results: results.length }
      : {
          ok: false,
          message: `${provider.name} answered but returned no results for a test search.`,
        };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof AppError ? error.message : `${provider.name} test search failed.`,
    };
  }
}

/**
 * Runs one sample search with the provider, address and key on the page, so
 * an administrator can check them before or after saving, and the same for
 * the fallback provider when the page has one (v0.10). Nothing is stored.
 */
settingsRoutes.post('/search/test', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, searchTestSchema);
  const stored = await getSetting('search');
  const { fallback } = input;
  const [primary, fallbackResult] = await Promise.all([
    testSearchProvider(input, () =>
      stored.provider === input.provider ? storedSearchKey(stored) : null,
    ),
    fallback
      ? testSearchProvider(fallback, () =>
          stored.fallbackProvider === fallback.provider ? storedFallbackSearchKey(stored) : null,
        )
      : Promise.resolve(undefined),
  ]);
  const result: SearchTestResult = {
    ...primary,
    ...(fallbackResult && { fallback: fallbackResult }),
  };

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'search.test',
    targetType: 'instance',
    metadata: {
      provider: input.provider,
      ok: result.ok,
      ...(fallback &&
        fallbackResult && {
          fallbackProvider: fallback.provider,
          fallbackOk: fallbackResult.ok,
        }),
    },
  });
  return c.json(result);
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
    patch.maxToolSteps !== undefined ||
    patch.autoCompact !== undefined ||
    patch.diagramGuidance !== undefined
  ) {
    await updateSetting('chat', {
      ...(patch.defaultSystemPrompt !== undefined && {
        defaultSystemPrompt: patch.defaultSystemPrompt,
      }),
      ...(patch.defaultEffort !== undefined && { defaultEffort: patch.defaultEffort }),
      ...(patch.maxToolSteps !== undefined && { maxToolSteps: patch.maxToolSteps }),
      ...(patch.autoCompact !== undefined && { autoCompact: patch.autoCompact }),
      ...(patch.diagramGuidance !== undefined && { diagramGuidance: patch.diagramGuidance }),
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
    const { apiKey, fallbackApiKey, ...rest } = patch.search;
    const stored = await getSetting('search');
    const provider = rest.provider === undefined ? stored.provider : rest.provider;
    const needs = provider ? SEARCH_PROVIDERS[provider].needs : null;
    const switched = rest.provider !== undefined && rest.provider !== stored.provider;
    const storedFallback = stored.fallbackProvider ?? null;
    const fallbackProvider =
      rest.fallbackProvider === undefined ? storedFallback : rest.fallbackProvider;
    const fallbackNeeds = fallbackProvider ? SEARCH_PROVIDERS[fallbackProvider].needs : null;
    const fallbackSwitched =
      rest.fallbackProvider !== undefined && rest.fallbackProvider !== storedFallback;
    const changes: Partial<SearchSettings> = {
      ...rest,
      // Store only what the selected provider uses. A key belongs to one
      // provider, so switching drops it rather than sending it elsewhere.
      ...(needs !== 'baseUrl' && { baseUrl: null }),
      ...((switched || needs !== 'apiKey') && { encryptedApiKey: null }),
      ...(apiKey !== undefined &&
        needs === 'apiKey' && { encryptedApiKey: apiKey ? encryptSecret(apiKey) : null }),
      // The fallback (v0.10) follows the same rules with its own key.
      fallbackProvider,
      ...(fallbackNeeds !== 'baseUrl'
        ? { fallbackBaseUrl: null }
        : rest.fallbackBaseUrl !== undefined && {
            fallbackBaseUrl: rest.fallbackBaseUrl?.trim() || null,
          }),
      ...((fallbackSwitched || fallbackNeeds !== 'apiKey') && { encryptedFallbackApiKey: null }),
      ...(fallbackApiKey !== undefined &&
        fallbackNeeds === 'apiKey' && {
          encryptedFallbackApiKey: fallbackApiKey ? encryptSecret(fallbackApiKey) : null,
        }),
    };
    // The same hosted service cannot stand in for itself; SearXNG can, at
    // another address. Checked on the merged result so either side may change.
    const next = { ...stored, ...changes };
    if (
      next.fallbackProvider &&
      next.fallbackProvider === next.provider &&
      (SEARCH_PROVIDERS[next.fallbackProvider].needs === 'apiKey' ||
        (next.fallbackBaseUrl ?? null) === (next.baseUrl ?? null))
    ) {
      const message =
        SEARCH_PROVIDERS[next.fallbackProvider].needs === 'apiKey'
          ? 'Choose a different service as the fallback provider.'
          : 'The fallback SearXNG must be at a different address.';
      // The detail is shown at the field, so it says what to do (#317's sweep).
      throw validationFailed(message, [{ path: ['search', 'fallbackProvider'], message }]);
    }
    await updateSetting('search', changes);
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
