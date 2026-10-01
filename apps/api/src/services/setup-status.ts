import { count, eq, isNotNull, schema } from '@oci/db';
import type { SetupCheck, SetupStatus } from '@oci/shared';
import { loadEnv } from '../config/env.js';
import { db } from '../db/index.js';
import { isSmtpUsable } from './email.js';
import { getProviderConfigurationIssues } from './providers/config.js';
import { webSearchProblem } from './search/availability.js';
import { getSetting } from './settings.js';
import { getS3ConfigurationIssues } from './storage/config.js';

/**
 * What an administrator still has to do, computed from stored configuration.
 *
 * Every check reads state the application itself relies on, so "complete"
 * means the corresponding feature works as configured, not that a page was
 * visited. Nothing here contacts an external service: a provider credential or
 * SMTP server that is configured but rejects requests shows up on Health, not
 * as an unfinished setup step.
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  const checks = await Promise.all([
    providerCheck(),
    modelChecks(),
    signInCheck(),
    emailCheck(),
    storageCheck(),
    webSearchCheck(),
    acceptableUseCheck(),
    redisCheck(),
  ]);
  const flat = checks.flat();
  const required = flat.filter((check) => check.required);
  return {
    requiredComplete: required.filter((check) => check.status === 'complete').length,
    requiredTotal: required.length,
    checks: flat,
  };
}

/** A provider is usable when it is enabled, valid, and can authenticate. */
async function providerCheck(): Promise<SetupCheck> {
  const providers = await db.select().from(schema.provider);
  const usable = providers.filter(
    (provider) =>
      provider.enabled &&
      getProviderConfigurationIssues(provider).length === 0 &&
      // Self-hosted OpenAI-compatible servers commonly need no key.
      (provider.encryptedApiKey !== null || provider.kind === 'openai-compatible'),
  );
  const action = { label: 'Open providers & models', to: '/admin/models' };
  if (usable.length > 0) {
    return {
      id: 'provider',
      title: 'Connect a model provider',
      status: 'complete',
      required: true,
      detail: `${usable.length} provider${usable.length === 1 ? '' : 's'} ready.`,
      action,
    };
  }
  return {
    id: 'provider',
    title: 'Connect a model provider',
    status: 'attention',
    required: true,
    detail:
      providers.length === 0
        ? 'No provider is configured, so no model can answer.'
        : 'No enabled provider has the credential or address it needs.',
    action,
  };
}

async function modelChecks(): Promise<SetupCheck[]> {
  const rows = await db
    .select({
      id: schema.model.id,
      displayName: schema.model.displayName,
      enabled: schema.model.enabled,
      isDefault: schema.model.isDefault,
      visibleToRoles: schema.model.visibleToRoles,
      providerEnabled: schema.provider.enabled,
    })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id));
  const available = rows.filter((row) => row.enabled && row.providerEnabled);
  const action = { label: 'Open providers & models', to: '/admin/models' };

  const models: SetupCheck = {
    id: 'models',
    title: 'Enable at least one model',
    status: available.length > 0 ? 'complete' : 'attention',
    required: true,
    detail:
      available.length > 0
        ? `${available.length} model${available.length === 1 ? '' : 's'} available.`
        : rows.length === 0
          ? 'The catalog is empty. Discover models from a provider, then enable them.'
          : 'No enabled model belongs to an enabled provider.',
    action,
  };

  const defaults = rows.filter((row) => row.isDefault);
  const chosen = defaults[0];
  let detail: string;
  let complete = false;
  if (!chosen) {
    detail = 'No default model is set, so new conversations have no starting model.';
  } else if (defaults.length > 1) {
    detail = 'More than one model is marked as the default; choose one.';
  } else if (!chosen.enabled || !chosen.providerEnabled) {
    detail = `${chosen.displayName} is the default but is not available.`;
  } else if (!chosen.visibleToRoles.includes('user')) {
    detail = `${chosen.displayName} is the default but is hidden from the user role.`;
  } else {
    detail = `${chosen.displayName} starts new conversations.`;
    complete = true;
  }
  return [
    models,
    {
      id: 'default-model',
      title: 'Choose a default model',
      status: complete ? 'complete' : 'attention',
      required: true,
      detail,
      action,
    },
  ];
}

