import { readFileSync } from 'node:fs';
import { type Database, eq, runMigrations, schema, sql } from '@oci/db';
import { DELETED_ACCOUNTS_LABEL } from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Usage kept after an account is deleted (v0.10, migration 0038; see
 * docs/dev/v0.10-design.md, "Usage kept after deletion").
 *
 * Deleting an account, by an administrator or by the person, keeps its usage
 * events, daily totals and limit refusals with the link to the person removed,
 * so instance totals do not change after the fact. Reports show them as one
 * "Deleted accounts" row; per-person views no longer see them. In-flight
 * reservations, limit overrides and the storage counter go with the account.
 */
const state = vi.hoisted(() => ({
  db: null as Database | null,
  organizationId: '',
  sent: [] as Array<{ to: string; subject: string; text?: string }>,
}));
// Read lazily: Better Auth takes the adapter at import, before the database exists.
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/lifecycle/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lifecycle/settings.js')>()),
  getDisplayTimezone: async () => 'UTC',
  getRetentionSettings: async () => ({ usageEventRetentionDays: 30 }),
}));
vi.mock('../../services/email.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email.js')>()),
  isSmtpUsable: async () => true,
  sendEmail: async (email: { to: string; subject: string; text?: string }) => {
    state.sent.push(email);
    return { delivered: true };
  },
}));

const { deleteUser } = await import('../../services/admin-users/mutations.js');
const { dailyUsage, modelUsage, topConsumers, usageTotals, denialSummary } = await import(
  '../../services/usage-report.js'
);
const { getUsageSummary, sweepAbandonedReservations, RESERVATION_TTL_MS } = await import(
  '../../services/quota/index.js'
);
const { settleLockedEvent } = await import('../../services/quota/settlement.js');
const { pruneUsageEvents } = await import('../../services/lifecycle/retention.js');
const { runDueReports } = await import('../../services/reports.js');

