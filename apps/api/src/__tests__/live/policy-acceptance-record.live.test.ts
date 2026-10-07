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

/**
 * Who accepted the policy, and when (#373), through the real /api routes and
 * the real database: each acceptance is audited, administrators and auditors
 * can list who accepted a version, and the count stays honest when an account
 * is deleted ("N accepted, M since deleted").
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  organizationId: '',
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { createApiRoutes } = await import('../../routes/index.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

describe.skipIf(!available)('live: the record of who accepted the policy (#373)', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  const people: Record<string, { id: string; email: string; role: 'admin' | 'auditor' | 'user' }> =
    {};
  let signedInAs = 'admin';
  let policyId = '';

  async function send(method: string, path: string, body?: unknown) {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // biome-ignore lint/suspicious/noExplicitAny: a loosely typed answer body
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  const accept = async (who: string) => {
    signedInAs = who;
    return send('POST', '/me/onboarding/accept-policy', { policyId });
  };
  const acceptEntries = () =>
    live.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'policy.accept'));

  beforeAll(async () => {
    live = await createLiveDatabase('policy_acceptance_record');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    for (const [name, role] of [
      ['admin', 'admin'],
      ['auditor', 'auditor'],
      ['physics', 'user'],
      ['bell', 'user'],
    ] as const) {
      const email = `${name}@example.test`;
      people[name] = {
        id: await seedUser(live.db, state.organizationId, { email, role }),
        email,
        role,
      };
    }
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      const person = people[signedInAs];
      if (person)
        c.set('user', {
          id: person.id,
          email: person.email,
          name: signedInAs,
          image: null,
          role: person.role,
          emailVerified: true,
          organizationId: state.organizationId,
        });
      await next();
    });
    app.route('/api', createApiRoutes());
    const published = await send('POST', '/admin/policies', {
      title: 'Walk9 acceptable use',
      body: 'Be kind.',
      publish: true,
    });
    policyId = published.body.id;
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('audits each acceptance with who, which version and from where, once', async () => {
    expect((await accept('physics')).status).toBe(200);
    expect((await accept('bell')).status).toBe(200);
    // Accepting again records nothing more.
    expect((await accept('physics')).status).toBe(200);

    const entries = await acceptEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.actorEmail === 'physics@example.test')).toMatchObject({
      actorUserId: people.physics?.id,
      targetType: 'usage_policy',
      targetId: policyId,
      metadata: { version: 1, title: 'Walk9 acceptable use' },
    });
  });

  it('lists who accepted for an administrator and an auditor, with their email', async () => {
    for (const who of ['admin', 'auditor']) {
      signedInAs = who;
      const { status, body } = await send('GET', `/admin/policies/${policyId}/acceptances`);
      expect(status, who).toBe(200);
      expect(body).toMatchObject({ accepted: 2, deleted: 0, shown: 2 });
      expect(body.acceptances.map((entry: { email: string }) => entry.email).sort()).toEqual([
        'bell@example.test',
        'physics@example.test',
      ]);
      expect(body.acceptances[0]).toMatchObject({
        accountDeleted: false,
        acceptedAt: expect.any(String),
        ipAddress: expect.any(String),
      });
    }
    // The page's list says the same count.
    const list = await send('GET', '/admin/policies');
    expect(list.body.policies[0]).toMatchObject({ acceptanceCount: 2, deletedAcceptanceCount: 0 });
    signedInAs = 'physics';
    expect((await send('GET', `/admin/policies/${policyId}/acceptances`)).status).toBe(403);
    signedInAs = 'admin';
    expect((await send('GET', '/admin/policies/nope/acceptances')).status).toBe(404);
  });

  it('keeps the count honest when an account is deleted: N accepted, M since deleted', async () => {
    await live.db.delete(schema.user).where(eq(schema.user.id, people.bell?.id ?? ''));
    signedInAs = 'admin';
    const list = await send('GET', '/admin/policies');
    // Before: the count read 1 and nothing said another person had accepted.
    expect(list.body.policies[0]).toMatchObject({ acceptanceCount: 1, deletedAcceptanceCount: 1 });

    const { body } = await send('GET', `/admin/policies/${policyId}/acceptances`);
    expect(body).toMatchObject({ accepted: 1, deleted: 1, shown: 2 });
    expect(body.acceptances).toEqual([
      expect.objectContaining({ email: expect.any(String), accountDeleted: expect.any(Boolean) }),
      expect.objectContaining({ email: expect.any(String), accountDeleted: expect.any(Boolean) }),
    ]);
    expect(
      body.acceptances.find((entry: { accountDeleted: boolean }) => entry.accountDeleted),
    ).toMatchObject({ email: 'bell@example.test', accountDeleted: true });
  });
});
