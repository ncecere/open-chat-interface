import { eq, schema } from '@oci/db';
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

const { policyRoutes } = await import('../../routes/admin/policies.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

describe.skipIf(!available)('live: acceptable-use policy drafts', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;

  async function send(method: string, path: string, body?: unknown) {
    const response = await app.request(`/policies${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function create(publish: boolean, title = 'Walk AUP') {
    const { status, body } = await send('POST', '', { title, body: 'Be kind.', publish });
    expect(status).toBe(201);
    return body.id as string;
  }

  const audit = (action: string) =>
    live.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  beforeAll(async () => {
    live = await createLiveDatabase('admin_policy_drafts');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const actor = await seedUser(live.db, state.organizationId, { role: 'admin' });
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: actor,
        role: 'admin',
        name: 'Policy admin',
        email: 'policy-admin@example.test',
        image: null,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/policies', policyRoutes);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('rewords a draft and records which version changed', async () => {
    const id = await create(false);
    const { status } = await send('PATCH', `/${id}`, {
      title: 'Walk AUP (reviewed)',
      body: 'Be kind. Fix typos before publishing.',
    });
    expect(status).toBe(200);

    const { body } = await send('GET', '');
    const policy = (body.policies as { id: string; title: string; body: string }[]).find(
      (entry) => entry.id === id,
    );
    expect(policy).toMatchObject({
      title: 'Walk AUP (reviewed)',
      body: 'Be kind. Fix typos before publishing.',
    });
    const [entry] = await audit('policy.update');
    expect(entry?.metadata).toMatchObject({ title: 'Walk AUP (reviewed)' });
  });

  it('deletes a draft and keeps what it was in the audit entry', async () => {
    const id = await create(false, 'Walk AUP draft to discard');
    expect((await send('DELETE', `/${id}`)).status).toBe(200);

    const rows = await live.db
      .select()
      .from(schema.usagePolicy)
      .where(eq(schema.usagePolicy.id, id));
    expect(rows).toHaveLength(0);
    const entries = await audit('policy.delete');
    expect(entries.find((entry) => entry.targetId === id)?.metadata).toMatchObject({
      title: 'Walk AUP draft to discard',
    });
  });

  it('never changes or deletes a published version', async () => {
    const id = await create(true, 'Walk AUP in force');
    const edit = await send('PATCH', `/${id}`, { title: 'Changed', body: 'Changed.' });
    expect(edit.status).toBe(409);
    expect((await send('DELETE', `/${id}`)).status).toBe(409);

    const [row] = await live.db
      .select()
      .from(schema.usagePolicy)
      .where(eq(schema.usagePolicy.id, id));
    expect(row).toMatchObject({ title: 'Walk AUP in force', body: 'Be kind.' });
  });

  it('answers 404 for a version that does not exist', async () => {
    expect((await send('DELETE', '/not-a-policy')).status).toBe(404);
  });
});
