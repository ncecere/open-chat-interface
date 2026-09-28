import { runMigrations, runMigrationsWithLock, sql } from '@oci/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const MIGRATION_LOCK_KEY = '8374920115573001';
const INJECTED_FAILURE = 'migration ownership fixture: injected DDL failure';

type Observation = {
  migration_pid: number;
  owner_pids: number[];
  object_identity: string;
};

describe.skipIf(!available)('live PostgreSQL migration session ownership', () => {
  let live: LiveDatabase | undefined;
  let databaseName: string;
  let fixturePid: number;

  beforeEach(async () => {
    // The shared helper initially migrates. Reset ONLY this randomly created
    // database so the subject executes real migration DDL, not a no-op replay.
    live = await createLiveDatabase('migration_ownership');
    databaseName = new URL(live.connectionString).pathname.slice(1);
    await live.db.execute(sql`drop schema public cascade`);
    await live.db.execute(sql`drop schema drizzle cascade`);
    await live.db.execute(sql`create schema public`);
    const [backend] = await live.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    fixturePid = backend!.pid;

    // Test-only instrumentation lives outside the application's schemas. Event
    // triggers require a superuser on the disposable live-test Postgres server;
    // setup errors must fail the fixture, not masquerade as production failures.
    await live.db.execute(sql`create schema migration_probe`);
    await live.db.execute(sql`
      create table migration_probe.observations (
        migration_pid integer not null,
        owner_pids integer[] not null,
        object_identity text not null
      )
    `);
    await live.db.execute(sql`create table migration_probe.settings (fail_ddl boolean not null)`);
    await live.db.execute(sql`insert into migration_probe.settings values (false)`);
    await live.db.execute(
      sql.raw(`
      create function migration_probe.observe_ddl() returns event_trigger
      language plpgsql as $$
      declare
        command record;
        owners integer[];
      begin
        for command in select * from pg_event_trigger_ddl_commands() loop
          if command.schema_name = 'public' and command.command_tag = 'CREATE TABLE' then
            -- bigint advisory keys use the upper/lower 32 bits and objsubid=1.
            -- pg_locks is cluster-wide: restrict it to this exact database too.
            select coalesce(array_agg(pid order by pid), array[]::integer[]) into owners
            from pg_catalog.pg_locks
            where locktype = 'advisory' and granted and mode = 'ExclusiveLock'
              and database = (select oid from pg_database where datname = current_database())
              and classid::bigint = (${MIGRATION_LOCK_KEY}::bigint >> 32)
              and objid::bigint = (${MIGRATION_LOCK_KEY}::bigint & 4294967295::bigint)
              and objsubid = 1;

            if (select fail_ddl from migration_probe.settings) then
              raise exception using
                errcode = 'P0001',
                message = '${INJECTED_FAILURE}',
                detail = json_build_object(
                  'migration_pid', pg_backend_pid(),
                  'owner_pids', owners,
                  'object_identity', command.object_identity
                )::text;
            end if;
            insert into migration_probe.observations values (
              pg_backend_pid(), owners, command.object_identity
            );
          end if;
        end loop;
      end $$
    `),
    );
    await live.db.execute(sql`
      create event trigger migration_probe_ddl on ddl_command_end
      when tag in ('CREATE TABLE') execute function migration_probe.observe_ddl()
    `);
    expect(await sessions()).toEqual([
      { pid: fixturePid, state: 'active', query: expect.any(String) },
    ]);
  });

  afterEach(async () => {
    // Exact-name DROP DATABASE WITH (FORCE) in destroy also terminates the
    // subject's leaked clients. Never enumerate or drop databases by prefix.
    const owned = live;
    live = undefined;
    await owned?.destroy();
  });

  async function sessions() {
    const rows = await live!.db.execute<{ pid: number; state: string; query: string }>(sql`
      select pid, state, left(query, 160) as query
      from pg_stat_activity
      where datname = ${databaseName} and backend_type = 'client backend'
      order by pid
    `);
    return Array.from(rows);
  }

  async function observations() {
    const rows = await live!.db.execute<Observation>(sql`
      select migration_pid, owner_pids, object_identity
      from migration_probe.observations order by object_identity
    `);
    // A vacuous success (already migrated DB or inactive trigger) is not valid.
    expect(rows.length, 'fixture must observe real public-schema migration DDL').toBeGreaterThan(0);
    return rows;
  }

  async function expectNoExtraSessions() {
    // Allow the server to observe completed socket shutdown, but never close a
    // subject connection ourselves before asserting the resource contract.
    await expect
      .poll(async () => (await sessions()).filter((row) => row.pid !== fixturePid), {
        timeout: 1_000,
        interval: 50,
        message: `migration clients must close before return (${databaseName})`,
      })
      .toEqual([]);
  }

  async function injectedFailure(operation: () => Promise<unknown>): Promise<Observation> {
    let caught: unknown;
    try {
      await operation();
    } catch (error) {
      caught = error;
    }
    // Drizzle wraps the Postgres error. Require our exact server-side sentinel,
    // not merely any rejection (syntax/permissions/setup failures are invalid).
    while (caught instanceof Error && caught.cause) caught = caught.cause;
    expect(caught).toMatchObject({ code: 'P0001', message: INJECTED_FAILURE });
    const evidence = JSON.parse((caught as { detail: string }).detail) as Observation;
    expect(evidence.object_identity).toMatch(/^public\./);
    expect(evidence.migration_pid).toBeGreaterThan(0);
    return evidence;
  }

  it('fixture control: records the known owner when real migrations use its session', async () => {
    await live!.db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`);
    try {
      await runMigrations(live!.db);
      for (const row of await observations()) {
        expect(row).toMatchObject({ migration_pid: fixturePid, owner_pids: [fixturePid] });
      }
    } finally {
      await live!.db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`);
    }
    await expectNoExtraSessions();
  });

  it('fixture control: injects the exact migration DDL failure and rolls back', async () => {
    await live!.db.execute(sql`update migration_probe.settings set fail_ddl = true`);
    await live!.db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`);
    try {
      const evidence = await injectedFailure(() => runMigrations(live!.db));
      expect(evidence).toMatchObject({ migration_pid: fixturePid, owner_pids: [fixturePid] });
      const [table] = await live!.db.execute<{ name: string | null }>(
        sql`select to_regclass(${evidence.object_identity})::text as name`,
      );
      expect(table?.name).toBeNull();
    } finally {
      await live!.db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`);
    }
    await expectNoExtraSessions();
  });

  it('closes its client after timing out behind another session owner', async () => {
    await live!.db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`);
    try {
      await expect(runMigrationsWithLock(live!.connectionString, { timeoutMs: 0 })).rejects.toThrow(
        'waiting for the migration lock',
      );
      await expectNoExtraSessions();
    } finally {
      await live!.db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`);
    }
  });

  it('serializes real pending migration DDL across three replicas and closes all clients', async () => {
    const results = await Promise.all([
      runMigrationsWithLock(live!.connectionString),
      runMigrationsWithLock(live!.connectionString),
      runMigrationsWithLock(live!.connectionString),
    ]);
    expect(results).toEqual([{ applied: true }, { applied: true }, { applied: true }]);
    const rows = await observations();
    expect(new Set(rows.map((row) => row.migration_pid)).size).toBe(1);
    for (const row of rows) expect(row.owner_pids).toEqual([row.migration_pid]);
    await expectNoExtraSessions();
  });

  it('closes each client when an already-current database is migrated again', async () => {
    expect(await runMigrationsWithLock(live!.connectionString)).toEqual({ applied: true });
    await observations();
    await expectNoExtraSessions();
    expect(await runMigrationsWithLock(live!.connectionString)).toEqual({ applied: true });
    await expectNoExtraSessions();
  });

  it('executes migration DDL on the backend holding the migration advisory lock', async () => {
    expect(await runMigrationsWithLock(live!.connectionString)).toEqual({ applied: true });
    for (const row of await observations()) {
      expect(row.owner_pids, JSON.stringify(row)).toEqual([row.migration_pid]);
    }
  });

  it('leaves no extra sessions after successful migrations', async () => {
    expect(await runMigrationsWithLock(live!.connectionString)).toEqual({ applied: true });
    await observations();
    await expectNoExtraSessions();
  });

  it('leaves no extra sessions after a migration statement fails', async () => {
    await live!.db.execute(sql`update migration_probe.settings set fail_ddl = true`);
    const evidence = await injectedFailure(() => runMigrationsWithLock(live!.connectionString));
    // Failure occurred during DDL with a real advisory owner, not during setup.
    expect(evidence.owner_pids).toHaveLength(1);
    await expectNoExtraSessions();
  });
});
