import type { Database } from '@oci/db';
import { schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { DETAIL_SESSION_LIMIT, getUserDetail } from '../../services/admin-users/detail.js';

const state = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock('../../db/index.js', () => ({
  get db() {
    if (!state.db) throw new Error('Live database has not been initialized');
    return state.db;
  },
}));

const DAY = 86_400_000;

const available = await livePostgresAvailable();
describe.skipIf(!available)('live Postgres: a user’s active sessions (#134)', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let busy: string;
  let quiet: string;

  beforeAll(async () => {
    live = await createLiveDatabase('admin_sessions');
    state.db = live.db;
    organizationId = await seedOrganization(live.db);
    busy = await seedUser(live.db, organizationId, { email: 'busy@example.test' });
    quiet = await seedUser(live.db, organizationId, { email: 'quiet@example.test' });
    const now = Date.now();
    await live.db.insert(schema.session).values([
      // 14 live sessions, one created per minute, and 3 that have expired.
      ...Array.from({ length: 14 }, (_, index) => ({
        id: `live-${index}`,
        userId: busy,
        token: `live-token-${index}`,
        createdAt: new Date(now - index * 60_000),
        expiresAt: new Date(now + 7 * DAY),
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `expired-${index}`,
        userId: busy,
        token: `expired-token-${index}`,
        // Newer than every live one, so a list that kept them would show them first.
        createdAt: new Date(now + 60_000),
        expiresAt: new Date(now - DAY),
      })),
      {
        id: 'quiet-1',
        userId: quiet,
        token: 'quiet-token',
        expiresAt: new Date(now + DAY),
      },
    ]);
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  it('reports the true number of active sessions beside the few it lists', async () => {
    const detail = await getUserDetail(busy);
    expect(detail.sessionCount).toBe(14);
    expect(detail.sessions).toHaveLength(DETAIL_SESSION_LIMIT);
    // Newest first, and never an expired one.
    expect(detail.sessions.map((session) => session.id)).toEqual(
      Array.from({ length: DETAIL_SESSION_LIMIT }, (_, index) => `live-${index}`),
    );
  });

  it('counts only that account’s sessions', async () => {
    const detail = await getUserDetail(quiet);
    expect(detail.sessionCount).toBe(1);
    expect(detail.sessions.map((session) => session.id)).toEqual(['quiet-1']);
  });
});
