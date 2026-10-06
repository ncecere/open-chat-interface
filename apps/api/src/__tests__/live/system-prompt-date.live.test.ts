import { createDatabase, sql } from '@oci/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Today's date in the system prompt (#204), through real PostgreSQL and the
 * real settings: the instance's display time zone decides the day, so an
 * evening in New York is still that day, not tomorrow in UTC.
 */
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const available = await livePostgresAvailable();

describe.skipIf(!available)('the date in the system prompt', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let userId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('prompt_date');
    pool = createDatabase(live.connectionString, { max: 2 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    userId = await seedUser(pool.db, state.organizationId);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await pool.db.execute(sql`delete from instance_setting`);
    const { invalidateSettingsCache } = await import('../../services/settings.js');
    invalidateSettingsCache();
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function promptAt(iso: string) {
    const { invalidateSettingsCache } = await import('../../services/settings.js');
    invalidateSettingsCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    const { buildSystemPrompt } = await import('../../services/system-prompt.js');
    return buildSystemPrompt(userId, 'Test User');
  }

  it('gives the day in the instance’s display time zone, and names the zone', async () => {
    await pool.db.execute(
      sql`insert into instance_setting (organization_id, key, value)
          values (${state.organizationId}, 'retention', ${JSON.stringify({ displayTimezone: 'America/New_York' })}::jsonb)`,
    );
    // 21:55 on 5 October in New York is already 6 October in UTC.
    const prompt = await promptAt('2026-10-06T01:55:00Z');
    expect(prompt).toContain(
      "Today's date is Monday, October 5, 2026 (time zone America/New_York).",
    );
    expect(prompt.startsWith("The user's name is Test User.")).toBe(true);
  });

  it('uses UTC when no zone is set', async () => {
    const prompt = await promptAt('2026-10-06T01:55:00Z');
    expect(prompt).toContain("Today's date is Tuesday, October 6, 2026 (time zone UTC).");
  });
});
