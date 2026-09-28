import { sql } from '@oci/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createDatabase } from '../../../../../packages/db/dist/client.js';
import { runMigrationsWithLock } from '../../../../../packages/db/dist/migrator.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

type Client = ReturnType<typeof createDatabase>['sql'];
type TransactionClient = Parameters<Parameters<Client['begin']>[1]>[0];
const interception = vi.hoisted(() => ({
  url: '',
  afterLock: null as null | ((client: Client) => Promise<void>),
}));

// Target the built client's own module, not @oci/db's reexports. The production
// migrator imports this exact file. All query execution and results stay real;
// only delivery of a successful advisory-lock result is delayed for the race.
vi.mock('../../../../../packages/db/dist/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../packages/db/dist/client.js')>();
  return {
    ...actual,
    createDatabase: (...args: Parameters<typeof createDatabase>) => {
      const created = actual.createDatabase(...args);
      if (args[0] !== interception.url) return created;
      function intercept<T extends Client | TransactionClient>(source: T): T {
        return new Proxy(source, {
          apply(target, thisArg, args) {
            const query = Reflect.apply(target, thisArg, args);
            const strings = args[0] as TemplateStringsArray;
            if (!/pg_try_advisory_(?:xact_)?lock/.test(strings?.join?.('') ?? '')) return query;
            return query.then(async (rows: Array<{ locked: boolean }>) => {
              if (rows[0]?.locked && interception.afterLock) {
                const inject = interception.afterLock;
                interception.afterLock = null;
                await inject(created.sql);
              }
              return rows;
            });
          },
          get(target, property) {
            const method = Reflect.get(target, property, target);
            if (property !== 'begin' || typeof method !== 'function') return method;
            // Preserve real BEGIN/savepoint semantics while intercepting the
            // lock query whether it uses a pool or a pinned transaction scope.
            return (...args: unknown[]) => {
              const callback = args.at(-1) as (scope: TransactionClient) => unknown;
              return Reflect.apply(method, target, [
                ...args.slice(0, -1),
                (scope: TransactionClient) => callback(intercept(scope)),
              ]);
            };
          },
        });
      }
      return { ...created, sql: intercept(created.sql) };
    },
  };
});

const LOCK_KEY = '8374920115573001';
const available = await livePostgresAvailable();
type Observation = { migration_pid: number; owner_pids: number[]; isolation: string };

