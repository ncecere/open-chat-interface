import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { backgroundMigrations } from './background/index.js';
import type { BackgroundMigrationDefinition } from './background/types.js';
import {
  DEFAULT_MIGRATION_MAX_ATTEMPTS,
  DEFAULT_MIGRATION_MAX_RETRY_DELAY_MS,
  DEFAULT_MIGRATION_RETRY_DELAY_MS,
  isLockTimeout,
  migrationRetryDelay,
  postgresErrorCode,
  postMigrationTimeoutsFromEnv,
} from './migration-safety.js';
import {
  DEFAULT_MIGRATIONS_FOLDER,
  DEFAULT_POST_FOLDER,
  migrationHistory,
  type Queryable,
  readJournal,
} from './release-manifest.js';
import {
  type IndexBuild,
  indexBuild,
  loadSqlParser,
  type ParsedStatement,
  parseStatements,
} from './sql-analysis.js';

/**
 * Post-deploy steps (v0.11 design, section 1): `migrate --post`, run after
 * every replica runs the release. Each step is one statement in
 * `packages/db/post/NNNN_name.sql`, listed in `post/journal.json`, and runs
 * outside a transaction so it can build an index CONCURRENTLY, validate a
 * constraint, or drop what the release no longer reads, while OCI serves.
 *
 * Progress is kept in `oci_post_migration`: a step is marked started before
 * it runs and finished after, so an interrupted run (a killed job, a lost
 * connection, a failover) repeats exactly the steps that did not finish.
 * Steps are idempotent (`IF NOT EXISTS`, `IF EXISTS`), with one exception
 * PostgreSQL leaves to the caller: an interrupted `CREATE INDEX CONCURRENTLY`
 * leaves an INVALID index behind, which `IF NOT EXISTS` would then silently
 * accept. Before a step builds an index, an INVALID index of that name is
 * dropped (concurrently) so the build starts again.
 */

/** Session advisory lock: one `migrate --post` at a time. Distinct from the pre-deploy key. */
const POST_MIGRATION_LOCK_KEY = '8374920115573002';

export interface PostStep {
  idx: number;
  /** File name without `.sql`. */
  name: string;
  release: string;
  sql: string;
  /** SHA-256 of the file. */
  checksum: string;
  statement: ParsedStatement;
  /** The index the step builds, if it builds one. */
  index: IndexBuild | null;
}

interface PostJournal {
  steps: Array<{ idx: number; tag: string; release: string }>;
}

/**
 * The post-deploy steps of a folder in journal order. Throws if a listed file
 * is missing or holds anything but exactly one statement. Call
 * `loadSqlParser()` first.
 */
export function readPostSteps(folder: string = DEFAULT_POST_FOLDER): PostStep[] {
  const journalPath = join(folder, 'journal.json');
  if (!existsSync(journalPath)) return [];
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as PostJournal;
  const listed = new Set(journal.steps.map((step) => `${step.tag}.sql`));
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.sql'))) {
    if (!listed.has(file)) throw new Error(`Post-deploy step ${file} is not in journal.json.`);
  }
  return journal.steps.map((entry, position) => {
    if (entry.idx !== position)
      throw new Error(
        `Post-deploy journal entry ${entry.tag} has idx ${entry.idx}, not ${position}.`,
      );
    const path = join(folder, `${entry.tag}.sql`);
    if (!existsSync(path)) throw new Error(`Post-deploy step ${entry.tag} has no file.`);
    const sql = readFileSync(path, 'utf8');
    const statements = parseStatements(sql);
    if (statements.length !== 1) {
      throw new Error(
        `Post-deploy step ${entry.tag} has ${statements.length} statements; a step is exactly one.`,
      );
    }
    const statement = statements[0]!;
    return {
      idx: entry.idx,
      name: entry.tag,
      release: entry.release,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      statement,
      index: indexBuild(statement),
    };
  });
}

