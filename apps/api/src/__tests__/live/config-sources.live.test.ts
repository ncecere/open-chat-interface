import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  env: {} as Record<string, string | undefined>,
}));
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
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...state.env }) };
});

const { getConfigSources, getRateLimitSettings, getRetentionSettings, updateRetentionSettings } =
  await import('../../services/lifecycle/settings.js');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');

/** Sources must follow the same precedence as the effective values. */
describe.skipIf(!available)('live: configuration sources', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('config_sources');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
  });
  beforeEach(() => {
    invalidateSettingsCache();
    state.env = {
      RETENTION_TRASH_DAYS: undefined,
      RETENTION_AUDIT_LOG_DAYS: undefined,
      RATE_LIMIT_CHAT_PER_MINUTE: undefined,
      DISPLAY_TIMEZONE: undefined,
    };
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('reports database over environment over built-in defaults', async () => {
    state.env.RETENTION_AUDIT_LOG_DAYS = '400';
    state.env.RATE_LIMIT_CHAT_PER_MINUTE = 'not-a-number';
    state.env.DISPLAY_TIMEZONE = 'Europe/London';
    await updateRetentionSettings({ trashRetentionDays: 14 });

    const [sources, retention, limits] = await Promise.all([
      getConfigSources(),
      getRetentionSettings(),
      getRateLimitSettings(),
    ]);
    expect(retention).toMatchObject({
      trashRetentionDays: 14,
      auditLogRetentionDays: 400,
      displayTimezone: 'Europe/London',
    });
    expect(sources.retention).toMatchObject({
      trashRetentionDays: 'database',
      auditLogRetentionDays: 'environment',
      displayTimezone: 'environment',
      usageEventRetentionDays: 'default',
    });
    // An unparseable environment value is ignored, so the default applies.
    expect(limits.roles.user.chatRequestsPerMinute).toBe(30);
    expect(sources.rateLimits.roles.user.chatRequestsPerMinute).toBe('default');
  });

  it('reports a saved per-role limit as the database value for that role only', async () => {
    state.env.RATE_LIMIT_CHAT_PER_MINUTE = '50';
    await updateSetting('rateLimits', { roles: { restricted: { chatRequestsPerMinute: 5 } } });
    const sources = await getConfigSources();
    expect(sources.rateLimits.roles.restricted.chatRequestsPerMinute).toBe('database');
    expect(sources.rateLimits.roles.user.chatRequestsPerMinute).toBe('environment');
    expect(sources.rateLimits.roles.restricted.maxConcurrentStreams).toBe('default');
  });

  it('treats an explicitly disabled conversation retention as a saved value', async () => {
    await updateRetentionSettings({ threadRetentionDays: null });
    expect((await getConfigSources()).retention.threadRetentionDays).toBe('database');
  });
});
