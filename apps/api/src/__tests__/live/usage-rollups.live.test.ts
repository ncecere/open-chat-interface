import {
  createDatabase,
  type Database,
  foldAllUsageRollupChanges,
  foldUsageRollupChanges,
  scheduleBackgroundMigrations,
  sql,
  USAGE_ROLLUP_BACKFILL,
  usageRollupBackfill,
  usageRollupBacklog,
} from '@oci/db';
import type { QuotaWindowKind } from '@oci/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Usage rollups (migration 0040, the background migration 0.11.usage-rollups)
 * against real PostgreSQL.
 *
 * Every report and budget figure has two implementations: over the events,
 * and over the hourly rollups plus the unfolded change log plus partial hours
 * read from the events. These tests generate usage (several people, models,
 * pending, unknown and settled events, deleted accounts, events on and near
 * hour and local-day boundaries in zones with whole, half and quarter hour
 * offsets), change it the ways OCI does (settlement, release, deletion of an
 * account, retention, events written before the triggers existed and
 * backfilled), and check both implementations agree exactly, folded or not.
 */
const state = vi.hoisted(() => ({
  db: null as Database | null,
  sql: null as unknown,
  timezone: 'UTC',
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getDisplayTimezone: async () => state.timezone,
  getRetentionSettings: async () => ({ usageEventRetentionDays: 60 }),
}));

const report = await import('../../services/usage-report.js');
const { idleModels } = await import('../../services/usage-report/governance.js');
const { usageSource, nextWholeHour, straddlingHours } = await import(
  '../../services/usage-report/source.js'
);
const { windowTotalsIncludingPending } = await import('../../services/quota/usage-totals.js');
const { resolveWindow } = await import('../../services/quota/windows.js');
const { pruneUsageEvents } = await import('../../services/lifecycle/retention.js');
const { resetReadinessCache } = await import('../../services/migrations/readiness.js');
const { foldUsageRollups } = await import('../../services/usage-report/rollup-fold.js');
const { runBackgroundMigrations } = await import('../../services/migrations/background-runner.js');

const available = await livePostgresAvailable();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Not on an hour, so every range starts part-way through one. */
const NOW = new Date('2026-07-15T10:17:23.456Z');
const MODELS = ['model-a', 'model-b', 'model-c', 'embedding:text-small', 'rerank:fast'];
const ZONES = [
  'UTC',
  'America/New_York',
  'Asia/Kolkata', // +05:30
  'Asia/Kathmandu', // +05:45
  'Australia/Lord_Howe', // +10:30 / +11, a 30-minute DST shift
  'Pacific/Chatham', // +12:45 / +13:45
  'America/St_Johns', // -03:30 / -02:30
];

