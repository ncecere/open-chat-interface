import { createDatabase, schema } from '@oci/db';
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
 * Connector and webhook saves report every problem with the body at once,
 * each at its field (#283): the URL's network rule used to be checked only
 * after the schema passed, so a form heard of it one save later, and the
 * webhook's named no field at all. Real PostgreSQL and the real admin routes.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/jobs/index.js', () => ({ runJobNow: async () => null }));

const available = await livePostgresAvailable();

const HTTPS_ONLY =
  'Use an https:// address. Plain http:// is allowed only with “Allow private network”.';

interface Refusal {
  error: { code: string; details?: Array<{ path: unknown[]; message: string }> };
}

describe.skipIf(!available)('live: admin validation reports every field at once', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: string;
  let app: Hono<AppBindings>;

  beforeAll(async () => {
    live = await createLiveDatabase('validation_at_once');
    pool = createDatabase(live.connectionString, { max: 4 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    admin = await seedUser(pool.db, state.organizationId, { role: 'admin' });
    const { adminRoutes } = await import('../../routes/admin/index.js');
    const { errorHandler } = await import('../../middleware/error-handler.js');
    app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: admin,
        name: 'Admin',
        email: 'admin@example.test',
        image: null,
        role: 'admin',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/admin', adminRoutes);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const send = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Each refused field with its message. */
  async function refused(response: Response): Promise<Record<string, string>> {
    expect(response.status).toBe(422);
    const body = (await response.json()) as Refusal;
    return Object.fromEntries(
      (body.error.details ?? []).map((issue) => [String(issue.path[0]), issue.message]),
    );
  }

  it('a new connector: the short name and the http:// URL in one save', async () => {
    const fields = await refused(
      await send('POST', '/api/admin/connectors', {
        name: 'Fix5 connector',
        url: 'http://mcp.example.test/mcp',
        slug: 'Bad Short!',
      }),
    );
    expect(fields).toEqual({
      slug: 'Use up to 24 lowercase letters, digits and hyphens, such as docs or crm-eu.',
      url: HTTPS_ONLY,
    });
  });

  it('a connector edit: the URL against the saved switch, with the missing credential', async () => {
    const [row] = await pool.db
      .insert(schema.connector)
      .values({
        organizationId: state.organizationId,
        name: 'Fix5 saved',
        slug: 'fix5-saved',
        url: 'https://mcp.example.test/mcp',
        authMode: 'none',
      })
      .returning();
    const fields = await refused(
      await send('PATCH', `/api/admin/connectors/${row!.id}`, {
        url: 'http://mcp.example.test/mcp',
        authMode: 'shared',
        sharedHeaderName: 'Host',
      }),
    );
    expect(fields).toEqual({
      url: HTTPS_ONLY,
      sharedHeaderName: 'OCI sets this header itself. Use another header name.',
      sharedHeaderValue: 'Enter the credential OCI sends to this server.',
    });
    // A URL the schema already refuses gets that one complaint, not two.
    const malformed = await refused(
      await send('PATCH', `/api/admin/connectors/${row!.id}`, { url: 'not a url' }),
    );
    expect(Object.keys(malformed)).toEqual(['url']);
  });

  it('a webhook: the URL refusal is at the URL, with the empty action list', async () => {
    const fields = await refused(
      await send('POST', '/api/admin/webhooks', {
        url: 'http://hooks.example.test/oci',
        description: 'D'.repeat(201),
        actions: [],
      }),
    );
    expect(fields).toEqual({
      url: HTTPS_ONLY,
      description: expect.any(String),
      actions: 'Choose at least one audit action, or all of them.',
    });
  });

  it('a new connector: a missing name with the http:// URL, as the form now relies on (#301)', async () => {
    const fields = await refused(
      await send('POST', '/api/admin/connectors', {
        name: '  ',
        url: 'http://mcp.example.test/mcp',
      }),
    );
    expect(Object.keys(fields).sort()).toEqual(['name', 'url']);
    expect(fields.url).toBe(HTTPS_ONLY);
  });

  it('a webhook with no URL and no actions: one complaint about each (#301)', async () => {
    const response = await send('POST', '/api/admin/webhooks', { url: '', actions: [] });
    expect(response.status).toBe(422);
    const body = (await response.json()) as Refusal;
    expect(
      (body.error.details ?? []).map((issue) => [String(issue.path[0]), issue.message]),
    ).toEqual([
      ['url', 'Enter the endpoint\u2019s full URL, such as https://hooks.example.com/oci.'],
      ['actions', 'Choose at least one audit action, or all of them.'],
    ]);
  });

  it('a webhook edit: checked against what the endpoint becomes', async () => {
    const [row] = await pool.db
      .insert(schema.webhookEndpoint)
      .values({
        organizationId: state.organizationId,
        url: 'http://127.0.0.1:9/hook',
        actions: ['user.*'],
        allowPrivateNetwork: true,
        encryptedSecret: 'x',
      })
      .returning();
    const fields = await refused(
      await send('PATCH', `/api/admin/webhooks/${row!.id}`, {
        allowPrivateNetwork: false,
        actions: [],
      }),
    );
    expect(fields.url).toBeDefined();
    expect(fields.actions).toBe('Choose at least one audit action, or all of them.');
  });
});
