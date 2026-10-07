import { schema, sql } from '@oci/db';
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
 * The actor of a `tool.call` audit entry (#280). They were written with the
 * person's ID and no email, so the audit log showed "demo-user-007" where
 * every other entry shows an email. Real PostgreSQL, the real audit writer
 * and the real audit routes.
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

const { auditRoutes } = await import('../../routes/admin/audit.js');
const { recordToolCall } = await import('../../services/tools/audit.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

interface Listing {
  entries: { action: string; actorUserId: string | null; actorEmail: string | null }[];
}

describe.skipIf(!available)('live: audit actors', () => {
  let live: LiveDatabase;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.route('/audit', auditRoutes);
  const email = 'fix5.tools@example.test';
  let person: string;

  beforeAll(async () => {
    live = await createLiveDatabase('admin_audit_actor');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    person = await seedUser(live.db, state.organizationId, { email });
  });
  afterAll(async () => {
    await live?.destroy();
  });

  const call = {
    toolId: 'web_search',
    kind: 'read' as const,
    threadId: 'thread',
    messageId: 'message',
    outcome: 'ok' as const,
    approvalRequired: false,
    approval: null,
    durationMs: 12,
    resultBytes: 100,
  };

  it('records the email of the person whose reply called a tool', async () => {
    await recordToolCall({ ...call, userId: person });
    const rows = await live.db.execute<{ actor_user_id: string; actor_email: string | null }>(
      sql`select actor_user_id, actor_email from audit_log where action = 'tool.call'`,
    );
    expect(rows).toEqual([{ actor_user_id: person, actor_email: email }]);
  });

  it('shows the account’s email for entries recorded without one', async () => {
    // As every tool call was recorded before; and an entry with no actor at all.
    await live.db.insert(schema.auditLog).values([
      { organizationId: state.organizationId, actorUserId: person, action: 'tool.call.old' },
      { organizationId: state.organizationId, actorUserId: null, action: 'tool.call.old' },
    ]);
    const response = await app.request('/audit?action=tool.call.old');
    const { entries } = (await response.json()) as Listing;
    expect(entries.map(({ actorUserId, actorEmail }) => ({ actorUserId, actorEmail }))).toEqual(
      expect.arrayContaining([
        { actorUserId: person, actorEmail: email },
        { actorUserId: null, actorEmail: null },
      ]),
    );
    const csv = await (await app.request('/audit/export?action=tool.call.old')).text();
    expect(csv).toContain(`"${email}","${person}","tool.call.old"`);
    // A search by email still finds them.
    const found = (await (
      await app.request(`/audit?search=${encodeURIComponent(email)}&action=tool.call.old`)
    ).json()) as Listing;
    expect(found.entries).toHaveLength(1);
  });
});