describe.skipIf(!available)('live migration ownership after idle backend disconnection', () => {
  let live: LiveDatabase | undefined;

  beforeEach(async () => {
    live = await createLiveDatabase('migration_reconnect');
    // Only the exact randomly owned database is reset. The probe schema survives
    // application DDL, and the subject must execute genuinely pending migrations.
    await live.db.execute(sql`drop schema public cascade`);
    await live.db.execute(sql`drop schema drizzle cascade`);
    await live.db.execute(sql`create schema public`);
    await live.db.execute(sql`create schema reconnect_probe`);
    await live.db.execute(sql`create table reconnect_probe.observations (
      migration_pid integer not null, owner_pids integer[] not null, isolation text not null
    )`);
    await live.db.execute(
      sql.raw(`
      create function reconnect_probe.observe_ddl() returns event_trigger
      language plpgsql as $$
      declare command record; owners integer[];
      begin
        for command in select * from pg_event_trigger_ddl_commands() loop
          if command.schema_name = 'public' and command.command_tag = 'CREATE TABLE' then
            select coalesce(array_agg(pid order by pid), array[]::integer[]) into owners
            from pg_locks where locktype = 'advisory' and granted
              and mode = 'ExclusiveLock'
              and database = (select oid from pg_database where datname = current_database())
              and classid::bigint = (${LOCK_KEY}::bigint >> 32)
              and objid::bigint = (${LOCK_KEY}::bigint & 4294967295::bigint)
              and objsubid = 1;
            insert into reconnect_probe.observations
            values (pg_backend_pid(), owners, current_setting('transaction_isolation'));
          end if;
        end loop;
      end $$
    `),
    );
    await live.db.execute(sql`create event trigger reconnect_probe_ddl on ddl_command_end
      when tag in ('CREATE TABLE') execute function reconnect_probe.observe_ddl()`);
    // Unlike observation rows, nextval survives transaction rollback. Count DDL
    // starts too, so an attempted-but-rolled-back migration cannot look absent.
    await live.db.execute(sql`create sequence reconnect_probe.ddl_attempts`);
    await live.db.execute(
      sql.raw(`
      create function reconnect_probe.count_ddl() returns event_trigger
      language plpgsql as $$ begin
        perform nextval('reconnect_probe.ddl_attempts');
      end $$
    `),
    );
    await live.db.execute(sql`create event trigger reconnect_probe_start on ddl_command_start
      execute function reconnect_probe.count_ddl()`);
    interception.url = live.connectionString;
  });

  afterEach(async () => {
    interception.afterLock = null;
    interception.url = '';
    const owned = live;
    live = undefined;
    // destroy closes the fixture client and drops ONLY its exact database with
    // FORCE, also cleaning any subject session should an assertion fail.
    await owned?.destroy();
  });

  async function observations() {
    return Array.from(
      await live!.db.execute<Observation>(sql`
      select migration_pid, owner_pids, isolation from reconnect_probe.observations
    `),
    );
  }

  async function ddlAttemptCount() {
    const [row] = await live!.db.execute<{ last_value: string; is_called: boolean }>(sql`
      select last_value, is_called from reconnect_probe.ddl_attempts
    `);
    return row?.is_called ? Number(row.last_value) : 0;
  }

  it('control: nontransactional DDL-start evidence survives a rollback', async () => {
    expect(await ddlAttemptCount()).toBe(0);
    await expect(
      live!.db.transaction(async (tx) => {
        await tx.execute(sql`create table public.reconnect_rollback_control (id integer)`);
        throw new Error('Injected observation rollback');
      }),
    ).rejects.toThrow('Injected observation rollback');
    expect(await observations()).toEqual([]);
    expect(await ddlAttemptCount()).toBe(1);
    const [row] = await live!.db.execute(sql`
      select to_regclass('public.reconnect_rollback_control') as relation
    `);
    expect(row?.relation).toBeNull();
  });

  it('control: real pending DDL runs on the advisory-lock owner', async () => {
    expect(await runMigrationsWithLock(live!.connectionString)).toEqual({ applied: true });
    const rows = await observations();
    expect(rows.length).toBeGreaterThan(0);
    expect(await ddlAttemptCount()).toBeGreaterThan(0);
    for (const row of rows) expect(row.owner_pids).toEqual([row.migration_pid]);
  });

  it('uses fresh journal snapshots even with a repeatable-read server default', async () => {
    const name = new URL(live!.connectionString).pathname.slice(1);
    await live!.db.execute(sql`alter database ${sql.identifier(name)}
      set default_transaction_isolation = 'repeatable read'`);
    expect(await runMigrationsWithLock(live!.connectionString)).toEqual({ applied: true });
    const rows = await observations();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.owner_pids).toEqual([row.migration_pid]);
      expect(row.isolation).toBe('read committed');
    }
  });

  it('fails before DDL when its idle lock-owning backend disconnects', async () => {
    let killedPid: number | undefined;
    let injectionFinished = false;
    let injectionError: unknown;
    interception.afterLock = async (client) => {
      try {
        // Observe the actual lock owner through the independent fixture session.
        const owners = await live!.db.execute<{ pid: number; state: string }>(sql`
          select a.pid, a.state from pg_stat_activity a join pg_locks l on l.pid = a.pid
          where a.datname = current_database() and l.locktype = 'advisory' and l.granted
            and l.classid::bigint = (${LOCK_KEY}::bigint >> 32)
            and l.objid::bigint = (${LOCK_KEY}::bigint & 4294967295::bigint)
            and l.objsubid = 1
        `);
        expect(owners).toHaveLength(1);
        expect(['idle', 'idle in transaction']).toContain(owners[0]!.state);
        killedPid = owners[0]!.pid;
        const previousClose = client.options.onclose;
        let closed = false;
        client.options.onclose = (id) => {
          closed = true;
          previousClose?.(id);
        };
        try {
          const killed = await live!.db.execute<{ killed: boolean }>(sql`
            select pg_terminate_backend(pid) as killed from pg_stat_activity
            where pid = ${killedPid} and datname = current_database()
              and state in ('idle', 'idle in transaction')
          `);
          expect(Array.from(killed)).toEqual([{ killed: true }]);
          // Wait for the real driver's close notification, not a guessed sleep.
          await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000, interval: 10 });
          injectionFinished = true;
        } finally {
          client.options.onclose = previousClose;
        }
      } catch (error) {
        injectionError = error;
        throw error;
      }
    };

    const result = await runMigrationsWithLock(live!.connectionString).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    // A failed hook or a non-intercepted import is a fixture failure, never
    // evidence of correct migration failure semantics.
    // A pinned transaction rejects on close before the delayed query callback
    // necessarily finishes its observation. Wait for the injection, not a sleep.
    await vi.waitFor(() => expect(injectionFinished || injectionError).toBeTruthy(), {
      timeout: 3000,
      interval: 10,
    });
    expect(injectionError).toBeUndefined();
    expect(injectionFinished).toBe(true);
    const rows = await observations();
    const violations = rows.filter(
      (row) => row.owner_pids.length !== 1 || row.owner_pids[0] !== row.migration_pid,
    );
    const evidence = {
      killedPid,
      outcome: result.status,
      ddlCount: rows.length,
      ddlAttempts: await ddlAttemptCount(),
      ddlPids: [...new Set(rows.map((row) => row.migration_pid))],
      unownedDdlCount: violations.length,
    };
    console.info('migration reconnect evidence', JSON.stringify(evidence));
    expect(result.status, JSON.stringify(evidence)).toBe('rejected');
    expect(rows).toHaveLength(0);
    expect(evidence.ddlAttempts).toBe(0);
    if (result.status === 'rejected') {
      // Only a genuine connection failure is acceptable. A syntax/setup/DDL
      // failure cannot pass this test.
      let error = result.error;
      while (error instanceof Error && error.cause) error = error.cause;
      expect(error).toHaveProperty('code');
      expect(['CONNECTION_CLOSED', 'CONNECTION_DESTROYED', '57P01', 'ECONNRESET']).toContain(
        (error as { code: string }).code,
      );
    }
    expect(violations.length, JSON.stringify(evidence)).toBe(0);
  }, 15_000);
});
