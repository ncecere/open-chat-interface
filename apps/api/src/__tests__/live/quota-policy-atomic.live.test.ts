import { createDatabase, type Database, eq, schema, sql } from '@oci/db';
import type { UpsertQuotaPolicyInput } from '@oci/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedUser,
} from '../../../test/live-postgres.js';
import { policyCoversModel } from '../../services/quota/policy.js';
import {
  createQuotaPolicy,
  deleteQuotaPolicy,
  updateQuotaPolicy,
} from '../../services/quota/policy-admin.js';
import { loadPolicies } from '../../services/quota/policy-queries.js';

// Only redirect the database connection: service, assignments, reads, and audit
// all run their actual production code against the migrated throwaway database.
const connection = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock('../../db/index.js', () => ({
  get db() {
    if (!connection.db) throw new Error('Live database has not been initialized');
    return connection.db;
  },
}));

const available = await livePostgresAvailable();
const original: UpsertQuotaPolicyInput = {
  name: 'Original',
  description: 'Existing policy',
  metric: 'messages',
  limitValue: 100,
  windowKind: 'daily',
  timezone: 'UTC',
  enabled: true,
  roles: ['user'],
  modelSlugs: ['model-a'],
};
const replacement: UpsertQuotaPolicyInput = {
  name: 'Replacement',
  description: 'Changed policy',
  metric: 'tokens',
  limitValue: 777,
  windowKind: 'rolling',
  windowHours: 12,
  timezone: 'America/New_York',
  enabled: false,
  roles: ['restricted'],
  modelSlugs: ['model-b'],
};

