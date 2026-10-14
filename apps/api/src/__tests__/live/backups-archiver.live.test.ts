import { createDatabase } from '@oci/db';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_DIRECTORY,
  archiveAdminUrl,
  createUnprivilegedRole,
  eventually,
  liveArchivePostgresAvailable,
} from '../../../test/live-archive-postgres.js';
import { livePostgresAvailable } from '../../../test/live-postgres.js';

/**
 * System health's "Database backup (external)" row against real PostgreSQL 17
 * servers: one with WAL archiving on (the PostgreSQL manual's example
 * `archive_command` into a directory; `TEST_ARCHIVE_DATABASE_URL`) and the
 * ordinary test server with archiving off. OCI's read connects as an ordinary
 * application role, not a superuser; the superuser connection only makes WAL
 * and breaks and restores `archive_command`, as an operator's incident would.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  settings: {} as Record<string, unknown>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/backups/settings.js', () => ({
  backupSettings: async () => state.settings,
}));

const { readArchiverState, databaseBackupHealthCheck, archiverMetricSamples } = await import(
  '../../services/backups/database-state.js'
);

const archiveUrl = archiveAdminUrl();
const available = (await livePostgresAvailable()) && (await liveArchivePostgresAvailable());

describe.skipIf(!available)('live: WAL archiver state', () => {
  let admin: ReturnType<typeof postgres>;
  let role: Awaited<ReturnType<typeof createUnprivilegedRole>>;
  let app: ReturnType<typeof createDatabase>;
  const MINUTE = 60_000;

  /** What OCI reads, as the unprivileged role; fails the test if it could not. */
  async function read() {
    const result = await readArchiverState();
    if (!result.ok) throw new Error(`OCI could not read the archiver state: ${result.reason}`);
    return result.state;
  }

  /** WAL to archive: a write, then a segment switch, as the superuser. */
  async function makeWal() {
    await admin`create table if not exists archiver_probe (id serial primary key, at timestamptz not null default now())`;
    await admin`insert into archiver_probe default values`;
    await admin`select pg_switch_wal()`;
  }

  const inArchive = async (file: string) =>
    (
      await admin`select count(*)::int as found from pg_ls_dir(${ARCHIVE_DIRECTORY}) as f where f = ${file}`
    )[0]!.found === 1;

  async function setArchiveCommand(command: string | null) {
    if (command === null) await admin`alter system reset archive_command`;
    else await admin.unsafe(`alter system set archive_command = '${command}'`);
    await admin`select pg_reload_conf()`;
    await eventually('archive_command to change', async () => {
      const [row] = await admin`select current_setting('archive_command') as command`;
      return command === null ? row!.command !== 'false' : row!.command === command;
    });
  }

  beforeAll(async () => {
    admin = postgres(archiveUrl!, { max: 1, onnotice: () => {} });
    role = await createUnprivilegedRole(archiveUrl!);
    app = createDatabase(role.url, { max: 2 });
    state.db = app.db;
    state.settings = { databaseBackup: 'external', walArchivingExpected: true };
  });

  afterAll(async () => {
    // Whatever a test left, the shared server archives normally again.
    if (admin) {
      await setArchiveCommand(null).catch(() => {});
      await admin.end({ timeout: 1 }).catch(() => {});
    }
    await app?.sql.end({ timeout: 1 }).catch(() => {});
    await role?.drop().catch(() => {});
  });

  it('reads the archiver as an ordinary role, with no privilege beyond one', async () => {
    const [who] = await admin`
      select r.rolsuper as superuser,
             pg_has_role(r.oid, 'pg_monitor', 'member') as monitor,
             pg_has_role(r.oid, 'pg_read_all_stats', 'member') as stats,
             pg_has_role(r.oid, 'pg_read_server_files', 'member') as files
      from pg_roles r where r.rolname = ${role.name}`;
    expect(who).toEqual({ superuser: false, monitor: false, stats: false, files: false });

    const archiver = await read();
    expect(archiver).toMatchObject({
      archiveMode: 'on',
      walLevel: 'replica',
      archiveTimeoutSeconds: 60,
      inRecovery: false,
    });
    expect(archiver.archivedCount).toBeGreaterThanOrEqual(0);
  });

  it('sees a segment archived after a switch, and its file in the archive directory', async () => {
    const before = await read();
    await makeWal();
    const after = await eventually('a segment to be archived', async () => {
      const current = await read();
      return current.archivedCount > before.archivedCount ? current : null;
    });

    expect(after.lastArchivedWal).toMatch(/^[0-9A-F]{24}$/);
    expect(await inArchive(after.lastArchivedWal!)).toBe(true);
    expect(after.lastArchivedAt).toBeGreaterThan(Date.now() / 1000 - 5 * 60);

    const row = await databaseBackupHealthCheck();
    expect(row).toMatchObject({ id: 'database-backup', status: 'ok' });
    expect(row!.detail).toContain(`Last segment ${after.lastArchivedWal} archived`);
    expect(row!.detail).toMatch(/Not verified by OCI: that a base backup exists/);
    expect(archiverMetricSamples({ ok: true, state: after }, 'external')).toMatchObject({
      failing: 0,
      lastSuccessSeconds: Math.floor(after.lastArchivedAt!),
    });
  });

  it('turns red when archiving fails and stays red until it works again', async () => {
    const healthy = await read();
    try {
      // The operator's incident: the archive command starts failing.
      await setArchiveCommand('false');
      await makeWal();
      const failing = await eventually('a failed attempt', async () => {
        const current = await read();
        return current.failedCount > healthy.failedCount ? current : null;
      });
      expect(failing.lastFailedWal).toMatch(/^[0-9A-F]{24}$/);
      expect(failing.lastFailedAt).toBeGreaterThanOrEqual(failing.lastArchivedAt ?? 0);
      expect(archiverMetricSamples({ ok: true, state: failing }, 'external')).toMatchObject({
        failing: 1,
      });

      // Moments after the last success, it is only "retrying".
      const soon = await databaseBackupHealthCheck(new Date());
      expect(soon).toMatchObject({ status: 'warn' });
      expect(soon!.detail).toMatch(/^A recent archive attempt failed; retrying\./);
      // With the clock past 15 minutes it is an error naming the segment that cannot be archived.
      const later = await databaseBackupHealthCheck(new Date(Date.now() + 16 * MINUTE));
      expect(later).toMatchObject({ status: 'error' });
      expect(later!.detail).toContain(`${failing.lastFailedWal}`);
      expect(later!.detail).toMatch(/WAL archiving is failing/);

      // The operator fixes it: the pending segment is archived and the row recovers.
      await setArchiveCommand(null);
      await makeWal();
      const recovered = await eventually(
        'archiving to recover',
        async () => {
          const current = await read();
          return current.archivedCount > failing.archivedCount &&
            (current.lastArchivedAt ?? 0) > (current.lastFailedAt ?? 0)
            ? current
            : null;
        },
        120_000,
      );
      expect(await inArchive(recovered.lastArchivedWal!)).toBe(true);
      expect(await databaseBackupHealthCheck()).toMatchObject({ status: 'ok' });
      expect(archiverMetricSamples({ ok: true, state: recovered }, 'external')).toMatchObject({
        failing: 0,
      });

      // An archiver that has worked but then goes quiet is a warning, not an error.
      const quiet = await databaseBackupHealthCheck(new Date(Date.now() + 16 * MINUTE));
      expect(quiet).toMatchObject({ status: 'warn' });
      expect(quiet!.detail).toMatch(
        /^No WAL archived for 16 minutes; expected at least every 1 minute/,
      );
    } finally {
      await setArchiveCommand(null);
    }
  });

  it('reads a statistics reset as nothing archived yet, not as a failure', async () => {
    // The tests before this one fail the archiver on purpose; segments queued meanwhile are
    // retried on the archiver's own schedule, and one that lands after the reset makes "nothing
    // archived" false (seen in a full run). Reset only once the queue is empty.
    await eventually(
      'the archive queue to drain',
      async () =>
        (
          await admin`select count(*)::int as pending from pg_ls_archive_statusdir() where name like '%.ready'`
        )[0]!.pending === 0,
      120_000,
    );
    await admin`select pg_stat_reset_shared('archiver')`;
    const reset = await read();
    expect(reset).toMatchObject({ archivedCount: 0, failedCount: 0, lastArchivedAt: null });
    expect(reset.statsResetAt).toBeGreaterThan(Date.now() / 1000 - 60);

    const row = await databaseBackupHealthCheck();
    expect(row).toMatchObject({ status: 'ok' });
    expect(row!.detail).toMatch(
      /^No WAL segment has been archived since statistics were reset at /,
    );
    expect(archiverMetricSamples({ ok: true, state: reset }, 'external')).toEqual({
      failing: 0,
      lastSuccessSeconds: null,
    });
    // Long after the reset, with nothing archived, an archive_timeout server is expected to have.
    const stale = await databaseBackupHealthCheck(new Date(Date.now() + 2 * 60 * MINUTE));
    expect(stale).toMatchObject({ status: 'warn' });
    expect(stale!.detail).toMatch(/^No WAL archived since statistics were reset at /);
  });

  it('warns on a server that does not archive, unless that is expected', async () => {
    const normal = createDatabase(process.env.TEST_DATABASE_URL!, { max: 1 });
    const archivingDb = state.db;
    state.db = normal.db;
    try {
      state.settings = { databaseBackup: 'external', walArchivingExpected: true };
      const warned = await databaseBackupHealthCheck();
      expect(warned).toMatchObject({ status: 'warn' });
      expect(warned!.detail).toMatch(
        /^WAL archiving is off, so point-in-time recovery is not possible from this server\./,
      );
      expect(warned!.detail).toMatch(/Not verified by OCI: that a base backup exists/);

      state.settings = { databaseBackup: 'external', walArchivingExpected: false };
      const accepted = await databaseBackupHealthCheck();
      expect(accepted).toMatchObject({ status: 'ok' });
      expect(accepted!.detail).toMatch(/^WAL archiving is off, as configured/);

      // In dump mode OCI has nothing to say about it.
      state.settings = { databaseBackup: 'dump' };
      expect(await databaseBackupHealthCheck()).toBeNull();
    } finally {
      state.db = archivingDb;
      state.settings = { databaseBackup: 'external', walArchivingExpected: true };
      await normal.sql.end({ timeout: 1 });
    }
  });
});