const available = await livePostgresAvailable();
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!available)('live: usage kept after an account is deleted', () => {
  let live: LiveDatabase;
  let db: Database;
  let admin: string;

  beforeAll(async () => {
    live = await createLiveDatabase('usage_kept');
    db = live.db;
    state.db = db;
    state.organizationId = await seedOrganization(db);
    admin = await seedUser(db, state.organizationId, {
      role: 'admin',
      email: 'admin@example.test',
    });
  });
  beforeEach(async () => {
    await db.delete(schema.usageEvent);
    await db.delete(schema.usageRecord);
    await db.delete(schema.quotaDenial);
    await db.delete(schema.scheduledReport);
    state.sent = [];
  });
  afterAll(async () => {
    state.db = null;
    await live?.destroy();
  });

  async function usage(
    userId: string | null,
    values: Partial<typeof schema.usageEvent.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(schema.usageEvent)
      .values({
        organizationId: state.organizationId,
        userId,
        modelSlug: 'kept-model',
        messageCount: 1,
        tokensIn: 10,
        tokensOut: 20,
        costMicros: 1_000,
        ...values,
      })
      .returning();
    return row!;
  }

  async function eventsOf(ids: string[]) {
    const rows = await db.select().from(schema.usageEvent);
    return rows.filter((row) => ids.includes(row.id));
  }

  async function amounts() {
    const { activeUsers, ...totals } = await usageTotals(30);
    return { totals, activeUsers, models: await modelUsage(30), daily: await dailyUsage(30) };
  }

  it('keeps usage without the person when an administrator deletes the account', async () => {
    const leaving = await seedUser(db, state.organizationId, {
      email: 'leaving@example.test',
      role: 'user',
    });
    const staying = await seedUser(db, state.organizationId);
    const settled = await usage(leaving, { costMicros: 4_000 });
    const unknown = await usage(leaving, {
      usageUnknown: true,
      reservedCostMicros: 50,
      reservedTokens: 5,
    });
    const reservation = await usage(leaving, {
      pending: true,
      usageUnknown: true,
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
      reservedCostMicros: 500,
    });
    await usage(staying, { costMicros: 2_000 });
    await db.insert(schema.usageRecord).values({
      organizationId: state.organizationId,
      userId: leaving,
      modelSlug: 'kept-model',
      day: new Date().toISOString().slice(0, 10),
      messageCount: 2,
      costMicros: 5_000,
    });
    await db.insert(schema.quotaDenial).values({
      organizationId: state.organizationId,
      userId: leaving,
      policyId: 'policy-kept',
      policyName: 'Daily messages',
      modelSlug: 'kept-model',
      day: new Date().toISOString().slice(0, 10),
      denialCount: 3,
    });
    const [policy] = await db
      .insert(schema.quotaPolicy)
      .values({
        organizationId: state.organizationId,
        name: 'Kept policy',
        metric: 'messages',
        limitValue: 10,
      })
      .returning();
    await db.insert(schema.quotaPolicyOverride).values({
      policyId: policy!.id,
      userId: leaving,
      limitValue: 20,
    });
    await db.insert(schema.storageUsage).values({
      organizationId: state.organizationId,
      userId: leaving,
      liveBytes: 10,
    });

    const before = await amounts();
    expect(before.activeUsers).toBe(2);

    await deleteUser({ id: admin, email: 'admin@example.test' }, leaving);

    // Measured usage stays, without the person; the in-flight reservation goes.
    const kept = await eventsOf([settled.id, unknown.id, reservation.id]);
    expect(kept.map((row) => [row.id, row.userId]).sort()).toEqual(
      [
        [settled.id, null],
        [unknown.id, null],
      ].sort(),
    );
    expect(await db.select().from(schema.usageRecord)).toEqual([
      expect.objectContaining({ userId: null, messageCount: 2, costMicros: 5_000 }),
    ]);
    expect(await db.select().from(schema.quotaDenial)).toEqual([
      expect.objectContaining({ userId: null, policyName: 'Daily messages', denialCount: 3 }),
    ]);
    // Per-person live state goes with the account.
    expect(await db.select().from(schema.quotaPolicyOverride)).toEqual([]);
    expect(
      await db.select().from(schema.storageUsage).where(eq(schema.storageUsage.userId, leaving)),
    ).toEqual([]);

    // Instance and per-model totals are what they were; only the count of
    // people with an account changes.
    const after = await amounts();
    expect(after.totals).toEqual(before.totals);
    expect(after.models).toEqual(before.models);
    expect(after.daily).toEqual(before.daily);
    expect(after.activeUsers).toBe(1);
    const limits = await denialSummary(30);
    expect(limits.entries).toEqual([
      expect.objectContaining({ policyName: 'Daily messages', denials: 3, usersAffected: 0 }),
    ]);

    // Nothing that identifies the person is left in the kept rows.
    const dumps = await db.execute<{ row: string }>(sql`
      select row_to_json(e)::text as row from usage_event e where user_id is null
      union all select row_to_json(r)::text from usage_record r where user_id is null
      union all select row_to_json(d)::text from quota_denial d where user_id is null`);
    expect(dumps).toHaveLength(4);
    for (const { row } of dumps) {
      expect(row).not.toContain(leaving);
      expect(row).not.toContain('leaving@example.test');
      expect(row).not.toContain('Test User');
    }
  });

  it('reports deleted accounts as one row, which per-person views never see', async () => {
    const first = await seedUser(db, state.organizationId, { email: 'first@example.test' });
    const second = await seedUser(db, state.organizationId, { email: 'second@example.test' });
    const staying = await seedUser(db, state.organizationId, { email: 'staying@example.test' });
    await usage(first, { costMicros: 3_000 });
    await usage(second, { costMicros: 4_000, messageCount: 2 });
    await usage(staying, { costMicros: 1_000 });
    const stayingBefore = await getUsageSummary(staying, 'user');

    await deleteUser({ id: admin, email: 'admin@example.test' }, first);
    await deleteUser({ id: admin, email: 'admin@example.test' }, second);

    const consumers = await topConsumers(30);
    expect(consumers.totalCount).toBe(2);
    expect(consumers.entries).toEqual([
      {
        deleted: true,
        userId: null,
        name: DELETED_ACCOUNTS_LABEL,
        email: null,
        role: null,
        messages: 3,
        tokens: 60,
        costMicros: 7_000,
      },
      {
        deleted: false,
        userId: staying,
        name: 'Test User',
        email: 'staying@example.test',
        role: 'user',
        messages: 1,
        tokens: 30,
        costMicros: 1_000,
      },
    ]);
    expect(await usageTotals(30)).toEqual({
      messages: 4,
      tokens: 90,
      costMicros: 8_000,
      activeUsers: 1,
    });
    // A person's own meter counts only their own usage, before and after.
    expect(await getUsageSummary(staying, 'user')).toEqual(stayingBefore);
    expect(stayingBefore.recent).toEqual({ messages: 1, tokens: 30, costMicros: 1_000 });
  });

  it('names deleted accounts in the scheduled report without an address', async () => {
    const leaving = await seedUser(db, state.organizationId, { email: 'gone@example.test' });
    const staying = await seedUser(db, state.organizationId, { email: 'here@example.test' });
    await usage(leaving, { messageCount: 5, costMicros: 5_000_000 });
    await usage(staying, { messageCount: 1, costMicros: 1_000_000 });
    await deleteUser({ id: admin, email: 'admin@example.test' }, leaving);
    await db.insert(schema.scheduledReport).values({
      organizationId: state.organizationId,
      name: 'Monthly',
      cadence: 'monthly',
      windowDays: 30,
      recipients: ['finance@example.test'],
    });

    expect(await runDueReports()).toBe(1);
    const body = state.sent[0]?.text ?? '';
    expect(body).toContain('Messages:      6');
    expect(body).toContain('Cost:          $6.00');
    expect(body).toContain('Active people: 1');
    expect(body).toContain(`  ${DELETED_ACCOUNTS_LABEL}  5 messages`);
    // One message, not "1 messages" (#78).
    expect(body).toMatch(/^ {2}here@example\.test {2}1 message$/m);
    expect(body).not.toContain('gone@example.test');
  });

  it('prunes a deleted account’s old usage by age, even unresolved, and never settles it', async () => {
    const owner = await seedUser(db, state.organizationId);
    const old = new Date(Date.now() - 60 * DAY_MS);
    const ownerless = await usage(null, { occurredAt: old, usageUnknown: true });
    const stranded = await usage(null, {
      occurredAt: old,
      pending: true,
      usageUnknown: true,
      costMicros: 0,
      reservedCostMicros: 100,
    });
    const ownedUnknown = await usage(owner, { occurredAt: old, usageUnknown: true });
    const recentOwnerless = await usage(null);

    // No owner to settle for: the sweep leaves an ownerless reservation alone,
    // and settlement changes nothing.
    expect(await sweepAbandonedReservations(new Date(Date.now() + RESERVATION_TTL_MS))).toBe(0);
    await db.transaction(async (tx) => {
      await settleLockedEvent(tx, stranded, { tokensIn: 5, tokensOut: 5 });
    });
    expect(await eventsOf([stranded.id])).toEqual([stranded]);

    expect(await pruneUsageEvents()).toBe(2);
    const left = await eventsOf([ownerless.id, stranded.id, ownedUnknown.id, recentOwnerless.id]);
    expect(left.map((row) => row.id).sort()).toEqual([ownedUnknown.id, recentOwnerless.id].sort());
  });
});

