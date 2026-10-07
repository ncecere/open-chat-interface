import { desc, eq, schema } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import type { AppBindings } from '../../middleware/context.js';

/**
 * What creating things records (#374): a budget's limit, window and zone, a
 * connector's and a provider's address (without credentials or query), and an
 * override's person by email, so a search for the address still finds it once
 * the account is deleted. Through the real routes and services.
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

const { quotaRoutes } = await import('../../routes/admin/quotas.js');
const { overrideRoutes } = await import('../../routes/admin/overrides.js');
const { connectorRoutes } = await import('../../routes/admin/connectors.js');
const { providerRoutes } = await import('../../routes/admin/providers.js');
const { auditRoutes } = await import('../../routes/admin/audit.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

const ADMIN_EMAIL = 'creation-audit@example.test';

describe.skipIf(!available)('live: what creating records in the audit log (#374)', () => {
  let live: LiveDatabase;
  let admin: string;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', {
      id: admin,
      role: 'admin',
      name: 'Admin',
      email: ADMIN_EMAIL,
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/quotas', quotaRoutes);
  app.route('/users', overrideRoutes);
  app.route('/connectors', connectorRoutes);
  app.route('/providers', providerRoutes);
  app.route('/audit', auditRoutes);

  async function send(method: string, path: string, body?: unknown) {
    const response = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json() as Promise<Record<string, unknown>>;
  }

  async function lastEntry(action: string) {
    const [entry] = await live.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);
    return entry?.metadata as Record<string, unknown>;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('audit_creation');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    admin = await seedUser(live.db, state.organizationId, { role: 'admin', email: ADMIN_EMAIL });
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('records a new budget’s limit, window, time zone and state', async () => {
    await send('POST', '/quotas', {
      name: 'Walk9 daily messages',
      metric: 'messages',
      limitValue: 500,
      windowKind: 'daily',
      timezone: 'America/New_York',
      roles: ['user', 'auditor'],
    });
    // Before: name, metric, roles and models only.
    expect(await lastEntry('quota.policy.create')).toMatchObject({
      name: 'Walk9 daily messages',
      metric: 'messages',
      limitValue: 500,
      windowKind: 'daily',
      windowHours: null,
      timezone: 'America/New_York',
      enabled: true,
      roles: ['auditor', 'user'],
      modelSlugs: [],
    });
  });

  it('records a connector’s address without its query, and a provider’s', async () => {
    await send('POST', '/connectors', {
      name: 'Walk9 docs',
      url: 'http://127.0.0.1:8671/mcp?token=SECRET-QUERY-374',
      allowPrivateNetwork: true,
    });
    const connector = await lastEntry('connector.create');
    expect(connector).toMatchObject({ slug: 'walk9-docs', url: 'http://127.0.0.1:8671/mcp' });

    await send('POST', '/providers', {
      kind: 'openai',
      label: 'Walk9 gateway',
      baseUrl: 'https://gateway.example.test/v1?api_key=SECRET-QUERY-374',
      apiKey: 'sk-walk9-0123456789abcdef',
      enabled: true,
    });
    const provider = await lastEntry('provider.create');
    expect(provider).toMatchObject({
      label: 'Walk9 gateway',
      baseUrl: 'https://gateway.example.test/v1',
      enabled: true,
    });
    const text = JSON.stringify(
      await live.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetType, 'connector')),
    );
    expect(text).not.toContain('SECRET-QUERY-374');
    expect(JSON.stringify(provider)).not.toMatch(/SECRET-QUERY-374|sk-walk9/);
  });

  it('names the person in an override’s entries, so their email finds them after deletion', async () => {
    const { id } = (await send('POST', '/quotas', {
      name: 'Walk9 override budget',
      metric: 'messages',
      limitValue: 100,
      windowKind: 'daily',
      timezone: 'UTC',
      roles: ['user'],
    })) as { id: string };
    const person = await seedUser(live.db, state.organizationId, {
      role: 'user',
      email: 'walk9-physics2@example.test',
    });
    await send('PUT', `/users/${person}/quota-overrides`, { policyId: id, limitValue: 300 });
    await send('DELETE', `/users/${person}/quota-overrides/${id}`);
    expect(await lastEntry('quota.override.set')).toMatchObject({
      email: 'walk9-physics2@example.test',
    });
    expect(await lastEntry('quota.override.clear')).toMatchObject({
      email: 'walk9-physics2@example.test',
    });

    const found = async () => {
      const { entries } = (await send(
        'GET',
        '/audit?search=walk9-physics2%40example.test&limit=200',
      )) as { entries: Array<{ action: string }> };
      return entries.map((entry) => entry.action).filter((action) => action.startsWith('quota.'));
    };
    expect((await found()).sort()).toEqual(['quota.override.clear', 'quota.override.set']);

    // Delete the person: the same search still finds both (before: neither).
    await live.db.delete(schema.user).where(eq(schema.user.id, person));
    expect((await found()).sort()).toEqual(['quota.override.clear', 'quota.override.set']);
  });
});
