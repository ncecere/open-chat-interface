import { createDatabase, schema, sql } from '@oci/db';
import type { AdminOverview } from '@oci/shared';
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
import { activityWindowStart } from '../../services/overview-activity.js';

/**
 * The Overview's "Messages per day" has a point for each of the last fourteen
 * days, the quiet ones at zero (#348): it used to list only the days that had
 * messages, so the chart spread them evenly and its label counted points.
 * Through the real route and the real message table, with the database
 * session in a zone behind UTC, which must not move a message to another day.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, sql: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!available)('live: Overview messages per day (#348)', () => {
  let live: LiveDatabase;
  let session: ReturnType<typeof createDatabase>;
  const app = new Hono<AppBindings>();

  beforeAll(async () => {
    live = await createLiveDatabase('admin_overview_activity');
    // A session zone behind UTC, on connections made from here on.
    const name = new URL(live.connectionString).pathname.slice(1);
    await live.db.execute(sql.raw(`alter database "${name}" set timezone to 'America/New_York'`));
    session = createDatabase(live.connectionString, { max: 2 });
    state.db = session.db;
    state.sql = session.sql;
    const organizationId = await seedOrganization(live.db);
    const user = await seedUser(live.db, organizationId, { role: 'admin' });
    const [thread] = await live.db
      .insert(schema.thread)
      .values({ organizationId, userId: user })
      .returning({ id: schema.thread.id });

    const first = activityWindowStart(new Date()).getTime();
    const at = (dayIndex: number, hour: number, minute = 0) =>
      new Date(first + dayIndex * DAY_MS + (hour * 60 + minute) * 60_000);
    // Day 0 is the oldest day of the window; day 13 is today. 02:00 UTC is
    // 22:00 the evening before in New York.
    const times = [
      at(0, 0, 0),
      at(0, 12),
      at(11, 2),
      at(11, 2, 30),
      at(11, 23, 59),
      at(13, 0, 0),
      // Outside the window.
      new Date(first - 1000),
      new Date(first - 5 * DAY_MS),
    ];
    await live.db.insert(schema.message).values(
      times.map((createdAt, position) => ({
        threadId: thread!.id,
        userId: user,
        role: 'user' as const,
        position,
        parts: [{ type: 'text', text: 'Overview fixture' }],
        createdAt,
      })),
    );

    const { overviewRoutes } = await import('../../routes/admin/overview.js');
    app.route('/overview', overviewRoutes);
  });
  afterAll(async () => {
    await session?.sql.end({ timeout: 1 });
    state.db = null;
    await live?.destroy();
  });

  it('has a point for each of the last fourteen days, the empty ones at zero', async () => {
    const response = await app.request('/overview');
    expect(response.status, await response.clone().text()).toBe(200);
    const { activity } = (await response.json()) as AdminOverview;

    expect(activity).toHaveLength(14);
    const days = activity.map((point) => point.day);
    expect(days).toEqual([...days].sort());
    expect(new Set(days).size).toBe(14);
    expect(days.at(-1)).toBe(new Date().toISOString().slice(0, 10));
    expect(days.at(0)).toBe(new Date(activityWindowStart(new Date())).toISOString().slice(0, 10));

    const counts = Object.fromEntries(activity.map((point) => [point.day, point.messages]));
    // By UTC day, whatever the session's zone: 22:00 the evening before in New
    // York is still its UTC day.
    expect(activity.map((point) => point.messages)).toEqual([
      2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 1,
    ]);
    expect(Object.values(counts).reduce((total, value) => total + value, 0)).toBe(6);
  });
});