export interface PostStepResult {
  name: string;
  /** `applied` now, or `skipped` because an earlier run finished it. */
  outcome: 'applied' | 'skipped';
  /** An INVALID index left by an interrupted build was dropped first. */
  rebuiltInvalidIndex: boolean;
  /** Attempts this run (lock timeouts are retried). */
  attempts: number;
  durationMs: number;
}

export interface PostMigrationResult {
  steps: PostStepResult[];
  /** Background migrations newly scheduled by this run. */
  scheduled: string[];
}

/** The part of a pino-style logger the post-deploy runner uses. */
export interface PostMigrationLogger {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
}

export interface PostMigrationOptions {
  /** Test seam: a post-deploy folder other than the bundled one. */
  folder?: string;
  /** Test seam: the pre-deploy folder whose newest migration must be applied. */
  migrationsFolder?: string;
  /** How long to wait for another `migrate --post` to finish (default 60 s). */
  timeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Attempts per step before a lock timeout becomes a failure (default 10). */
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Background migrations to schedule (default: the registry). */
  backgroundMigrations?: BackgroundMigrationDefinition[];
  logger?: PostMigrationLogger;
}

const consoleLogger: PostMigrationLogger = {
  info: (_details, message) => console.log(message),
  warn: (_details, message) => console.warn(message),
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The session is gone (terminated, a failover, a network error): nothing more
 * can be sent on it, not even bookkeeping or the unlock. The server released
 * the advisory lock with the session; the step stays recorded as started.
 */
function connectionLost(error: unknown): boolean {
  const code = postgresErrorCode(error) ?? (error as { code?: unknown })?.code;
  if (typeof code !== 'string') return false;
  return /^(57P0[123]|08[0-9A-Z]{3}|CONNECTION_[A-Z_]+|E[A-Z]+)$/.test(code);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** True once the newest bundled pre-deploy migration is recorded. */
export async function preDeployApplied(
  client: Queryable,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): Promise<boolean> {
  const latest = readJournal(migrationsFolder).at(-1);
  if (!latest) return true;
  const history = await migrationHistory(client);
  return history.applied.includes(latest.when);
}

/**
 * Drops an INVALID index of the name a step builds, left by an interrupted
 * concurrent build (or by one that failed on a lock timeout or a duplicate).
 * Returns true if it dropped one.
 */
async function dropInvalidIndex(client: postgres.ReservedSql, index: IndexBuild): Promise<boolean> {
  if (!index.name) return false;
  const [found] = await client<[{ oid: number; valid: boolean; builder: number | null }?]>`
    select c.oid::integer as oid, i.indisvalid as valid,
      (select p.pid from pg_stat_progress_create_index p
        where p.index_relid = c.oid and p.pid <> pg_backend_pid() limit 1) as builder
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_index i on i.indexrelid = c.oid
    where n.nspname = ${index.schema} and c.relname = ${index.name}
  `;
  if (!found || found.valid) return false;
  if (found.builder !== null) {
    throw new Error(
      `Index ${index.schema}.${index.name} is being built by another session (pid ${found.builder}); wait for it to finish.`,
    );
  }
  await client.unsafe(
    `drop index concurrently if exists ${quoteIdent(index.schema)}.${quoteIdent(index.name)}`,
  );
  return true;
}

/**
 * Applies pending post-deploy steps in order, then schedules the release's
 * background migrations. Refuses to run until every bundled pre-deploy
 * migration is applied. Stops at the first step that fails (later steps may
 * depend on it) and throws, leaving that step recorded as not finished.
 */
export async function runPostMigrations(
  connectionString: string,
  options: PostMigrationOptions = {},
): Promise<PostMigrationResult> {
  const logger = options.logger ?? consoleLogger;
  const fromEnv = postMigrationTimeoutsFromEnv();
  const lockTimeoutMs = options.lockTimeoutMs ?? fromEnv.lockTimeoutMs;
  const statementTimeoutMs = options.statementTimeoutMs ?? fromEnv.statementTimeoutMs;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MIGRATION_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_MIGRATION_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MIGRATION_MAX_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? 60_000;

  await loadSqlParser();
  const steps = readPostSteps(options.folder);
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: 'oci-migrate-post' },
  });
  const health = { lost: false };
  try {
    const session = await client.reserve();
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const [row] = await session<[{ locked: boolean }]>`
          select pg_try_advisory_lock(${POST_MIGRATION_LOCK_KEY}::bigint) as locked`;
        if (row?.locked) break;
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for another \`migrate --post\` to finish.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      try {
        if (!(await preDeployApplied(session, options.migrationsFolder))) {
          throw new Error(
            'Post-deploy steps run only after every pre-deploy migration of this release is applied. Run `migrate` first, then replace every replica, then `migrate --post`.',
          );
        }
        // Session settings, not SET LOCAL: there is no transaction to scope them.
        await session`
          select set_config('lock_timeout', ${String(lockTimeoutMs)}, false),
            set_config('statement_timeout', ${String(statementTimeoutMs)}, false),
            set_config('idle_in_transaction_session_timeout', '10000', false)
        `;
        const done = new Map(
          (
            await session<{ name: string; checksum: string; finished: boolean }[]>`
              select name, checksum, finished_at is not null as finished from oci_post_migration`
          ).map((row) => [row.name, row]),
        );
        const results: PostStepResult[] = [];
        for (const step of steps) {
          const recorded = done.get(step.name);
          if (recorded?.finished) {
            if (recorded.checksum !== step.checksum) {
              logger.warn(
                { step: step.name },
                `Post-deploy step ${step.name} changed after it was applied; it is not run again.`,
              );
            }
            results.push({
              name: step.name,
              outcome: 'skipped',
              rebuiltInvalidIndex: false,
              attempts: 0,
              durationMs: 0,
            });
            continue;
          }
          results.push(
            await applyStep(session, step, {
              maxAttempts,
              retryDelayMs,
              maxRetryDelayMs,
              lockTimeoutMs,
              logger,
              health,
            }),
          );
        }
        const scheduled = await scheduleBackgroundMigrations(
          session,
          options.backgroundMigrations ?? backgroundMigrations(),
        );
        if (scheduled.length > 0) {
          logger.info({ scheduled }, `Scheduled background migrations: ${scheduled.join(', ')}`);
        }
        return { steps: results, scheduled };
      } finally {
        if (!health.lost) {
          await session`select pg_advisory_unlock(${POST_MIGRATION_LOCK_KEY}::bigint)`.catch(
            () => {},
          );
        }
      }
    } finally {
      if (!health.lost) session.release();
    }
  } finally {
    // A lost session has nothing to wait for; close at once.
    await client.end({ timeout: health.lost ? 0 : 5 }).catch(() => {});
  }
}

async function applyStep(
  session: postgres.ReservedSql,
  step: PostStep,
  settings: {
    maxAttempts: number;
    retryDelayMs: number;
    maxRetryDelayMs: number;
    lockTimeoutMs: number;
    logger: PostMigrationLogger;
    health: { lost: boolean };
  },
): Promise<PostStepResult> {
  const { logger } = settings;
  let rebuiltInvalidIndex = false;
  for (let attempt = 1; ; attempt++) {
    // Recorded before the statement runs, in its own (autocommit) statement,
    // so a crash part-way leaves the step visibly started and unfinished.
    await session`
      insert into oci_post_migration (name, checksum, started_at, attempts, last_error, finished_at, updated_at)
      values (${step.name}, ${step.checksum}, now(), 1, null, null, now())
      on conflict (name) do update set
        checksum = excluded.checksum, started_at = now(),
        attempts = oci_post_migration.attempts + 1,
        last_error = null, finished_at = null, updated_at = now()
    `;
    const started = Date.now();
    try {
      if (step.index && (await dropInvalidIndex(session, step.index))) {
        rebuiltInvalidIndex = true;
        logger.warn(
          { step: step.name, index: step.index.name },
          `Dropped INVALID index ${step.index.name} left by an interrupted build; building it again.`,
        );
      }
      logger.info({ step: step.name, attempt }, `Applying post-deploy step ${step.name}`);
      await session.unsafe(step.statement.text).simple();
      const durationMs = Date.now() - started;
      await session`
        update oci_post_migration
        set finished_at = now(), duration_ms = ${durationMs}, last_error = null, updated_at = now()
        where name = ${step.name}
      `;
      logger.info(
        { step: step.name, durationMs },
        `Post-deploy step ${step.name} finished in ${durationMs} ms`,
      );
      return {
        name: step.name,
        outcome: 'applied',
        rebuiltInvalidIndex,
        attempts: attempt,
        durationMs,
      };
    } catch (error) {
      if (connectionLost(error)) {
        settings.health.lost = true;
        throw new Error(
          `Post-deploy step ${step.name} was interrupted: the database connection was lost (${errorText(error)}). It is recorded as unfinished; run \`migrate --post\` again.`,
          { cause: error },
        );
      }
      await session`
        update oci_post_migration set last_error = ${errorText(error)}, updated_at = now()
        where name = ${step.name}
      `.catch(() => {});
      if (!isLockTimeout(error) || attempt >= settings.maxAttempts) {
        const reason = isLockTimeout(error)
          ? `waited more than ${settings.lockTimeoutMs}ms for a lock on each of ${attempt} attempts`
          : errorText(error);
        throw new Error(
          `Post-deploy step ${step.name} failed: ${reason}. It is recorded as unfinished; fix the cause and run \`migrate --post\` again.`,
          { cause: error },
        );
      }
      const delayMs = migrationRetryDelay(attempt, settings.retryDelayMs, settings.maxRetryDelayMs);
      logger.warn(
        { step: step.name, attempt, delayMs },
        `Post-deploy step ${step.name} attempt ${attempt}/${settings.maxAttempts} timed out waiting for a lock; retrying in ${delayMs}ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Inserts a `pending` row for each definition not yet scheduled. Returns the new ones. */
export async function scheduleBackgroundMigrations(
  client: Queryable,
  definitions: BackgroundMigrationDefinition[],
): Promise<string[]> {
  const scheduled: string[] = [];
  for (const definition of definitions) {
    const rows = await client<{ name: string }[]>`
      insert into background_migration (name, table_name, batch_size, pause_ms, estimated_rows)
      values (
        ${definition.name}, ${definition.table}, ${definition.batchSize}, ${definition.pauseMs},
        (select case when c.reltuples < 0 then null else c.reltuples::bigint end
           from pg_class c where c.oid = to_regclass(${definition.table}))
      )
      on conflict (name) do nothing
      returning name
    `;
    if (rows.length > 0) scheduled.push(definition.name);
  }
  return scheduled;
}

export interface PostStepState {
  name: string;
  release: string;
  /** `pending` (never run), `failed`/`interrupted` (started, not finished), `finished`. */
  state: 'pending' | 'started' | 'finished';
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  step: PostStep;
}

/** The bundled steps with what `oci_post_migration` records about each. */
export async function postStepStates(
  client: Queryable,
  folder: string = DEFAULT_POST_FOLDER,
): Promise<PostStepState[]> {
  await loadSqlParser();
  const steps = readPostSteps(folder);
  const [exists] = await client<[{ found: boolean }]>`
    select to_regclass('public.oci_post_migration') is not null as found`;
  const rows = exists?.found
    ? await client<
        {
          name: string;
          attempts: number;
          last_error: string | null;
          started_at: Date | null;
          finished_at: Date | null;
          duration_ms: number | null;
        }[]
      >`select name, attempts, last_error, started_at, finished_at, duration_ms from oci_post_migration`
    : [];
  const byName = new Map(rows.map((row) => [row.name, row]));
  return steps.map((step) => {
    const row = byName.get(step.name);
    return {
      name: step.name,
      release: step.release,
      state: row?.finished_at ? 'finished' : row?.started_at ? 'started' : 'pending',
      attempts: row?.attempts ?? 0,
      lastError: row?.last_error ?? null,
      startedAt: row?.started_at ? new Date(row.started_at).toISOString() : null,
      finishedAt: row?.finished_at ? new Date(row.finished_at).toISOString() : null,
      durationMs: row?.duration_ms ?? null,
      step,
    };
  });
}