function prng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!available)('live: usage rollups', () => {
  let live: LiveDatabase;
  let db: Database;
  let client: postgres.Sql;
  let organizationId: string;
  let people: string[] = [];
  const random = prng(18);

  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

  beforeAll(async () => {
    live = await createLiveDatabase('usage_rollups');
    db = live.db;
    state.db = db;
    // The application's own kind of client: Drizzle changes its JSON handling.
    client = createDatabase(live.connectionString, { max: 4 }).sql;
    state.sql = client;
    organizationId = await seedOrganization(db);
    const [provider] = await db.execute<{ id: string }>(sql`
      insert into provider (organization_id, kind, label)
      values (${organizationId}, 'openai', 'Provider') returning id`);
    // Enabled and never used ('model-idle'): idle in every range.
    for (const slug of [...MODELS, 'model-idle']) {
      await db.execute(sql`
        insert into model (organization_id, provider_id, slug, upstream_model_id, display_name, enabled)
        values (${organizationId}, ${provider!.id}, ${slug}, ${slug}, ${`Model ${slug}`}, true)`);
    }
  });

  afterAll(async () => {
    state.db = null;
    await client?.end({ timeout: 5 });
    await live?.destroy();
  });

  beforeEach(async () => {
    await db.execute(sql`delete from usage_event`);
    await db.execute(sql`delete from usage_rollup_change`);
    await db.execute(sql`delete from usage_rollup_hour`);
    await db.execute(sql`delete from usage_rollup_model_hour`);
    await db.execute(sql`delete from background_migration`);
    resetReadinessCache();
    state.timezone = 'UTC';
    people = [];
    for (let index = 0; index < 6; index += 1) {
      people.push(await seedUser(db, organizationId, { role: index === 0 ? 'admin' : 'user' }));
    }
  });

  /** An instant within the last `days`, sometimes exactly on an hour or a half or quarter past. */
  function instant(days: number): Date {
    const base = NOW.getTime() - random() * days * DAY;
    const shape = random();
    if (shape < 0.1) return new Date(Math.floor(base / HOUR) * HOUR);
    if (shape < 0.2) return new Date(Math.floor(base / HOUR) * HOUR + 30 * 60 * 1000);
    if (shape < 0.25) return new Date(Math.floor(base / HOUR) * HOUR + 45 * 60 * 1000 - 1);
    return new Date(Math.floor(base));
  }

  /** Inserts `count` events in multi-row statements, as a backfill or import would. */
  async function generate(count: number, days = 100, owners: Array<string | null> = people) {
    const rows = Array.from({ length: count }, () => {
      const pending = random() < 0.1;
      const unknown = pending || random() < 0.1;
      const tokensIn = pending ? 0 : Math.floor(random() * 5_000);
      const tokensOut = pending ? 0 : Math.floor(random() * 2_000);
      return {
        userId: pick(owners),
        modelSlug: pick(MODELS),
        occurredAt: instant(days).toISOString(),
        messageCount: random() < 0.2 ? 0 : 1,
        tokensIn,
        tokensOut,
        costMicros: pending ? 0 : Math.floor(random() * 90_000),
        pending,
        unknown,
        reservedCost: unknown ? Math.floor(random() * 5_000) : 0,
        reservedTokens: unknown ? Math.floor(random() * 500) : 0,
      };
    });
    for (let index = 0; index < rows.length; index += 50) {
      const chunk = rows.slice(index, index + 50);
      await db.execute(sql`
        insert into usage_event (organization_id, user_id, model_slug, occurred_at, message_count,
          tokens_in, tokens_out, cost_micros, pending, usage_unknown, reserved_cost_micros, reserved_tokens)
        values ${sql.join(
          chunk.map(
            (
              row,
            ) => sql`(${organizationId}, ${row.userId}, ${row.modelSlug}, ${row.occurredAt}::timestamptz,
              ${row.messageCount}, ${row.tokensIn}, ${row.tokensOut}, ${row.costMicros}, ${row.pending},
              ${row.unknown}, ${row.reservedCost}, ${row.reservedTokens})`,
          ),
          sql`, `,
        )}`);
    }
  }

  async function fold(limit?: number) {
    return foldAllUsageRollupChanges(client, limit === undefined ? {} : { limit, budgetMs: 0 });
  }

  /** Every report figure, from one source, for each range and zone. */
  async function reports(source: 'events' | 'rollups') {
    const out: Record<string, unknown> = {};
    for (const days of [7, 30, 90]) {
      const options = { source, now: NOW };
      out[`totals-${days}`] = await report.usageTotals(days, options);
      out[`models-${days}`] = await report.modelUsage(days, 3, options);
      out[`consumers-${days}`] = await report.topConsumers(days, 4, options);
      out[`idle-${days}`] = await idleModels(days, 30, options);
      for (const zone of days === 30 ? ZONES : ['UTC', 'Asia/Kathmandu']) {
        state.timezone = zone;
        out[`daily-${days}-${zone}`] = await report.dailyUsage(days, options);
        out[`activity-${days}-${zone}`] = await report.dailyActivity(days, options);
      }
      state.timezone = 'UTC';
    }
    return out;
  }

  /** Budget totals for every person, window kind and model scope, from one source. */
  async function budgets(source: 'events' | 'rollups', exclude?: string) {
    const out: Record<string, unknown> = {};
    const windows: Array<{
      windowKind: QuotaWindowKind;
      windowHours: number | null;
      timezone: string;
    }> = [
      { windowKind: 'rolling', windowHours: 5, timezone: 'UTC' },
      { windowKind: 'rolling', windowHours: 24 * 9 + 1, timezone: 'UTC' },
      { windowKind: 'daily', windowHours: null, timezone: 'Asia/Kolkata' },
      { windowKind: 'weekly', windowHours: null, timezone: 'America/New_York' },
      { windowKind: 'monthly', windowHours: null, timezone: 'Pacific/Chatham' },
      { windowKind: 'monthly', windowHours: null, timezone: 'UTC' },
    ];
    for (const person of people) {
      for (const window of windows) {
        const { start } = resolveWindow(window, NOW);
        for (const models of [[], ['model-a'], ['model-b', 'embedding:text-small']]) {
          out[`${person}-${window.windowKind}-${window.timezone}-${models.join('+')}`] =
            await windowTotalsIncludingPending(db, person, start, models, exclude, source);
        }
      }
    }
    return out;
  }

  async function expectSameFigures() {
    const events = await reports('events');
    expect(await reports('rollups')).toEqual(events);
    expect(await budgets('rollups')).toEqual(await budgets('events'));
    return events;
  }

  it('answers every report and budget exactly, folded, partly folded or not folded', async () => {
    await generate(900);
    const figures = await expectSameFigures();
    // The data is not degenerate: every range has usage, people and models.
    expect((figures['totals-7'] as { messages: number }).messages).toBeGreaterThan(0);
    expect((figures['consumers-90'] as { totalCount: number }).totalCount).toBe(6);
    expect((figures['idle-90'] as { entries: Array<{ slug: string }> }).entries).toEqual([
      expect.objectContaining({ slug: 'model-idle' }),
    ]);
    // Kathmandu's days start at 18:15 UTC: some hours straddle two local days.
    expect(figures['daily-30-Asia/Kathmandu']).not.toEqual(figures['daily-30-UTC']);

    expect(await usageRollupBacklog(client)).toBeGreaterThan(0);
    // Part of the log, then all of it.
    await client.begin((tx) => foldUsageRollupChanges(tx, 40));
    await expectSameFigures();
    await fold();
    expect(await usageRollupBacklog(client)).toBe(0);
    await expectSameFigures();
    // Rollups are far fewer rows than events.
    const [counts] = await client<{ events: number; people: number; models: number }[]>`
      select (select count(*) from usage_event)::int as events,
             (select count(*) from usage_rollup_hour)::int as people,
             (select count(*) from usage_rollup_model_hour)::int as models`;
    expect(counts!.people).toBeLessThanOrEqual(counts!.events);
    expect(counts!.models).toBeLessThan(counts!.people);
  });

  it('follows settlement, amendments, release and budget exclusions as OCI makes them', async () => {
    await generate(400, 20);
    await fold();
    // Settle every pending event, amend some unknown ones, release a few.
    await db.execute(sql`
      update usage_event set pending = false, tokens_in = 120, tokens_out = 80, cost_micros = 7_000,
        reserved_cost_micros = 0, reserved_tokens = 0, usage_unknown = false
      where pending`);
    await db.execute(sql`
      update usage_event set tokens_out = tokens_out + 11, cost_micros = cost_micros + 13
      where usage_unknown and id in (select id from usage_event where usage_unknown order by id limit 10)`);
    await db.execute(sql`
      delete from usage_event where id in (select id from usage_event order by id desc limit 7)`);
    // An event moved to another hour and model (never done by OCI, but a
    // difference must follow any change).
    await db.execute(sql`
      update usage_event set occurred_at = occurred_at - interval '3 hours 7 minutes', model_slug = 'model-c'
      where id in (select id from usage_event order by id limit 3)`);
    await expectSameFigures();
    await fold();
    await expectSameFigures();

    // A running reply asks about its allowance without its own reservation,
    // whether that reservation is in a whole hour (rollups) or the first,
    // partial one (events).
    const [inside] = await db.execute<{ id: string; user_id: string }>(sql`
      insert into usage_event (organization_id, user_id, model_slug, occurred_at, message_count,
        pending, usage_unknown, reserved_cost_micros, reserved_tokens)
      values (${organizationId}, ${people[1]}, 'model-a', ${new Date(NOW.getTime() - 2 * HOUR).toISOString()}::timestamptz,
        1, true, true, 40_000, 300)
      returning id, user_id`);
    const [edge] = await db.execute<{ id: string }>(sql`
      insert into usage_event (organization_id, user_id, model_slug, occurred_at, message_count,
        pending, usage_unknown, reserved_cost_micros, reserved_tokens)
      values (${organizationId}, ${people[1]}, 'model-a', ${new Date(NOW.getTime() - 5 * HOUR + 60_000).toISOString()}::timestamptz,
        1, true, true, 30_000, 200)
      returning id`);
    for (const exclude of [inside!.id, edge!.id]) {
      expect(await budgets('rollups', exclude)).toEqual(await budgets('events', exclude));
      await fold();
      expect(await budgets('rollups', exclude)).toEqual(await budgets('events', exclude));
    }
  });

  it('moves a deleted account to Deleted accounts, leaving nothing that names it once folded', async () => {
    await generate(500, 40);
    await fold();
    const [leaving, alsoLeaving] = [people[2]!, people[3]!];
    await db.execute(sql`delete from usage_event where user_id = ${leaving} and pending`);
    await db.execute(sql`delete from "user" where id = ${leaving}`);
    people = people.filter((person) => person !== leaving);
    const figures = await expectSameFigures();
    const consumers = figures['consumers-90'] as {
      entries: Array<{ deleted: boolean }>;
      totalCount: number;
    };
    expect(consumers.totalCount).toBe(6); // five people and Deleted accounts
    await fold();
    await expectSameFigures();
    // A second deletion merges into the same Deleted accounts rows.
    await db.execute(sql`delete from usage_event where user_id = ${alsoLeaving} and pending`);
    await db.execute(sql`delete from "user" where id = ${alsoLeaving}`);
    people = people.filter((person) => person !== alsoLeaving);
    await fold();
    await expectSameFigures();
    const [left] = await client<{ rows: number; duplicates: number }[]>`
      select (select count(*) from usage_rollup_hour where user_id in (${leaving}, ${alsoLeaving}))::int as rows,
             (select count(*) from (select hour, model_slug from usage_rollup_hour where user_id is null
                group by 1, 2 having count(*) > 1) d)::int as duplicates`;
    expect(left).toEqual({ rows: 0, duplicates: 0 });
  });

  it('prunes with retention, keeping what is kept (legal holds included)', async () => {
    await generate(600, 120);
    await fold();
    // A person on legal hold keeps their old usage, in the events and the rollups.
    await db.execute(sql`
      insert into legal_hold (organization_id, user_id, user_email, reason)
      values (${organizationId}, ${people[4]}, 'held@example.test', 'Litigation')`);
    expect(await pruneUsageEvents(NOW)).toBeGreaterThan(0);
    const [kept] = await client<{ old: number }[]>`
      select count(*)::int as old from usage_event
      where occurred_at < ${new Date(NOW.getTime() - 62 * DAY).toISOString()}::timestamptz`;
    expect(kept!.old).toBeGreaterThan(0);
    await expectSameFigures();
    await fold();
    await expectSameFigures();
    // Rollups hold exactly the kept events, hour by hour.
    const mismatched = await client`
      with events as (
        select date_trunc('hour', occurred_at, 'UTC') as hour, user_id, model_slug, count(*) as n,
          sum(cost_micros) filter (where not pending) as cost
        from usage_event group by 1, 2, 3
      )
      select * from events e full join usage_rollup_hour r
        on r.hour = e.hour and r.user_id is not distinct from e.user_id and r.model_slug = e.model_slug
      where e.n is distinct from r.events or coalesce(e.cost, 0) is distinct from r.cost_micros`;
    expect(mismatched).toEqual([]);
  });

  it('backfills events written before the triggers, exactly, through changes made meanwhile', async () => {
    // Events from before migration 0040: no marker, no change rows.
    await client`alter table usage_event disable trigger usage_event_mark_in_rollup`;
    await client`alter table usage_event disable trigger usage_event_rollup_insert`;
    try {
      await generate(700, 60);
    } finally {
      await client`alter table usage_event enable trigger usage_event_mark_in_rollup`;
      await client`alter table usage_event enable trigger usage_event_rollup_insert`;
    }
    const [unmarked] = await client<{ n: number }[]>`
      select count(*)::int as n from usage_event where in_rollup is null`;
    expect(unmarked!.n).toBe(700);
    expect(await usageRollupBacklog(client)).toBe(0);
    // Until the backfill finishes, reports and budgets read the events.
    expect(await usageSource()).toBe('events');

    // Meanwhile: new usage, an old event settled, another released, an account deleted.
    await generate(100, 2);
    await db.execute(sql`
      update usage_event set pending = false, tokens_in = 9, cost_micros = 99
      where id = (select id from usage_event where pending and in_rollup is null order by id limit 1)`);
    await db.execute(sql`
      delete from usage_event where id = (select id from usage_event where in_rollup is null order by id desc limit 1)`);
    const leaving = people[5]!;
    await db.execute(sql`delete from usage_event where user_id = ${leaving} and pending`);
    await db.execute(sql`delete from "user" where id = ${leaving}`);
    people = people.filter((person) => person !== leaving);

    // Scheduled as `migrate --post` does, then run by the job runner in
    // small batches; a batch run twice (a lost commit) changes nothing.
    expect(await scheduleBackgroundMigrations(client, [usageRollupBackfill])).toEqual([
      USAGE_ROLLUP_BACKFILL,
    ]);
    await client`update background_migration set batch_size = 97, pause_ms = 0`;
    await client.begin((tx) => usageRollupBackfill.batch(tx, { cursor: null, batchSize: 50 }));
    await client.begin((tx) => usageRollupBackfill.batch(tx, { cursor: null, batchSize: 50 }));
    const processed = await runBackgroundMigrations({
      client,
      definitions: [usageRollupBackfill],
      throttle: async () => null,
      shouldStop: () => false,
    });
    expect(processed).toBeGreaterThanOrEqual(700);
    const [migration] = await client<{ status: string }[]>`
      select status from background_migration where name = ${USAGE_ROLLUP_BACKFILL}`;
    expect(migration?.status).toBe('finished');
    const [left] = await client<{ n: number }[]>`
      select count(*)::int as n from usage_event where in_rollup is not true`;
    expect(left!.n).toBe(0);

    resetReadinessCache();
    expect(await usageSource()).toBe('rollups');
    // Callers that name no source (the pages, the scheduled report, budget
    // checks) now read the rollups, with the same answers.
    const viaDefault = await report.usageTotals(30, { now: NOW });
    expect(viaDefault.messages).toBeGreaterThan(0);
    expect(viaDefault).toEqual(await report.usageTotals(30, { source: 'events', now: NOW }));
    await expectSameFigures();
    await fold();
    await expectSameFigures();
  });

  it('folds one transaction at a time, and folding again changes nothing', async () => {
    await generate(200, 10);
    const holder = await client.reserve();
    try {
      await holder`begin`;
      await holder`select pg_advisory_xact_lock(7311890418002)`;
      expect(await client.begin((tx) => foldUsageRollupChanges(tx))).toEqual({
        changes: 0,
        locked: false,
      });
      await holder`rollback`;
    } finally {
      holder.release();
    }
    // The job's own entry point, with the application's client.
    expect(await foldUsageRollups()).toBeGreaterThan(0);
    const before = await client`select * from usage_rollup_hour order by hour, user_id, model_slug`;
    expect(await fold()).toBe(0);
    expect(
      await client`select * from usage_rollup_hour order by hour, user_id, model_slug`,
    ).toEqual(before);
  });

  it('reads from the events only the hours a local midnight falls inside', async () => {
    const start = new Date('2026-07-10T10:17:00Z');
    expect(await straddlingHours(start, 'UTC')).toEqual([]);
    expect(await straddlingHours(start, 'America/New_York')).toEqual([]);
    // Kathmandu (+05:45): midnight is 18:15 UTC, inside the 18:00 hour.
    const kathmandu = await straddlingHours(start, 'Asia/Kathmandu');
    expect(kathmandu.slice(0, 2)).toEqual(['2026-07-10T18:00:00Z', '2026-07-11T18:00:00Z']);
    // Lord Howe (+10:30 in winter): 13:30 UTC.
    expect((await straddlingHours(start, 'Australia/Lord_Howe'))[0]).toBe('2026-07-10T13:00:00Z');
  });

  it('starts whole hours at the next UTC hour', () => {
    expect(nextWholeHour(new Date('2026-07-15T10:00:00.000Z')).toISOString()).toBe(
      '2026-07-15T10:00:00.000Z',
    );
    expect(nextWholeHour(new Date('2026-07-15T10:00:00.001Z')).toISOString()).toBe(
      '2026-07-15T11:00:00.000Z',
    );
  });
});
