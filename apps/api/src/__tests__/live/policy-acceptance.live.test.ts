import { and, eq, schema } from '@oci/db';
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
 * The acceptable use policy enforced on the server (#367), through the real
 * /api routes and the real database: a person who has not accepted the
 * published version is refused with 403 POLICY_ACCEPTANCE_REQUIRED on every
 * write that uses the instance, and can still read, accept, and sign out; once
 * they accept, everything works. A new version refuses them again; a draft,
 * or no policy at all, never does.
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

describe.skipIf(!available)('live: the acceptable use policy is enforced by the API (#367)', () => {
  let live: LiveDatabase;
  let app: Hono<AppBindings>;
  const people: Record<string, { id: string; email: string; role: 'admin' | 'user' }> = {};
  let signedInAs = 'admin';

  const as = (who: string) => {
    signedInAs = who;
  };

  interface Answer {
    id?: string;
    pendingPolicy?: { id: string; version: number } | null;
    error?: { code: string; message: string; details: { policy: { id: string; version: number } } };
  }

  async function send(method: string, path: string, body?: unknown) {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON (a stream, a file).
    }
    return { status: response.status, body: parsed as Answer | null };
  }

  /** What the person sees on the acceptance page. */
  async function pending() {
    const { body } = await send('GET', '/me/onboarding');
    return body?.pendingPolicy as { id: string; version: number } | null;
  }

  async function publish(title: string) {
    as('admin');
    const { status, body } = await send('POST', '/admin/policies', {
      title,
      body: 'Be kind.',
      publish: true,
    });
    expect(status).toBe(201);
    return body?.id as string;
  }

  const refusal = (result: { status: number; body: Answer | null }) =>
    result.status === 403 ? result.body?.error?.code : result.status;

  beforeAll(async () => {
    live = await createLiveDatabase('policy_acceptance');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    for (const [name, role] of [
      ['admin', 'admin'],
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
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('lets everybody work while no policy is published, and while there is only a draft', async () => {
    as('physics');
    expect((await send('POST', '/threads', {})).status).toBe(201);
    expect(await pending()).toBeNull();

    as('admin');
    expect(
      (await send('POST', '/admin/policies', { title: 'Draft', body: 'Soon.', publish: false }))
        .status,
    ).toBe(201);
    as('physics');
    expect((await send('POST', '/threads', {})).status).toBe(201);
  });

  it('refuses a person who has not accepted the published version, and only on writes', async () => {
    const policyId = await publish('Acceptable use');

    as('physics');
    expect(await pending()).toMatchObject({ id: policyId, version: 2 });

    // Chat, uploads, creating conversations and projects, memory, approvals.
    expect(refusal(await send('POST', '/chat', { threadId: 'x', messages: [] }))).toBe(
      'POLICY_ACCEPTANCE_REQUIRED',
    );
    expect(refusal(await send('POST', '/threads', {}))).toBe('POLICY_ACCEPTANCE_REQUIRED');
    expect(refusal(await send('POST', '/attachments', {}))).toBe('POLICY_ACCEPTANCE_REQUIRED');
    expect(refusal(await send('POST', '/projects', { name: 'Mine' }))).toBe(
      'POLICY_ACCEPTANCE_REQUIRED',
    );
    expect(refusal(await send('POST', '/memory', { content: 'x' }))).toBe(
      'POLICY_ACCEPTANCE_REQUIRED',
    );
    expect(refusal(await send('POST', '/chat/t1/approvals', {}))).toBe(
      'POLICY_ACCEPTANCE_REQUIRED',
    );

    const refused = await send('POST', '/threads', {});
    expect(refused.status).toBe(403);
    expect(refused.body?.error?.message).toContain('acceptable use policy (version 2)');
    expect(refused.body?.error?.details.policy).toMatchObject({ id: policyId, version: 2 });

    // Nothing was created.
    const threads = await live.db
      .select({ id: schema.thread.id })
      .from(schema.thread)
      .where(eq(schema.thread.userId, people.physics?.id ?? ''));
    expect(threads).toHaveLength(2); // the two made before publishing

    // What the acceptance page needs, and read-only views of their own data.
    expect((await send('GET', '/me')).status).toBe(200);
    expect((await send('GET', '/threads')).status).toBe(200);
    expect((await send('GET', '/me/onboarding')).status).toBe(200);
  });

  it('lets the person accept, and then everything works', async () => {
    as('physics');
    const policy = await pending();
    expect(
      (await send('POST', '/me/onboarding/accept-policy', { policyId: policy?.id })).status,
    ).toBe(200);
    expect(await pending()).toBeNull();
    expect((await send('POST', '/threads', {})).status).toBe(201);
    expect((await send('POST', '/projects', { name: 'Fix9 project' })).status).toBe(201);
    // The chat route now answers about the request, not the policy.
    expect((await send('POST', '/chat', { threadId: 'x', messages: [] })).status).not.toBe(403);

    // Somebody else who has not accepted is still refused.
    as('bell');
    expect(refusal(await send('POST', '/threads', {}))).toBe('POLICY_ACCEPTANCE_REQUIRED');
  });

  it('applies to an administrator as to anybody, yet never locks the administrator out of the admin pages', async () => {
    as('admin');
    expect(refusal(await send('POST', '/threads', {}))).toBe('POLICY_ACCEPTANCE_REQUIRED');
    // Reading and managing the instance, publishing the next version included.
    expect((await send('GET', '/admin/policies')).status).toBe(200);
    expect(
      (await send('POST', '/admin/policies', { title: 'Draft 2', body: 'Soon.', publish: false }))
        .status,
    ).toBe(201);
    expect((await send('POST', '/me/sessions/revoke-others')).status).not.toBe(403);
  });

  it('refuses everybody again when a new version is published, and a draft does not', async () => {
    const policyId = await publish('Acceptable use, revised');
    as('physics');
    expect(await pending()).toMatchObject({ id: policyId, isUpdate: true });
    expect(refusal(await send('POST', '/threads', {}))).toBe('POLICY_ACCEPTANCE_REQUIRED');
    expect((await send('POST', '/me/onboarding/accept-policy', { policyId })).status).toBe(200);
    expect((await send('POST', '/threads', {})).status).toBe(201);
  });

  it('keeps the acceptance record the page promises', async () => {
    const rows = await live.db
      .select()
      .from(schema.usagePolicyAcceptance)
      .where(
        and(
          eq(schema.usagePolicyAcceptance.userId, people.physics?.id ?? ''),
          eq(schema.usagePolicyAcceptance.policyVersion, 4),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
