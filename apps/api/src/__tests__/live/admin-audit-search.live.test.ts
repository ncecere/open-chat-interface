import { schema } from '@oci/db';
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
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

const { auditRoutes } = await import('../../routes/admin/audit.js');
const { errorHandler } = await import('../../middleware/error-handler.js');

interface Listing {
  entries: { action: string; targetId: string | null; actorUserId: string | null }[];
  total: number;
}

describe.skipIf(!available)('live: audit log search', () => {
  let live: LiveDatabase;
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.route('/audit', auditRoutes);

  let organizationId: string;
  let admin: string;
  let person: string;

  async function list(query: Record<string, string>): Promise<Listing> {
    const response = await app.request(`/audit?${new URLSearchParams(query)}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<Listing>;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('admin_audit_search');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    admin = await seedUser(live.db, organizationId, { role: 'admin' });
    person = await seedUser(live.db, organizationId, { role: 'user' });

    await live.db.insert(schema.auditLog).values([
      // The person acting.
      {
        organizationId,
        actorUserId: person,
        actorEmail: 'walk.person@example.test',
        action: 'auth.signin.success',
      },
      // Things done to the person by an admin: the actor is the admin, and the
      // person appears only as the target.
      {
        organizationId,
        actorUserId: admin,
        actorEmail: 'walk.admin@example.test',
        action: 'user.update',
        targetType: 'user',
        targetId: person,
        metadata: { banned: true },
      },
      {
        organizationId,
        actorUserId: admin,
        actorEmail: 'walk.admin@example.test',
        action: 'user.revoke_sessions',
        targetType: 'user',
        targetId: person,
      },
      // A deleted account: its email survives only in the metadata.
      {
        organizationId,
        actorUserId: admin,
        actorEmail: 'walk.admin@example.test',
        action: 'user.delete',
        targetType: 'user',
        targetId: 'deleted-user-id',
        metadata: { email: 'walk.gone@example.test', role: 'user' },
      },
      // Unrelated.
      {
        organizationId,
        actorUserId: admin,
        actorEmail: 'walk.admin@example.test',
        action: 'settings.update',
      },
    ]);
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('lists every event by or about one account', async () => {
    const { entries, total } = await list({ userId: person });
    expect(total).toBe(3);
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'auth.signin.success',
      'user.revoke_sessions',
      'user.update',
    ]);
  });

  it('combines the account filter with an action filter', async () => {
    const { entries } = await list({ userId: person, action: 'user.' });
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'user.revoke_sessions',
      'user.update',
    ]);
  });

  it("finds a deleted account by the email kept in the event's metadata", async () => {
    const { entries } = await list({ search: 'walk.gone@', action: 'user.delete' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetId).toBe('deleted-user-id');
  });

  it('applies the same filters to the CSV export', async () => {
    const response = await app.request(`/audit/export?userId=${person}`);
    expect(response.status).toBe(200);
    const rows = (await response.text()).trim().split('\n').slice(1);
    expect(rows).toHaveLength(3);
  });
});
