import { schema } from '@oci/db';
import { storageUsageSchema, usageSummarySchema } from '@oci/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

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
vi.mock('../../auth/index.js', () => ({ auth: { api: {} } }));

const { userRoutes } = await import('../../routes/admin/users.js');
const { requireAdmin } = await import('../../middleware/context.js');
const { errorHandler } = await import('../../middleware/error-handler.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');

const limitsSchema = z.object({ usage: usageSummarySchema, storage: storageUsageSchema });

describe.skipIf(!available)('live: one user’s current limits', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  let target: string;

  beforeAll(async () => {
    live = await createLiveDatabase('user_limits');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();
    const auditor = await seedUser(live.db, state.organizationId, { role: 'auditor' });
    target = await seedUser(live.db, state.organizationId, { role: 'restricted' });
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: auditor,
        role: 'auditor',
        name: 'Auditor',
        email: 'auditor@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.use('*', requireAdmin);
    app.route('/users', userRoutes);

    const [policy] = await live.db
      .insert(schema.quotaPolicy)
      .values({
        organizationId: state.organizationId,
        name: 'Restricted messages',
        metric: 'messages',
        limitValue: 10,
        windowKind: 'rolling',
        windowHours: 24,
      })
      .returning();
    await live.db
      .insert(schema.quotaPolicyRole)
      .values({ policyId: policy!.id, role: 'restricted' });
    await live.db.insert(schema.usageEvent).values({
      organizationId: state.organizationId,
      userId: target,
      modelSlug: 'fixture',
      messageCount: 3,
      tokensIn: 10,
      tokensOut: 20,
      costMicros: 0,
      pending: false,
    });
    await live.db.insert(schema.storagePolicy).values({
      organizationId: state.organizationId,
      role: 'restricted',
      maxTotalBytes: 5_000,
      maxFileCount: 4,
      maxFileBytes: null,
      enabled: true,
    });
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  it('reports budgets with current usage and storage against the role allowance', async () => {
    // An auditor may read it; the route is GET-only.
    const response = await app.request(`/users/${target}/limits`);
    expect(response.status).toBe(200);
    const body = limitsSchema.parse(await response.json());
    expect(body.usage.allowances).toEqual([
      expect.objectContaining({
        name: 'Restricted messages',
        limitValue: 10,
        used: 3,
        remaining: 7,
      }),
    ]);
    expect(body.storage).toMatchObject({ liveBytes: 0, maxTotalBytes: 5_000, maxFileCount: 4 });
  });

  it('returns not found for an unknown account', async () => {
    expect((await app.request('/users/missing/limits')).status).toBe(404);
  });
});
