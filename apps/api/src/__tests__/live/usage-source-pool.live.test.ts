import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * A budget check must never wait for a second database connection inside the
 * quota reservation's transaction. The reservation asked whether the usage
 * backfill (0.11.usage-rollups) had finished from inside its transaction, on
 * another pool connection; until the backfill finished, every reservation on
 * a busy replica held a connection while waiting for one, and once all were
 * held no turn was admitted. Here the app's pool has one connection, so a
 * wait for a second one never ends.
 */
const state = vi.hoisted(() => ({ db: null as unknown, sql: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { reserveQuota } = await import('../../services/quota/reservation.js');
const { resetReadinessCache } = await import('../../services/migrations/readiness.js');

const available = await livePostgresAvailable();

describe.skipIf(!available)('live: quota reservation with a busy pool', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('usage_source_pool');
    pool = createDatabase(live.connectionString, { max: 1 });
    db = pool.db;
    state.db = pool.db;
    state.sql = pool.sql;
    state.organizationId = await seedOrganization(db);
    userId = await seedUser(db, state.organizationId);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });
  beforeEach(() => {
    // Not known yet: the reservation has to find out whether the backfill finished.
    resetReadinessCache();
  });

  it('reserves under a budget without waiting for another connection', async () => {
    const reservation = reserveQuota({
      userId,
      role: 'user',
      modelSlug: 'pool-model',
      policies: [
        {
          id: randomUUID(),
          name: 'Daily budget',
          metric: 'messages',
          limitValue: 10,
          windowKind: 'rolling',
          windowHours: 24,
          timezone: 'UTC',
          modelSlugs: [],
        },
      ],
      pricing: { inputPriceMicros: 1, outputPriceMicros: 1 },
      reserve: { costMicros: 100, tokens: 50 },
    });
    const outcome = await Promise.race([
      reservation.then(() => 'reserved' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000)),
    ]);
    expect(outcome).toBe('reserved');
  }, 10_000);
});
