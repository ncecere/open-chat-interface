import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
 * A person's audit trail includes what was done with their address by
 * someone not signed in (#342): a password-reset request or a refused
 * sign-in records only an `actor_email`, no actor account. The entries are
 * written by the real auth-event recorder and read back through the real
 * audit route and account page.
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
const { recordAuthEvent } = await import('../../auth/audit.js');
const { getUserDetail } = await import('../../services/admin-users/detail.js');
const { auditEntryAbout } = await import('../../services/audit-subject.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

interface Listing {
  entries: { action: string; actorEmail: string | null }[];
  total: number;
}

const attempt = (path: string, status: number, email: string | null) =>
  recordAuthEvent({
    path,
    status,
    ipAddress: '203.0.113.9',
    userAgent: 'test',
    actorUserId: null,
    actorEmail: email,
  });

describe.skipIf(!available)('live: anonymous events in a person’s audit trail (#342)', () => {
  let live: LiveDatabase;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.route('/audit', auditRoutes);

  let person: string;
  let other: string;

  async function list(query: Record<string, string>): Promise<Listing> {
    const response = await app.request(`/audit?${new URLSearchParams(query)}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<Listing>;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_audit_anonymous');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    person = await seedUser(live.db, state.organizationId, { email: 'm.bell@example.test' });
    other = await seedUser(live.db, state.organizationId, { email: 'someone.else@example.test' });

    // What the public forms record: no signed-in account, only the address typed
    // (in whatever case the person typed it).
    await attempt('/request-password-reset', 200, 'M.Bell@Example.test');
    await attempt('/sign-in/email', 401, 'm.bell@example.test');
    await attempt('/sign-in/email', 401, 'm.bell@example.test');
    await attempt('/sign-in/email', 401, 'someone.else@example.test');
    await attempt('/sign-in/email', 401, 'm.bell@example.test.au');
    // A request with no address at all.
    await attempt('/sign-in/email', 401, null);
    // The person's own sign-in, made as them: found by their id as before.
    await live.db.insert(schema.auditLog).values({
      organizationId: state.organizationId,
      actorUserId: person,
      actorEmail: 'm.bell@example.test',
      action: 'auth.signin.local.success',
    });
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('lists reset requests and refused sign-ins made with the address in "Events by or about"', async () => {
    const { entries, total } = await list({ userId: person });
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'auth.password.reset_requested.success',
      'auth.signin.local.failure',
      'auth.signin.local.failure',
      'auth.signin.local.success',
    ]);
    expect(total).toBe(4);
    // Only that address: another account's, a longer address and none at all stay out.
    const theirs = await list({ userId: other });
    expect(theirs.entries.map((entry) => entry.action)).toEqual(['auth.signin.local.failure']);
  });

  it('shows them in Recent activity on the account page', async () => {
    const detail = await getUserDetail(person);
    expect(detail.audit.map((entry) => entry.action).sort()).toEqual([
      'auth.password.reset_requested.success',
      'auth.signin.local.failure',
      'auth.signin.local.failure',
      'auth.signin.local.success',
    ]);
  });

  it('is answered by the index scans of steps 0007, 0008 and 0010, not a pass over the log', async () => {
    // CREATE INDEX CONCURRENTLY cannot run in a transaction; the plain form
    // builds the same index.
    for (const name of [
      '0007_audit_log_target_index',
      '0008_audit_log_user_ids_index',
      '0010_audit_log_actor_email_index',
    ]) {
      const step = readFileSync(
        fileURLToPath(new URL(`../../../../../packages/db/post/${name}.sql`, import.meta.url)),
        'utf8',
      );
      await live.db.execute(sql.raw(step.replace(' CONCURRENTLY', '')));
    }
    const plan = await live.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain select 1 from ${schema.auditLog} where ${auditEntryAbout(person)}`,
      );
    });
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toContain('BitmapOr');
    expect(text).toContain('audit_log_actor_email_idx');
    expect(text).not.toContain('Seq Scan on audit_log');
  });
});
