import postgres from 'postgres';

/**
 * Lock-safe migration settings (v0.11 design, section 2).
 *
 * Without a lock timeout, a migration statement that needs a lock another
 * session holds (an ALTER TABLE behind a long report, or a `pg_dump`) waits for
 * as long as that session does, and PostgreSQL queues every later request for
 * the table behind the waiting migration. One long transaction plus one
 * ALTER TABLE then stops all reads and writes of the table. With a lock timeout
 * the attempt gives up quickly, rolls back, and is retried with backoff.
 */
export interface MigrationTimeouts {
  /** `lock_timeout` for every migration statement. */
  lockTimeoutMs: number;
  /** `statement_timeout` for every migration statement; 0 disables it. */
  statementTimeoutMs: number;
  /** `idle_in_transaction_session_timeout` for the migration session. */
  idleInTransactionTimeoutMs: number;
}

export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 3_000;
/**
 * Generous for now: pre-deploy migrations still run in one transaction and a
 * few historical steps (v0.7's message search index) scale with data. Each
 * statement (one Drizzle breakpoint chunk) gets this long, not the whole run.
 */
export const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 15 * 60_000;
/**
 * The migrator is idle inside its transaction only between statements and
 * while polling for the advisory lock (every 500ms). A client that stalls
 * longer than this while holding DDL locks is disconnected by the server,
 * releasing every lock it holds.
 */
export const DEFAULT_MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;
export const DEFAULT_MIGRATION_MAX_ATTEMPTS = 10;
export const DEFAULT_MIGRATION_RETRY_DELAY_MS = 1_000;
export const DEFAULT_MIGRATION_MAX_RETRY_DELAY_MS = 30_000;

export const MIGRATION_LOCK_TIMEOUT_LIMITS = { min: 100, max: 600_000 } as const;
export const MIGRATION_STATEMENT_TIMEOUT_LIMITS = { min: 0, max: 86_400_000 } as const;

function readMilliseconds(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
    throw new Error(
      `${name} must be a whole number of milliseconds from ${limits.min} to ${limits.max}; got "${raw}".`,
    );
  }
  return value;
}

/**
 * Reads MIGRATION_LOCK_TIMEOUT_MS and MIGRATION_STATEMENT_TIMEOUT_MS. The API
 * validates the same variables at startup (apps/api/src/config/env.ts); this
 * lets every caller of the migrator honour them without plumbing.
 */
export function migrationTimeoutsFromEnv(
  env: Record<string, string | undefined> = process.env,
): MigrationTimeouts {
  return {
    lockTimeoutMs: readMilliseconds(
      env,
      'MIGRATION_LOCK_TIMEOUT_MS',
      DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
      MIGRATION_LOCK_TIMEOUT_LIMITS,
    ),
    statementTimeoutMs: readMilliseconds(
      env,
      'MIGRATION_STATEMENT_TIMEOUT_MS',
      DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
      MIGRATION_STATEMENT_TIMEOUT_LIMITS,
    ),
    idleInTransactionTimeoutMs: DEFAULT_MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}

/** Exponential backoff with ±25% jitter, so competing replicas do not retry in step. */
export function migrationRetryDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.round(exponential * (0.75 + random() * 0.5)));
}

/** The PostgreSQL error at the end of a cause chain (Drizzle wraps driver errors). */
export function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** SQLSTATE 55P03, lock_not_available: raised when lock_timeout expires. */
export function isLockTimeout(error: unknown): boolean {
  return postgresErrorCode(error) === '55P03';
}