/** With neither local sign-in nor an enabled SSO provider, only recovery works. */
async function signInCheck(): Promise<SetupCheck> {
  const [auth, [sso]] = await Promise.all([
    getSetting('auth'),
    db
      .select({ value: count() })
      .from(schema.ssoProvider)
      .where(eq(schema.ssoProvider.enabled, true)),
  ]);
  const ssoCount = sso?.value ?? 0;
  const methods = [
    auth.localAuthEnabled ? 'email and password' : null,
    ssoCount > 0 ? `${ssoCount} single sign-on provider${ssoCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return {
    id: 'sign-in',
    title: 'Offer a way to sign in',
    status: methods.length > 0 ? 'complete' : 'attention',
    required: true,
    detail:
      methods.length > 0
        ? `People sign in with ${methods.join(' and ')}.`
        : 'Local sign-in is off and no single sign-on provider is enabled.',
    action: { label: 'Open authentication', to: '/admin/settings/authentication' },
  };
}

/** Email becomes required as soon as something on the instance depends on it. */
async function emailCheck(): Promise<SetupCheck> {
  const [usable, auth, [reports]] = await Promise.all([
    isSmtpUsable(),
    getSetting('auth'),
    db
      .select({ value: count() })
      .from(schema.scheduledReport)
      .where(eq(schema.scheduledReport.enabled, true)),
  ]);
  const dependents = [
    auth.emailVerificationRequired ? 'email verification' : null,
    (reports?.value ?? 0) > 0 ? 'scheduled reports' : null,
  ].filter((value): value is string => value !== null);
  const action = { label: 'Configure email', to: '/admin/settings/email' };
  const title = 'Set up email delivery';

  // Required only while something depends on it, so the required count does
  // not change merely because email was configured.
  if (usable) {
    return {
      id: 'email',
      title,
      status: 'complete',
      required: dependents.length > 0,
      detail: 'Email is configured.',
      action,
    };
  }
  if (dependents.length > 0) {
    return {
      id: 'email',
      title,
      status: 'attention',
      required: true,
      detail: `${capitalize(dependents.join(' and '))} ${dependents.length === 1 ? 'needs' : 'need'} email, which is not configured.`,
      action,
    };
  }
  return {
    id: 'email',
    title,
    status: 'optional',
    required: false,
    detail:
      'Without email, invitations must be shared as links and password resets cannot be sent.',
    action,
  };
}

async function storageCheck(): Promise<SetupCheck> {
  const storage = await getSetting('storage');
  const action = { label: 'Open storage', to: '/admin/storage' };
  if (storage.driver === 's3') {
    const issues = getS3ConfigurationIssues(storage.s3);
    return {
      id: 'storage',
      title: 'Configure attachment storage',
      status: issues.length === 0 ? 'complete' : 'attention',
      required: true,
      detail:
        issues.length === 0
          ? 'Attachments are stored in S3-compatible storage.'
          : `S3 storage is selected but incomplete: ${issues[0]!.message}`,
      action,
    };
  }
  return {
    id: 'storage',
    title: 'Configure attachment storage',
    status: 'complete',
    required: true,
    detail: 'Attachments are stored on the local filesystem; back up that volume.',
    action,
  };
}

/** Search needs the feature, the provider switch, a provider and its credential. */
async function webSearchCheck(): Promise<SetupCheck> {
  const [features, search] = await Promise.all([getSetting('features'), getSetting('search')]);
  const action = { label: 'Open web search', to: '/admin/search' };
  const title = 'Web search';
  const anyOn = features.webSearch || search.enabled;
  if (!anyOn) {
    return {
      id: 'web-search',
      title,
      status: 'optional',
      required: false,
      detail: 'Web search is off.',
      action,
    };
  }
  const reason = webSearchProblem(features, search);
  return {
    id: 'web-search',
    title,
    status: reason ? 'attention' : 'complete',
    required: false,
    detail: reason ? `Web search is unavailable: ${reason}.` : 'Web search is available.',
    action,
  };
}

async function acceptableUseCheck(): Promise<SetupCheck> {
  const [published] = await db
    .select({ value: count() })
    .from(schema.usagePolicy)
    .where(isNotNull(schema.usagePolicy.publishedAt));
  const has = (published?.value ?? 0) > 0;
  return {
    id: 'acceptable-use',
    title: 'Publish an acceptable use policy',
    status: has ? 'complete' : 'optional',
    required: false,
    detail: has
      ? 'People accept the current policy before chatting.'
      : 'No policy is published, so nobody is asked to accept one.',
    action: { label: 'Open acceptable use', to: '/admin/policies' },
  };
}

function redisCheck(): SetupCheck {
  const configured = Boolean(loadEnv().REDIS_URL);
  return {
    id: 'redis',
    title: 'Connect Redis for multiple replicas',
    status: configured ? 'complete' : 'optional',
    required: false,
    detail: configured
      ? 'Redis is configured; check System health for reachability.'
      : 'Without Redis, rate limits and stream recovery work per replica only.',
    action: { label: 'Open system health', to: '/admin/health' },
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