describe.skipIf(!available)('live migration 0038: usage kept after deletion', () => {
  let live: LiveDatabase;
  afterAll(async () => {
    await live?.destroy();
  });

  const tables = ['usage_event', 'usage_record', 'quota_denial'] as const;

  async function userKeys(db: Database) {
    return db.execute<{
      table: string;
      name: string;
      on_delete: string;
      validated: boolean;
      nullable: string;
    }>(sql`
      select c.conrelid::regclass::text as table, c.conname as name,
             c.confdeltype::text as on_delete, c.convalidated as validated,
             col.is_nullable as nullable
      from pg_constraint c
      join information_schema.columns col
        on col.table_name = c.conrelid::regclass::text and col.column_name = 'user_id'
      where c.contype = 'f' and c.confrelid = '"user"'::regclass
        and c.conrelid::regclass::text in ('usage_event', 'usage_record', 'quota_denial')
      order by 1, 2`);
  }

  it('keeps existing rows, replaces the cascade with SET NULL, and can run again', async () => {
    live = await createLiveDatabase('usage_kept_migration');
    const { db } = live;
    const organizationId = await seedOrganization(db);
    const person = await seedUser(db, organizationId);

    // Back to the shape before 0038.
    for (const table of tables) {
      await db.execute(
        sql.raw(`alter table "${table}" drop constraint "${table}_user_id_set_null_fk"`),
      );
      await db.execute(sql.raw(`alter table "${table}" alter column "user_id" set not null`));
      await db.execute(
        sql.raw(`alter table "${table}" add constraint "${table}_user_id_user_id_fk"
          foreign key ("user_id") references "public"."user"("id") on delete cascade`),
      );
    }
    expect((await userKeys(db)).map((key) => [key.name, key.on_delete, key.nullable])).toEqual([
      ['quota_denial_user_id_user_id_fk', 'c', 'NO'],
      ['usage_event_user_id_user_id_fk', 'c', 'NO'],
      ['usage_record_user_id_user_id_fk', 'c', 'NO'],
    ]);
    await db.execute(sql`
      insert into usage_event (organization_id, user_id, model_slug, cost_micros)
      values (${organizationId}, ${person}, 'before-0038', 7)`);
    await db.execute(sql`
      insert into usage_record (organization_id, user_id, model_slug, day, cost_micros)
      values (${organizationId}, ${person}, 'before-0038', '2026-01-01', 7)`);
    await db.execute(sql`
      insert into quota_denial (organization_id, user_id, policy_name, model_slug, day, denial_count)
      values (${organizationId}, ${person}, 'Limit', 'before-0038', '2026-01-01', 1)`);

    const journal = JSON.parse(
      readFileSync(
        new URL('../../../../../packages/db/drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: Array<{ tag: string; when: number }> };
    const entry = journal.entries.find(
      (candidate) => candidate.tag === '0038_usage_kept_after_deletion',
    );
    if (!entry) throw new Error('Migration 0038 is missing from the journal');
    const reapply = async () => {
      await db.execute(sql`delete from drizzle.__drizzle_migrations
        where created_at >= ${entry.when}::bigint`);
      await runMigrations(db);
    };

    await reapply();
    const expected = [
      // Never validated on purpose (no table scan); still enforced and acted on.
      ['quota_denial_user_id_set_null_fk', 'n', false, 'YES'],
      ['usage_event_user_id_set_null_fk', 'n', false, 'YES'],
      ['usage_record_user_id_set_null_fk', 'n', false, 'YES'],
    ];
    const keys = async () =>
      (await userKeys(db)).map((key) => [key.name, key.on_delete, key.validated, key.nullable]);
    expect(await keys()).toEqual(expected);
    // Applying it again changes nothing.
    await reapply();
    expect(await keys()).toEqual(expected);

    // The rows written before survive the migration, and the deletion.
    const owners = async () =>
      db.execute<{ table: string; user_id: string | null }>(sql`
        select 'usage_event' as table, user_id from usage_event where model_slug = 'before-0038'
        union all select 'usage_record', user_id from usage_record where model_slug = 'before-0038'
        union all select 'quota_denial', user_id from quota_denial where model_slug = 'before-0038'
        order by 1`);
    expect(await owners()).toEqual([
      { table: 'quota_denial', user_id: person },
      { table: 'usage_event', user_id: person },
      { table: 'usage_record', user_id: person },
    ]);
    await db.execute(sql`delete from "user" where id = ${person}`);
    expect(await owners()).toEqual([
      { table: 'quota_denial', user_id: null },
      { table: 'usage_event', user_id: null },
      { table: 'usage_record', user_id: null },
    ]);
    // The key still refuses a person who never existed.
    await expect(
      db.execute(sql`
        insert into usage_event (organization_id, user_id, model_slug)
        values (${organizationId}, 'no-such-person', 'before-0038')`),
    ).rejects.toThrow();
  });
});