/** The SQL Drizzle was running when it failed, when it says. */
export function failedStatement(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth++) {
    const query = (current as { query?: unknown }).query;
    if (typeof query === 'string' && query.trim()) return query.trim();
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface LockBlocker {
  pid: number;
  state: string | null;
  applicationName: string | null;
  transactionStart: string | null;
  query: string | null;
}

/** What the migration session was waiting for, seen from another connection. */
export interface LockWait {
  locktype: string;
  mode: string;
  /** Schema-qualified, when the lock is on a relation. */
  relation: string | null;
  blockers: LockBlocker[];
}

export interface MigrationRetryEvent {
  /** The attempt that timed out, from 1. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  relation: string | null;
  mode: string | null;
  blockers: LockBlocker[];
  statement: string | undefined;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function describeBlocker(blocker: LockBlocker): string {
  const details = [
    blocker.state ?? 'unknown state',
    blocker.transactionStart ? `transaction started ${blocker.transactionStart}` : null,
    blocker.applicationName ? `application "${blocker.applicationName}"` : null,
  ].filter(Boolean);
  const query = blocker.query ? `: ${oneLine(blocker.query, 200)}` : '';
  return `pid ${blocker.pid} (${details.join(', ')})${query}`;
}

export class MigrationLockTimeoutError extends Error {
  override name = 'MigrationLockTimeoutError';
  readonly attempts: number;
  readonly lockWait: LockWait | null;
  readonly statement: string | undefined;

  constructor(options: {
    attempts: number;
    lockTimeoutMs: number;
    lockWait: LockWait | null;
    statement: string | undefined;
    cause: unknown;
  }) {
    const { attempts, lockTimeoutMs, lockWait, statement } = options;
    const target = lockWait
      ? ` for ${lockWait.mode} on ${lockWait.relation ?? `a ${lockWait.locktype} lock`}`
      : '';
    const blockers = lockWait?.blockers.length
      ? ` Blocked by ${lockWait.blockers.map(describeBlocker).join('; ')}.`
      : ' The blocking session could not be identified; inspect pg_locks and pg_stat_activity.';
    const step = statement ? ` Statement: ${oneLine(statement, 300)}` : '';
    super(
      `Database migration gave up after ${attempts} attempts: each waited more than ` +
        `${lockTimeoutMs}ms (lock_timeout, SQLSTATE 55P03)${target} and was rolled back.` +
        `${blockers} Let the blocking transaction finish or end it ` +
        `(pg_terminate_backend), then run the migration again.${step}`,
      { cause: options.cause },
    );
    this.attempts = attempts;
    this.lockWait = lockWait;
    this.statement = statement;
  }
}

type LockRow = {
  locktype: string;
  mode: string;
  relation: string | null;
  blockers: Array<{
    pid: number;
    state: string | null;
    application_name: string | null;
    xact_start: string | null;
    query: string | null;
  }>;
};

/**
 * Samples, from a second connection, what the migration backend is waiting
 * for. When lock_timeout fires the wait is already gone, so the evidence for
 * the error message has to be collected while it happens. The connection opens
 * only once an attempt has run for one interval, so a quick or already-current
 * migration never opens it.
 */
export function startLockMonitor(connectionString: string, pid: number, intervalMs: number) {
  let client: postgres.Sql | undefined;
  let latest: LockWait | null = null;
  let running: Promise<void> | undefined;
  let stopped = false;

  const sample = async () => {
    client ??= postgres(connectionString, {
      max: 1,
      prepare: false,
      connect_timeout: 5,
      onnotice: () => {},
      connection: { application_name: 'oci-migration-lock-monitor' },
    });
    const rows = await client<LockRow[]>`
      select l.locktype, l.mode,
        case when l.relation is not null then (
          select format('%I.%I', n.nspname, c.relname)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.oid = l.relation
        ) end as relation,
        coalesce((
          select json_agg(json_build_object(
            'pid', a.pid, 'state', a.state, 'application_name', nullif(a.application_name, ''),
            'xact_start', a.xact_start, 'query', left(a.query, 500)
          ) order by a.pid)
          from pg_stat_activity a where a.pid = any(pg_blocking_pids(l.pid))
        ), '[]'::json) as blockers
      from pg_locks l
      where l.pid = ${pid} and not l.granted
      limit 1
    `;
    const row = rows[0];
    if (!row) return;
    const blockers = row.blockers.map((blocker) => ({
      pid: blocker.pid,
      state: blocker.state,
      applicationName: blocker.application_name,
      transactionStart: blocker.xact_start,
      query: blocker.query,
    }));
    // pg_blocking_pids runs after pg_locks is read: a wait that ends in between
    // (lock_timeout firing) reports no blockers. Keep what the same wait showed.
    const sameWait =
      latest?.locktype === row.locktype &&
      latest.mode === row.mode &&
      latest.relation === row.relation;
    latest = {
      locktype: row.locktype,
      mode: row.mode,
      relation: row.relation,
      blockers: blockers.length === 0 && sameWait ? latest!.blockers : blockers,
    };
  };

  const timer = setInterval(() => {
    if (stopped || running) return;
    // Diagnostics only: a failed sample must never fail the migration.
    running = sample()
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    latest: () => latest,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // Close first: an in-flight sample is abandoned rather than awaited.
      await client?.end({ timeout: 1 }).catch(() => {});
      await running;
    },
  };
}
