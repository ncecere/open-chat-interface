import { randomUUID } from 'node:crypto';
import { eq, schema } from '@oci/db';
import type { SetupCheck, SetupStatus } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '', redisUrl: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), REDIS_URL: state.redisUrl || undefined }),
  };
});

const { getSetupStatus } = await import('../../services/setup-status.js');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');
const { encryptSecret } = await import('../../lib/crypto.js');

function check(status: SetupStatus, id: SetupCheck['id']): SetupCheck {
  const found = status.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing check ${id}`);
  return found;
}

/**
 * Each check reads the configuration the application actually uses, against
 * real PostgreSQL and stored settings, so "complete" means the feature works.
 */
describe.skipIf(!available)('live: administrator setup status', () => {
  let live: LiveDatabase;
  let adminId: string;

  async function reset() {
    await live.db.delete(schema.model);
    await live.db.delete(schema.provider);
    await live.db.delete(schema.ssoProvider);
    await live.db.delete(schema.scheduledReport);
    await live.db.delete(schema.usagePolicy);
    await live.db.delete(schema.instanceSetting);
    invalidateSettingsCache();
    state.redisUrl = '';
    await updateSetting('auth', {
      registrationMode: 'invite_only',
      emailVerificationRequired: true,
      localAuthEnabled: true,
    });
  }

  async function provider(values: Partial<typeof schema.provider.$inferInsert> = {}) {
    const [row] = await live.db
      .insert(schema.provider)
      .values({
        organizationId: state.organizationId,
        kind: 'openai',
        label: 'Provider',
        encryptedApiKey: encryptSecret('test-only-key'),
        ...values,
      })
      .returning();
    return row!;
  }

  async function model(providerId: string, values: Partial<typeof schema.model.$inferInsert> = {}) {
    const slug = `model-${randomUUID().slice(0, 8)}`;
    await live.db.insert(schema.model).values({
      organizationId: state.organizationId,
      providerId,
      slug,
      upstreamModelId: slug,
      displayName: values.displayName ?? 'Fixture model',
      ...values,
    });
  }

  beforeAll(async () => {
    live = await createLiveDatabase('setup_status');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    adminId = await seedUser(live.db, state.organizationId, { role: 'admin' });
  });
  beforeEach(reset);
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('reports a new instance as needing a provider, models, a default and email', async () => {
    const status = await getSetupStatus();
    expect(check(status, 'provider')).toMatchObject({ status: 'attention', required: true });
    expect(check(status, 'models')).toMatchObject({ status: 'attention' });
    expect(check(status, 'default-model')).toMatchObject({ status: 'attention' });
    // Seeded default: verification required while SMTP is empty.
    expect(check(status, 'email')).toMatchObject({
      status: 'attention',
      required: true,
      detail: 'Email verification needs email, which is not configured.',
    });
    expect(check(status, 'sign-in').status).toBe('complete');
    expect(check(status, 'storage').status).toBe('complete');
    expect(check(status, 'web-search').status).toBe('optional');
    expect(check(status, 'redis').status).toBe('optional');
    expect(status.requiredComplete).toBe(2);
    // Provider, models, default model, sign-in, storage and (here) email.
    expect(status.requiredTotal).toBe(6);
    expect(JSON.stringify(status)).not.toContain('test-only-key');
  });

  it('completes the model steps only for an available, visible default', async () => {
    const ready = await provider();
    const disabled = await provider({ enabled: false, label: 'Disabled' });
    await model(disabled.id, { isDefault: true, displayName: 'Hidden default' });
    let status = await getSetupStatus();
    expect(check(status, 'provider').status).toBe('complete');
    expect(check(status, 'models').status).toBe('attention');
    expect(check(status, 'default-model').detail).toBe(
      'Hidden default is the default but is not available.',
    );

    await live.db.delete(schema.model);
    await model(ready.id, {
      isDefault: true,
      displayName: 'Admins only',
      visibleToRoles: ['admin'],
    });
    status = await getSetupStatus();
    expect(check(status, 'models').status).toBe('complete');
    expect(check(status, 'default-model').detail).toBe(
      'Admins only is the default but is hidden from the user role.',
    );

    await live.db.update(schema.model).set({ visibleToRoles: ['admin', 'user'] });
    status = await getSetupStatus();
    expect(check(status, 'default-model')).toMatchObject({
      status: 'complete',
      detail: 'Admins only starts new conversations.',
    });
  });

  it('accepts a keyless self-hosted provider but not a keyless hosted one', async () => {
    await provider({ encryptedApiKey: null });
    expect(check(await getSetupStatus(), 'provider').status).toBe('attention');
    await provider({
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1',
      encryptedApiKey: null,
    });
    expect(check(await getSetupStatus(), 'provider').status).toBe('complete');
  });

  it('requires a sign-in method and email only when something depends on it', async () => {
    await updateSetting('auth', { localAuthEnabled: false, emailVerificationRequired: false });
    let status = await getSetupStatus();
    expect(check(status, 'sign-in').status).toBe('attention');
    expect(check(status, 'email')).toMatchObject({ status: 'optional', required: false });

    await live.db.insert(schema.ssoProvider).values({
      id: randomUUID(),
      providerId: 'oidc-setup',
      issuer: 'https://idp.example.test',
      domain: 'example.test',
      organizationId: state.organizationId,
    });
    await live.db.insert(schema.scheduledReport).values({
      organizationId: state.organizationId,
      name: 'Monthly',
      cadence: 'monthly',
      recipients: ['ops@example.test'],
    });
    status = await getSetupStatus();
    expect(check(status, 'sign-in').detail).toBe('People sign in with 1 single sign-on provider.');
    expect(check(status, 'email')).toMatchObject({
      status: 'attention',
      detail: 'Scheduled reports needs email, which is not configured.',
    });

    await updateSetting('smtp', {
      host: 'smtp.example.test',
      port: 587,
      fromAddress: 'oci@example.test',
      encryptedPassword: encryptSecret('test-only-smtp'),
    });
    expect(check(await getSetupStatus(), 'email').status).toBe('complete');
  });

  it('flags partially enabled or incomplete web search and S3 storage', async () => {
    await updateSetting('features', { webSearch: true });
    let status = await getSetupStatus();
    expect(check(status, 'web-search').detail).toBe(
      'Web search is unavailable: web search is only partly switched on.',
    );
    await updateSetting('search', { enabled: true, provider: 'tavily', encryptedApiKey: null });
    status = await getSetupStatus();
    expect(check(status, 'web-search').detail).toBe(
      'Web search is unavailable: the provider needs an API credential.',
    );
    await updateSetting('search', { provider: 'searxng', baseUrl: 'http://127.0.0.1:1' });
    expect(check(await getSetupStatus(), 'web-search').status).toBe('complete');

    const storage = await (await import('../../services/settings.js')).getSetting('storage');
    await updateSetting('storage', { driver: 's3', s3: { ...storage.s3, bucket: '' } });
    expect(check(await getSetupStatus(), 'storage')).toMatchObject({
      status: 'attention',
      detail: 'S3 storage is selected but incomplete: S3 bucket is required.',
    });
  });

  it('marks an acceptable use policy and Redis complete once present', async () => {
    await live.db.insert(schema.usagePolicy).values({
      organizationId: state.organizationId,
      version: 1,
      title: 'Policy',
      body: 'Be kind.',
      publishedAt: new Date(),
      createdByUserId: adminId,
    });
    state.redisUrl = 'redis://127.0.0.1:1';
    const status = await getSetupStatus();
    expect(check(status, 'acceptable-use').status).toBe('complete');
    expect(check(status, 'redis').status).toBe('complete');
    const [stored] = await live.db
      .select()
      .from(schema.usagePolicy)
      .where(eq(schema.usagePolicy.version, 1));
    expect(stored?.publishedAt).not.toBeNull();
  });
});
