import { sql } from '@oci/db';
import { db } from '../../db/index.js';
import { backupSettings } from './settings.js';

/**
 * What OCI can see of a database that something else backs up (`databaseBackup:
 * 'external'`): whether WAL archiving is on and working, from one read-only
 * query on the application pool. It is the primary's own view, and all it is:
 * OCI cannot tell whether a base backup exists, is recent, or restores, and
 * every state says so (`NOT_VERIFIED`).
 *
 * Never read: `archive_command` (it can carry credentials), replica lag
 * (`pg_stat_replication` needs `pg_monitor`, which an application role lacks),
 * and anything in the operator's backup tooling. Only WAL file names are
 * shown. A read that is not permitted is a warning, never an error: OCI cannot
 * tell. The row is red only for an archiver failing now, the one thing OCI can
 * see that harms the primary (a full WAL disk) and ends recoverability.
 */

export interface DatabaseStateCheck {
  id: 'database-backup';
  label: 'Database backup (external)';
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

/** Ends every detail, in every state. */
export const NOT_VERIFIED =
  'Not verified by OCI: that a base backup exists, is recent, or restores. Run the restore drill.';

/** A failed archive attempt with a success this recent is retrying, not failing. */
const RECENT_SUCCESS_SECONDS = 15 * 60;

/**
 * `archive_timeout` comes from `pg_settings` (always in seconds) rather than
 * `current_setting`, which prints "5min" and "1h". Epoch seconds are read as
 * numbers so no driver has to decide how to parse a timestamp.
 */
export const ARCHIVER_QUERY = `
select current_setting('archive_mode') as archive_mode,
       current_setting('wal_level') as wal_level,
       (select setting from pg_settings where name = 'archive_timeout') as archive_timeout,
       pg_is_in_recovery() as in_recovery,
       a.archived_count,
       a.last_archived_wal,
       extract(epoch from a.last_archived_time)::float8 as last_archived_at,
       a.failed_count,
       a.last_failed_wal,
       extract(epoch from a.last_failed_time)::float8 as last_failed_at,
       extract(epoch from a.stats_reset)::float8 as stats_reset_at
from pg_stat_archiver a`;

/** What was read; a null field is one that could not be read or understood. */
export interface ArchiverState {
  archiveMode: string | null;
  walLevel: string | null;
  archiveTimeoutSeconds: number | null;
  inRecovery: boolean | null;
  archivedCount: number;
  lastArchivedWal: string | null;
  /** Epoch seconds. */
  lastArchivedAt: number | null;
  failedCount: number;
  lastFailedWal: string | null;
  lastFailedAt: number | null;
  statsResetAt: number | null;
}

export type ArchiverRead = { ok: true; state: ArchiverState } | { ok: false; reason: string };

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function number(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

/** Only a WAL file name is shown: its leading name characters, nothing a server could add. */
function walName(value: string | null): string {
  return value?.match(/^[0-9A-Za-z._-]{1,64}/)?.[0] ?? 'unknown';
}

/** Reads the archiver state on the application pool. Never throws. */
export async function readArchiverState(): Promise<ArchiverRead> {
  let row: Record<string, unknown> | undefined;
  try {
    [row] = (await db.execute(sql.raw(ARCHIVER_QUERY))) as unknown as Array<
      Record<string, unknown>
    >;
  } catch (error) {
    return {
      ok: false,
      reason: (error instanceof Error ? error.message : 'the query failed').slice(0, 200),
    };
  }
  if (!row) return { ok: false, reason: 'pg_stat_archiver returned no row' };
  return {
    ok: true,
    state: {
      archiveMode: text(row.archive_mode),
      walLevel: text(row.wal_level),
      archiveTimeoutSeconds: number(row.archive_timeout),
      inRecovery: typeof row.in_recovery === 'boolean' ? row.in_recovery : null,
      archivedCount: number(row.archived_count) ?? 0,
      lastArchivedWal: text(row.last_archived_wal),
      lastArchivedAt: number(row.last_archived_at),
      failedCount: number(row.failed_count) ?? 0,
      lastFailedWal: text(row.last_failed_wal),
      lastFailedAt: number(row.last_failed_at),
      statsResetAt: number(row.stats_reset_at),
    },
  };
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

function span(seconds: number): string {
  const [amount, unit] =
    seconds < 60
      ? [Math.round(seconds), 'second']
      : seconds < 3600
        ? [Math.round(seconds / 60), 'minute']
        : seconds < 2 * 86_400
          ? [Math.round(seconds / 3600), 'hour']
          : [Math.round(seconds / 86_400), 'day'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

/** The newest failure is later than the newest success (or there was no success). */
export function archiverFailing(state: ArchiverState): boolean {
  return (
    state.lastFailedAt !== null &&
    (state.lastArchivedAt === null || state.lastFailedAt > state.lastArchivedAt)
  );
}

/**
 * The row for what was read. The first rule that matches decides; see
 * docs/admin/external-database-backup.md for the table. `expected` is the
 * `walArchivingExpected` setting.
 */
export function judgeDatabaseState(
  read: ArchiverRead,
  expected: boolean,
  now: Date,
): DatabaseStateCheck {
  const base = { id: 'database-backup', label: 'Database backup (external)' } as const;
  const row = (status: DatabaseStateCheck['status'], detail: string): DatabaseStateCheck => ({
    ...base,
    status,
    detail: `${detail} ${NOT_VERIFIED}`,
  });
  if (!read.ok) return row('warn', `Could not read the WAL archiver state: ${read.reason}.`);

  const { state } = read;
  const unreadable = [
    ['archive_mode', state.archiveMode],
    ['wal_level', state.walLevel],
    ['archive_timeout', state.archiveTimeoutSeconds],
    ['pg_is_in_recovery()', state.inRecovery],
  ]
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (unreadable.length > 0)
    return row(
      'warn',
      `Could not read ${unreadable.join(', ')}, so the WAL archiver state cannot be judged.`,
    );

  if (state.inRecovery)
    return row('warn', 'DATABASE_URL names a standby; point it at the primary.');

  if (state.archiveMode === 'off' || state.walLevel === 'minimal')
    return expected
      ? row(
          'warn',
          'WAL archiving is off, so point-in-time recovery is not possible from this server.',
        )
      : row('ok', 'WAL archiving is off, as configured (snapshot-style backups).');

  const nowSeconds = now.getTime() / 1000;
  const sinceSuccess = state.lastArchivedAt === null ? null : nowSeconds - state.lastArchivedAt;
  if (archiverFailing(state)) {
    if (sinceSuccess !== null && sinceSuccess <= RECENT_SUCCESS_SECONDS)
      return row('warn', 'A recent archive attempt failed; retrying.');
    return row(
      'error',
      `WAL archiving is failing (last failure ${iso(state.lastFailedAt as number)}, ${walName(state.lastFailedWal)}; last success ${state.lastArchivedAt === null ? 'none recorded' : iso(state.lastArchivedAt)}); WAL piles up on the primary's disk and recovery points stop advancing.`,
    );
  }

  const timeout = state.archiveTimeoutSeconds as number;
  const idleNote =
    timeout === 0
      ? ' archive_timeout is 0: an idle server can go long between segments, so how long ago is not judged.'
      : '';
  const staleAfter = Math.max(3 * timeout, RECENT_SUCCESS_SECONDS);

  if (state.lastArchivedAt === null) {
    // After a statistics reset (or on a new server) there is nothing to date.
    const since =
      state.statsResetAt === null
        ? 'the statistics start time is unknown'
        : `statistics were reset at ${iso(state.statsResetAt)}`;
    if (
      timeout > 0 &&
      (state.statsResetAt === null || nowSeconds - state.statsResetAt > staleAfter)
    )
      return row(
        'warn',
        state.statsResetAt === null
          ? `No WAL archived, and ${since}; expected at least every ${span(timeout)}. The server may be idle.`
          : `No WAL archived since ${since}; expected at least every ${span(timeout)}. The server may be idle.`,
      );
    return row('ok', `No WAL segment has been archived since ${since}.${idleNote}`);
  }

  if (timeout > 0 && (sinceSuccess as number) > staleAfter)
    return row(
      'warn',
      `No WAL archived for ${span(sinceSuccess as number)}; expected at least every ${span(timeout)}. The server may be idle.`,
    );

  const since = state.statsResetAt === null ? '' : ` since ${iso(state.statsResetAt)}`;
  return row(
    'ok',
    `Last segment ${walName(state.lastArchivedWal)} archived ${iso(state.lastArchivedAt)}; ${state.archivedCount} archived${since}.${idleNote}`,
  );
}

/**
 * The System health row, or null when the database is dumped by OCI (then the
 * Backups row is the whole story). Shown whether or not scheduled backups are
 * on: the attachment backup and the database's own backup are separate.
 */
export async function databaseBackupHealthCheck(
  now = new Date(),
): Promise<DatabaseStateCheck | null> {
  const settings = await backupSettings();
  if (settings.databaseBackup !== 'external') return null;
  return judgeDatabaseState(await readArchiverState(), settings.walArchivingExpected, now);
}

/**
 * The two WAL archive metrics, from the same read. Null (nothing reported)
 * unless the mode is external and the read worked; `lastSuccessSeconds` is null
 * when there has been no success.
 */
export function archiverMetricSamples(
  read: ArchiverRead,
  mode: 'dump' | 'external',
): { lastSuccessSeconds: number | null; failing: 0 | 1 } | null {
  if (mode !== 'external' || !read.ok) return null;
  return {
    lastSuccessSeconds:
      read.state.lastArchivedAt === null ? null : Math.floor(read.state.lastArchivedAt),
    failing: archiverFailing(read.state) ? 1 : 0,
  };
}