describe.skipIf(!available)('live Postgres: atomic quota policy administration', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let db: Database;
  let organizationId: string;
  let actor: { id: string; email: string };
  let policyId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('quota_policy_atomic');
    // More than one connection makes concurrent service calls and audit writes
    // genuinely independent, rather than serialized by the test helper's pool.
    pool = createDatabase(live.connectionString, { max: 4 });
    db = pool.db;
    connection.db = db;
    const [organization] = await db
      .insert(schema.organization)
      .values({ name: 'Default', slug: 'default' })
      .returning();
    organizationId = organization!.id;
    const email = 'admin@example.com';
    actor = { id: await seedUser(db, organizationId, { email, role: 'admin' }), email };
    const [provider] = await db
      .insert(schema.provider)
      .values({ organizationId, kind: 'openai', label: 'Test' })
      .returning();
    await db.insert(schema.model).values(
      ['model-a', 'model-b'].map((slug) => ({
        organizationId,
        providerId: provider!.id,
        slug,
        upstreamModelId: slug,
        displayName: slug,
      })),
    );
  });

  beforeEach(async () => {
    await db.delete(schema.quotaPolicy);
    await db.delete(schema.auditLog);
    policyId = (await createQuotaPolicy(actor, original)).id;
  });

  afterEach(async () => {
    await db.execute(sql`drop trigger if exists reject_scope on quota_policy_model`);
    await db.execute(sql`drop function if exists reject_scope_assignment()`);
    await db.execute(sql`drop trigger if exists delay_policy on quota_policy`);
    await db.execute(sql`drop function if exists delay_policy_write()`);
  });

  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    connection.db = null;
    await live?.destroy();
  });

  async function snapshot() {
    return {
      policies: await db.select().from(schema.quotaPolicy).orderBy(schema.quotaPolicy.id),
      roles: await db.select().from(schema.quotaPolicyRole).orderBy(schema.quotaPolicyRole.id),
      models: await db.select().from(schema.quotaPolicyModel).orderBy(schema.quotaPolicyModel.id),
      audit: await db.select().from(schema.auditLog).orderBy(schema.auditLog.id),
    };
  }

  for (const operation of ['create', 'update'] as const) {
    const save = (input: UpsertQuotaPolicyInput) =>
      operation === 'create'
        ? createQuotaPolicy(actor, input)
        : updateQuotaPolicy(actor, policyId, input);

    it(`${operation}: rejects unknown model slugs without changing any rows or emitting success audit`, async () => {
      const before = await snapshot();
      await expect(
        save({ ...replacement, modelSlugs: ['model-b', 'unknown', 'unknown'] }),
      ).rejects.toMatchObject({
        status: 422,
        message: 'Unknown models in the policy scope.',
        details: [{ path: ['modelSlugs'], message: 'Not in the catalog: unknown' }],
      });
      expect(await snapshot()).toEqual(before);
    });

    it(`${operation}: rejects an invalid timezone without changing policy or assignments`, async () => {
      const before = await snapshot();
      await expect(save({ ...replacement, timezone: 'Not/A_Timezone' })).rejects.toMatchObject({
        status: 422,
        message: 'Unknown timezone.',
      });
      expect(await snapshot()).toEqual(before);
    });

    for (const deferred of [false, true]) {
      it(`${operation}: rolls back row and role changes on ${deferred ? 'commit-time' : 'immediate'} model assignment failure`, async () => {
        const before = await snapshot();
        // Check the real preceding writes are visible in the transaction, then
        // fail the model insert. Deferred mode also proves audit waits for COMMIT.
        await db.execute(sql`
          create function reject_scope_assignment() returns trigger language plpgsql as $$
          begin
            if new.model_slug = 'model-b' then
              if not exists (
                select 1 from quota_policy p
                join quota_policy_role r on r.policy_id = p.id
                where p.id = new.policy_id and p.limit_value = 777 and r.role = 'restricted'
              ) then
                raise exception 'Expected policy and roles to have been written first';
              end if;
              raise exception 'Injected assignment failure' using errcode = 'P0001';
            end if;
            return new;
          end $$
        `);
        await db.execute(
          deferred
            ? sql`create constraint trigger reject_scope after insert on quota_policy_model
                  deferrable initially deferred for each row execute function reject_scope_assignment()`
            : sql`create trigger reject_scope before insert on quota_policy_model
                  for each row execute function reject_scope_assignment()`,
        );
        const failure = await save(replacement).catch((error: unknown) => error);
        // Drizzle wraps statement errors, while COMMIT can reject directly.
        const root = failure instanceof Error && failure.cause ? failure.cause : failure;
        expect(root).toMatchObject({ message: 'Injected assignment failure', code: 'P0001' });
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  it('preserves not-found and name-conflict domain errors and existing state', async () => {
    const other = await createQuotaPolicy(actor, { ...original, name: 'Taken' });
    const before = await snapshot();
    await expect(createQuotaPolicy(actor, original)).rejects.toMatchObject({ status: 409 });
    await expect(
      updateQuotaPolicy(actor, policyId, { ...replacement, name: 'Taken' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(updateQuotaPolicy(actor, 'missing', replacement)).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteQuotaPolicy(actor, 'missing')).rejects.toMatchObject({ status: 404 });
    expect(other.id).not.toBe(policyId);
    expect(await snapshot()).toEqual(before);
  });

  it('creates and replaces complete deduplicated scopes, supports all-model scope, and deletes cleanly', async () => {
    const created = await createQuotaPolicy(actor, {
      ...replacement,
      roles: ['restricted', 'restricted', 'admin'],
      modelSlugs: ['model-b', 'model-b', 'model-a'],
    });
    let [policy] = await loadPolicies(organizationId, [created.id]);
    expect(policy).toMatchObject({
      ...replacement,
      roles: ['restricted', 'admin'],
      modelSlugs: ['model-a', 'model-b'],
    });
    expect(policy!.roles.sort()).toEqual(['admin', 'restricted']);
    expect(policyCoversModel(policy!, 'outside-scope')).toBe(false);

    expect(
      await updateQuotaPolicy(actor, created.id, {
        ...original,
        name: 'Updated',
        roles: ['user', 'user'],
        modelSlugs: ['model-a', 'model-a'],
        windowHours: 99,
      }),
    ).toEqual(created);
    [policy] = await loadPolicies(organizationId, [created.id]);
    expect(policy).toMatchObject({
      ...original,
      name: 'Updated',
      windowHours: null,
      roles: ['user'],
      modelSlugs: ['model-a'],
    });
    expect(policyCoversModel(policy!, 'model-a')).toBe(true);
    expect(policyCoversModel(policy!, 'model-b')).toBe(false);

    await updateQuotaPolicy(actor, created.id, {
      ...original,
      name: 'All models',
      roles: [],
      modelSlugs: [],
    });
    [policy] = await loadPolicies(organizationId, [created.id]);
    expect(policy).toMatchObject({ roles: [], modelSlugs: [] });
    expect(policyCoversModel(policy!, 'any-new-model')).toBe(true);

    // Populate both sets again to verify the service delete cascades them.
    await updateQuotaPolicy(actor, created.id, replacement);
    expect(await deleteQuotaPolicy(actor, created.id)).toEqual({ ok: true });
    expect(await loadPolicies(organizationId, [created.id])).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.quotaPolicyRole)
        .where(eq(schema.quotaPolicyRole.policyId, created.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.quotaPolicyModel)
        .where(eq(schema.quotaPolicyModel.policyId, created.id)),
    ).toEqual([]);
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, created.id));
    expect(audits.map((row) => row.action).sort()).toEqual([
      'quota.policy.create',
      'quota.policy.delete',
      'quota.policy.update',
      'quota.policy.update',
      'quota.policy.update',
    ]);
  });

  it('records what a deleted policy was, including its roles, models and overrides (#148)', async () => {
    await db.insert(schema.quotaPolicyOverride).values({
      policyId,
      userId: actor.id,
      limitValue: 500,
    });
    await deleteQuotaPolicy(actor, policyId);
    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'quota.policy.delete'));
    expect(entry?.metadata).toEqual({
      name: 'Original',
      description: 'Existing policy',
      metric: 'messages',
      limitValue: 100,
      windowKind: 'daily',
      windowHours: null,
      timezone: 'UTC',
      enabled: true,
      roles: ['user'],
      modelSlugs: ['model-a'],
      overrideCount: 1,
    });
  });

  async function delayPolicyWrites() {
    // Hold each mutation long enough for the other request's name precheck to
    // finish. This exercises the unique-index error rather than only the precheck.
    await db.execute(sql`
      create function delay_policy_write() returns trigger language plpgsql as $$
      begin perform pg_sleep(0.15); return new; end $$
    `);
    await db.execute(sql`create trigger delay_policy before insert or update on quota_policy
      for each row execute function delay_policy_write()`);
  }

  it('maps concurrent create name collisions to conflict and leaves only one complete policy', async () => {
    await delayPolicyWrites();
    const results = await Promise.allSettled([
      createQuotaPolicy(actor, replacement),
      createQuotaPolicy(actor, replacement),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, message: 'A policy with that name already exists' },
    });
    const policies = await loadPolicies(organizationId);
    expect(policies).toHaveLength(2);
    expect(policies.find((policy) => policy.name === replacement.name)).toMatchObject(replacement);
    expect((await snapshot()).audit).toHaveLength(2);
  });

  it('maps concurrent update name collisions to conflict and rolls back the losing edit', async () => {
    const second = await createQuotaPolicy(actor, { ...original, name: 'Second' });
    const before = await snapshot();
    await delayPolicyWrites();
    const ids = [policyId, second.id];
    const results = await Promise.allSettled(
      ids.map((id) => updateQuotaPolicy(actor, id, replacement)),
    );
    const loser = results.findIndex((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results[loser]).toMatchObject({ reason: { status: 409 } });
    const after = await snapshot();
    for (const table of ['policies', 'roles', 'models'] as const) {
      const forLoser = (row: { id: string; policyId?: string }) =>
        (row.policyId ?? row.id) === ids[loser];
      expect(after[table].filter(forLoser)).toEqual(before[table].filter(forLoser));
    }
    expect(after.audit).toHaveLength(before.audit.length + 1);
  });

  it('serializes concurrent edits so the resulting row and assignments belong to one complete update', async () => {
    await delayPolicyWrites();
    const alternatives = [
      replacement,
      {
        ...original,
        name: 'Alternative',
        roles: ['admin'] as UpsertQuotaPolicyInput['roles'],
        modelSlugs: ['model-a', 'model-b'],
      },
    ];
    await Promise.all(alternatives.map((input) => updateQuotaPolicy(actor, policyId, input)));
    const [policy] = await loadPolicies(organizationId, [policyId]);
    const winner = alternatives.find((input) => input.name === policy!.name);
    expect(winner).toBeDefined();
    expect(policy).toMatchObject(winner!);
    expect((await snapshot()).audit).toHaveLength(3);
  });
});
