import { rolesAccessSchema, type UserRole } from '@oci/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { schema } = await import('@oci/db');
const { getRolesAccess } = await import('../../services/roles-access.js');
const { getRateLimitSettings } = await import('../../services/lifecycle/settings.js');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');

describe.skipIf(!available)('live: roles and access summary', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('roles_access');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();
    await seedUser(live.db, state.organizationId, { role: 'admin' });
    await seedUser(live.db, state.organizationId, { role: 'restricted' });
    await seedUser(live.db, state.organizationId, { role: 'restricted' });

    const [enabled, disabled] = await live.db
      .insert(schema.provider)
      .values([
        { organizationId: state.organizationId, kind: 'openai', label: 'On' },
        { organizationId: state.organizationId, kind: 'openai', label: 'Off', enabled: false },
      ])
      .returning();
    const catalog: { slug: string; visibleToRoles: UserRole[]; enabled?: boolean }[] = [
      { slug: 'everyone', visibleToRoles: ['admin', 'user', 'restricted'] },
      { slug: 'admins', visibleToRoles: ['admin'] },
      { slug: 'disabled', visibleToRoles: ['admin', 'user', 'restricted'], enabled: false },
    ];
    await live.db.insert(schema.model).values(
      catalog.map((model) => ({
        ...model,
        organizationId: state.organizationId,
        providerId: enabled!.id,
        upstreamModelId: model.slug,
        displayName: model.slug,
      })),
    );
    await live.db.insert(schema.model).values({
      organizationId: state.organizationId,
      providerId: disabled!.id,
      slug: 'provider-off',
      upstreamModelId: 'provider-off',
      displayName: 'provider-off',
    });

    const [budget] = await live.db
      .insert(schema.quotaPolicy)
      .values({
        organizationId: state.organizationId,
        name: 'Restricted daily',
        metric: 'messages',
        limitValue: 20,
        windowKind: 'rolling',
        windowHours: 24,
      })
      .returning();
    await live.db
      .insert(schema.quotaPolicyRole)
      .values({ policyId: budget!.id, role: 'restricted' });
    await live.db.insert(schema.storagePolicy).values({
      organizationId: state.organizationId,
      role: 'restricted',
      maxTotalBytes: 1_000_000,
      maxFileCount: null,
      maxFileBytes: null,
      enabled: true,
    });
    await updateSetting('rateLimits', { roles: { restricted: { chatRequestsPerMinute: 4 } } });
    await updateSetting('features', { attachments: true, shareLinks: true, temporaryChat: true });
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('summarises each role from the values enforcement uses', async () => {
    const summary = rolesAccessSchema.parse(await getRolesAccess());
    const byRole = Object.fromEntries(summary.roles.map((role) => [role.role, role]));
    const limits = await getRateLimitSettings();

    expect(Object.keys(byRole)).toEqual(['admin', 'auditor', 'user', 'restricted']);
    expect(byRole.restricted).toMatchObject({
      userCount: 2,
      rateLimits: limits.roles.restricted,
      rateLimitSources: { chatRequestsPerMinute: 'database', maxConcurrentStreams: 'default' },
      storage: { role: 'restricted', maxTotalBytes: 1_000_000 },
      budgets: [expect.objectContaining({ name: 'Restricted daily', limitValue: 20 })],
      models: { visible: 1, available: 2 },
      features: {
        attachments: false,
        shareLinks: false,
        temporaryChat: false,
        webSearch: false,
        branching: false,
      },
      roleFeatures: { attachments: false, shareLinks: false, temporaryChat: false },
      fixedRules: [],
    });
    expect(byRole.restricted?.rateLimits.chatRequestsPerMinute).toBe(4);
    expect(byRole.admin).toMatchObject({
      userCount: 1,
      storage: null,
      budgets: [],
      models: { visible: 2, available: 2 },
      features: { attachments: true, shareLinks: true, temporaryChat: true },
    });
    expect(byRole.auditor?.fixedRules).toEqual(['Can view administration but cannot change it.']);
    expect(byRole.user?.models.visible).toBe(1);
  });
});
