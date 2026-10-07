import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * GET /api/models says whether an empty list is the person's role or the
 * instance (#303): an auditor kept from every model was told an
 * administrator needed to add a provider, on an instance with six. Real
 * PostgreSQL and the real route.
 */
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

describe.skipIf(!available)('live: the model catalog for a role with no models', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('model_catalog_hidden');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const { modelCatalogRoutes } = await import('../../routes/models.js');
    app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      const role = (c.req.header('x-role') ?? 'user') as 'user' | 'auditor';
      c.set('user', {
        id: `fix6-${role}`,
        name: 'Fix6',
        email: `fix6-${role}@example.test`,
        image: null,
        role,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/models', modelCatalogRoutes);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  const catalog = async (role: string) => {
    const response = await app.request('/models', { headers: { 'x-role': role } });
    expect(response.status).toBe(200);
    return (await response.json()) as { models: unknown[]; hiddenFromRole: boolean };
  };

  it('an instance with no models: not the role', async () => {
    expect(await catalog('auditor')).toEqual({ models: [], hiddenFromRole: false });
  });

  it('models the role cannot see: the role', async () => {
    const [provider] = await live.db
      .insert(schema.provider)
      .values({
        organizationId: state.organizationId,
        kind: 'openai-compatible',
        label: 'Fix6 provider',
        baseUrl: 'http://127.0.0.1:9/v1',
      })
      .returning();
    await live.db.insert(schema.model).values({
      organizationId: state.organizationId,
      providerId: provider!.id,
      slug: 'fix6-model',
      upstreamModelId: 'fix6',
      displayName: 'Fix6 model',
      visibleToRoles: ['user'],
    });
    expect(await catalog('auditor')).toEqual({ models: [], hiddenFromRole: true });
    const forUser = await catalog('user');
    expect(forUser.models).toHaveLength(1);
    expect(forUser.hiddenFromRole).toBe(false);
  });
});
