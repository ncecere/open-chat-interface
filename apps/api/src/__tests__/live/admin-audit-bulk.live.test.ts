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
 * A person's audit trail includes the bulk actions that named them (#216):
 * the entries are written by the real bulk-action service and read back
 * through the real audit routes, account page and retention job.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  settings: new Map<string, unknown>(),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => structuredClone(state.settings.get(key) ?? {}),
}));

const { auditRoutes } = await import('../../routes/admin/audit.js');
const { applyBulkUserAction } = await import('../../services/admin-users/bulk-actions.js');
const { getUserDetail } = await import('../../services/admin-users/detail.js');
const { pruneAuditLog } = await import('../../services/lifecycle/retention.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

interface Listing {
  entries: { action: string; metadata: Record<string, unknown> | null }[];
  total: number;
}

describe.skipIf(!available)('live: bulk actions in a person’s audit trail (#216)', () => {
  let live: LiveDatabase;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.route('/audit', auditRoutes);

  let admin: { id: string; email: string };
  let person: string;
  let other: string;

  async function list(query: Record<string, string>): Promise<Listing> {
    const response = await app.request(`/audit?${new URLSearchParams(query)}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<Listing>;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_audit_bulk');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    const organizationId = state.organizationId;
    admin = {
      id: await seedUser(live.db, organizationId, {
        role: 'admin',
        email: 'bulk.admin@example.test',
      }),
      email: 'bulk.admin@example.test',
    };
    person = await seedUser(live.db, organizationId, { email: 'bulk.invitee@example.test' });
    other = await seedUser(live.db, organizationId, { email: 'bulk.other@example.test' });

    // What the Users list's bulk bar does: the admin selected themselves too.
    await applyBulkUserAction(
      admin,
      { userIds: [admin.id, person], action: 'revoke_sessions' },
      null,
    );
    await applyBulkUserAction(
      admin,
      { userIds: [admin.id, person, other], action: 'set_role', role: 'auditor' },
      null,
    );
    await applyBulkUserAction(admin, { userIds: [other], action: 'ban' }, null);
    // A single-account change, for comparison.
    await live.db.insert(schema.auditLog).values({
      organizationId,
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: 'user.role.change',
      targetType: 'user',
      targetId: person,
      metadata: { from: 'user', to: 'restricted' },
    });
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('lists the bulk actions that named the account in "Events by or about"', async () => {
    const { entries, total } = await list({ userId: person });
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'user.bulk.revoke_sessions',
      'user.bulk.set_role',
      'user.role.change',
    ]);
    expect(total).toBe(3);
    // The other account was named by the ban but not the sign-out.
    const theirs = await list({ userId: other });
    expect(theirs.entries.map((entry) => entry.action).sort()).toEqual([
      'user.bulk.ban',
      'user.bulk.set_role',
    ]);
  });

  it('shows them in Recent activity on the account page', async () => {
    const detail = await getUserDetail(person);
    expect(detail.audit.map((entry) => entry.action).sort()).toEqual([
      'user.bulk.revoke_sessions',
      'user.bulk.set_role',
      'user.role.change',
    ]);
  });

  it("finds what was done to an account by searching for the account's email", async () => {
    const { entries } = await list({ search: 'bulk.invitee' });
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'user.bulk.revoke_sessions',
      'user.bulk.set_role',
      'user.role.change',
    ]);
    // A search that names nobody still matches nothing extra.
    expect((await list({ search: 'nobody-at-all' })).total).toBe(0);
  });

  it('keeps a bulk sign-out naming a person on legal hold from audit retention', async () => {
    await live.db.insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: person,
      userEmail: 'bulk.invitee@example.test',
      reason: 'Matter 216',
    });
    // An unprotected entry about nobody on hold, which retention does prune.
    await live.db.insert(schema.auditLog).values({
      organizationId: state.organizationId,
      actorUserId: other,
      action: 'thread.export',
    });
    state.settings.set('retention', { auditLogRetentionDays: 30 });
    // Ninety days on, every entry is past retention.
    await pruneAuditLog(new Date(Date.now() + 90 * 86_400_000));
    const left = await live.db.execute<{ action: string }>(
      sql`select action from audit_log order by action`,
    );
    // Role changes and bans are always kept; the sign-out only because it
    // named the held account.
    expect(left.map((row) => row.action)).toEqual([
      'user.bulk.ban',
      'user.bulk.revoke_sessions',
      'user.bulk.set_role',
      'user.role.change',
    ]);
  });
});
