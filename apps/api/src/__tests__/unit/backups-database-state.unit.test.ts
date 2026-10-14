import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * System health's "Database backup (external)" row: what OCI can read about
 * WAL archiving, and the words for each state. One case per row of the rules
 * in docs/admin/external-database-backup.md, with the clock injected.
 */
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  settings: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({ db: { execute: mocks.execute } }));
vi.mock('../../services/backups/settings.js', () => ({ backupSettings: mocks.settings }));

const {
  ARCHIVER_QUERY,
  NOT_VERIFIED,
  archiverMetricSamples,
  databaseBackupHealthCheck,
  judgeDatabaseState,
  readArchiverState,
} = await import('../../services/backups/database-state.js');
type ArchiverState = import('../../services/backups/database-state.js').ArchiverState;

const NOW = new Date('2026-10-13T12:00:00.000Z');
const minutesAgo = (minutes: number) => NOW.getTime() / 1000 - minutes * 60;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

/** A healthy primary: archiving on, `archive_timeout` 60 s, a segment archived a minute ago. */
function state(overrides: Partial<ArchiverState> = {}): ArchiverState {
  return {
    archiveMode: 'on',
    walLevel: 'replica',
    archiveTimeoutSeconds: 60,
    inRecovery: false,
    archivedCount: 1234,
    lastArchivedWal: '000000010000000000000042',
    lastArchivedAt: minutesAgo(1),
    failedCount: 0,
    lastFailedWal: null,
    lastFailedAt: null,
    statsResetAt: minutesAgo(60 * 24 * 3),
    ...overrides,
  };
}

const judge = (s: ArchiverState, expected = true) =>
  judgeDatabaseState({ ok: true, state: s }, expected, NOW);

describe('database backup (external) row', () => {
  beforeEach(() => {
    mocks.execute.mockReset();
    mocks.settings.mockReset();
  });

  it('warns that DATABASE_URL names a standby, whatever else is true', () => {
    const row = judge(state({ inRecovery: true, lastFailedAt: minutesAgo(1) }));
    expect(row).toMatchObject({
      id: 'database-backup',
      label: 'Database backup (external)',
      status: 'warn',
    });
    expect(row.detail).toMatch(/^DATABASE_URL names a standby; point it at the primary\./);
  });

  it('warns when archiving is off and expected, for archive_mode and for wal_level', () => {
    for (const off of [{ archiveMode: 'off' }, { walLevel: 'minimal' }]) {
      const row = judge(state(off));
      expect(row.status).toBe('warn');
      expect(row.detail).toMatch(
        /^WAL archiving is off, so point-in-time recovery is not possible from this server\./,
      );
    }
  });

  it('is ok when archiving is off and that is configured (snapshot-style backups)', () => {
    const row = judge(state({ archiveMode: 'off' }), false);
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/^WAL archiving is off, as configured \(snapshot-style backups\)\./);
  });

  it('judges a working archiver normally even when archiving is not expected', () => {
    expect(judge(state(), false).status).toBe('ok');
    const failing = state({ lastFailedAt: minutesAgo(1), lastArchivedAt: minutesAgo(40) });
    expect(judge(failing, false).status).toBe('error');
  });

  it('is an error only for an archiver failing now with no success in 15 minutes', () => {
    const row = judge(
      state({
        lastFailedAt: minutesAgo(2),
        lastFailedWal: '000000010000000000000043',
        failedCount: 12,
        lastArchivedAt: minutesAgo(40),
      }),
    );
    expect(row.status).toBe('error');
    expect(row.detail).toMatch(/^WAL archiving is failing/);
    expect(row.detail).toContain('000000010000000000000043');
    expect(row.detail).toContain(iso(minutesAgo(2)));
    expect(row.detail).toContain(iso(minutesAgo(40)));
    expect(row.detail).toMatch(/WAL piles up on the primary's disk and recovery points stop/);

    // Never succeeded since the statistics began: still failing.
    expect(judge(state({ lastFailedAt: minutesAgo(2), lastArchivedAt: null })).status).toBe(
      'error',
    );
    // 15 minutes exactly is still "recent"; a second more is not.
    const edge = (age: number) =>
      judge(state({ lastFailedAt: minutesAgo(1), lastArchivedAt: minutesAgo(0) - age }));
    expect(edge(15 * 60).status).toBe('warn');
    expect(edge(15 * 60 + 1).status).toBe('error');
  });

  it('warns, not errors, when a failure is followed by nothing worse than a recent success gap', () => {
    const row = judge(state({ lastFailedAt: minutesAgo(1), lastArchivedAt: minutesAgo(5) }));
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/^A recent archive attempt failed; retrying\./);
  });

  it('is not failing once a success is later than the last failure', () => {
    const row = judge(state({ lastFailedAt: minutesAgo(30), lastArchivedAt: minutesAgo(1) }));
    expect(row.status).toBe('ok');
  });

  it('warns when nothing was archived for max(3 x archive_timeout, 15 minutes)', () => {
    // 60 s: the floor is 15 minutes.
    let row = judge(state({ lastArchivedAt: minutesAgo(16) }));
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(
      /^No WAL archived for 16 minutes; expected at least every 1 minute\./,
    );
    expect(row.detail).toContain('The server may be idle.');
    expect(judge(state({ lastArchivedAt: minutesAgo(14) })).status).toBe('ok');
    // 10 minutes: 3 x is 30 minutes.
    expect(
      judge(state({ archiveTimeoutSeconds: 600, lastArchivedAt: minutesAgo(29) })).status,
    ).toBe('ok');
    row = judge(state({ archiveTimeoutSeconds: 600, lastArchivedAt: minutesAgo(31) }));
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/expected at least every 10 minutes/);
    // Hours read as hours.
    row = judge(state({ archiveTimeoutSeconds: 3600, lastArchivedAt: minutesAgo(60 * 4) }));
    expect(row.detail).toMatch(/No WAL archived for 4 hours; expected at least every 1 hour\./);
  });

  it('makes no staleness judgement when archive_timeout is 0, and says so', () => {
    const row = judge(state({ archiveTimeoutSeconds: 0, lastArchivedAt: minutesAgo(60 * 72) }));
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/archive_timeout is 0/);
    expect(row.detail).toMatch(/idle server can go long between segments/);
  });

  it('reads a NULL last archive time after a statistics reset', () => {
    const fresh = state({ lastArchivedAt: null, archivedCount: 0, statsResetAt: minutesAgo(5) });
    let row = judge(fresh);
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/^No WAL segment has been archived since statistics were reset at /);

    row = judge({ ...fresh, statsResetAt: minutesAgo(120) });
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/^No WAL archived since statistics were reset at /);
    // Without a reset time there is nothing to measure from.
    expect(judge({ ...fresh, statsResetAt: null }).status).toBe('warn');
    // With archive_timeout 0, nothing is expected and it says why.
    row = judge({ ...fresh, statsResetAt: minutesAgo(120), archiveTimeoutSeconds: 0 });
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(/archive_timeout is 0/);
  });

  it('is ok, naming the last segment and the count, when archiving works', () => {
    const row = judge(state());
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(
      /^Last segment 000000010000000000000042 archived .*; 1234 archived since /,
    );
    expect(row.detail).toContain(iso(minutesAgo(1)));
    // Without a reset time the count stands alone.
    expect(judge(state({ statsResetAt: null })).detail).toContain('1234 archived');
  });

  it('warns, never errors, when something could not be read', () => {
    for (const broken of [
      { archiveTimeoutSeconds: null },
      { archiveMode: null },
      { walLevel: null },
      { inRecovery: null },
    ] as Array<Partial<ArchiverState>>) {
      const row = judge(state(broken));
      expect(row.status).toBe('warn');
      expect(row.detail).toMatch(/^Could not read /);
    }
    const row = judgeDatabaseState(
      { ok: false, reason: 'permission denied for view pg_stat_archiver' },
      true,
      NOW,
    );
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(
      /^Could not read the WAL archiver state: permission denied for view pg_stat_archiver\./,
    );
  });

  it('says in every state that OCI cannot tell whether the backup restores', () => {
    const rows = [
      judge(state()),
      judge(state({ inRecovery: true })),
      judge(state({ archiveMode: 'off' })),
      judge(state({ archiveMode: 'off' }), false),
      judge(state({ lastFailedAt: minutesAgo(1), lastArchivedAt: minutesAgo(40) })),
      judge(state({ lastFailedAt: minutesAgo(1), lastArchivedAt: minutesAgo(5) })),
      judge(state({ lastArchivedAt: minutesAgo(60) })),
      judge(state({ archiveTimeoutSeconds: 0 })),
      judge(state({ lastArchivedAt: null, statsResetAt: null })),
      judge(state({ archiveMode: null })),
      judgeDatabaseState({ ok: false, reason: 'boom' }, true, NOW),
    ];
    expect(NOT_VERIFIED).toBe(
      'Not verified by OCI: that a base backup exists, is recent, or restores. Run the restore drill.',
    );
    for (const row of rows) expect(row.detail.endsWith(` ${NOT_VERIFIED}`), row.detail).toBe(true);
  });

  it('shows WAL file names only, with nothing else a server could put there', () => {
    const row = judge(
      state({ lastArchivedWal: `000000010000000000000042\n${'x'.repeat(300)} password=hunter2` }),
    );
    expect(row.detail).not.toContain('\n');
    expect(row.detail).not.toContain('hunter2');
    expect(row.detail.length).toBeLessThan(400);
  });

  it('reads with one read-only query that never touches archive_command', async () => {
    expect(ARCHIVER_QUERY).not.toMatch(/archive_command/i);
    expect(ARCHIVER_QUERY).toMatch(/pg_stat_archiver/);
    expect(ARCHIVER_QUERY).toMatch(/pg_is_in_recovery/);
    expect(ARCHIVER_QUERY).not.toMatch(/\b(insert|update|delete|alter|create|drop)\b/i);

    mocks.execute.mockResolvedValueOnce([
      {
        archive_mode: 'on',
        wal_level: 'replica',
        archive_timeout: '300',
        in_recovery: false,
        archived_count: '17',
        last_archived_wal: '000000010000000000000007',
        last_archived_at: minutesAgo(2),
        failed_count: '1',
        last_failed_wal: '000000010000000000000006',
        last_failed_at: minutesAgo(30),
        stats_reset_at: null,
      },
    ]);
    expect(await readArchiverState()).toEqual({
      ok: true,
      state: {
        archiveMode: 'on',
        walLevel: 'replica',
        archiveTimeoutSeconds: 300,
        inRecovery: false,
        archivedCount: 17,
        lastArchivedWal: '000000010000000000000007',
        lastArchivedAt: minutesAgo(2),
        failedCount: 1,
        lastFailedWal: '000000010000000000000006',
        lastFailedAt: minutesAgo(30),
        statsResetAt: null,
      },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('reads values it cannot interpret as unreadable, and a refused query as a reason', async () => {
    mocks.execute.mockResolvedValueOnce([
      {
        archive_mode: null,
        wal_level: 'replica',
        archive_timeout: 'soon',
        in_recovery: 'maybe',
        archived_count: null,
        last_archived_wal: null,
        last_archived_at: null,
        failed_count: null,
        last_failed_wal: null,
        last_failed_at: null,
        stats_reset_at: 'not a number',
      },
    ]);
    const read = await readArchiverState();
    expect(read).toMatchObject({
      ok: true,
      state: {
        archiveMode: null,
        archiveTimeoutSeconds: null,
        inRecovery: null,
        archivedCount: 0,
        failedCount: 0,
        statsResetAt: null,
      },
    });

    mocks.execute.mockResolvedValueOnce([]);
    expect(await readArchiverState()).toMatchObject({ ok: false });
    mocks.execute.mockRejectedValueOnce(new Error('permission denied for view pg_stat_archiver'));
    expect(await readArchiverState()).toEqual({
      ok: false,
      reason: 'permission denied for view pg_stat_archiver',
    });
    mocks.execute.mockRejectedValueOnce('not an error object');
    expect(await readArchiverState()).toEqual({ ok: false, reason: 'the query failed' });
    mocks.execute.mockRejectedValueOnce(new Error(`x${'y'.repeat(500)}`));
    const long = await readArchiverState();
    expect(long.ok === false && long.reason.length).toBeLessThanOrEqual(200);
  });

  it('is absent in dump mode, and present in external mode whether or not backups are on', async () => {
    mocks.settings.mockResolvedValue({ databaseBackup: 'dump', enabled: true });
    expect(await databaseBackupHealthCheck(NOW)).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();

    const row = {
      archive_mode: 'off',
      wal_level: 'replica',
      archive_timeout: '0',
      in_recovery: false,
      archived_count: '0',
      last_archived_wal: null,
      last_archived_at: null,
      failed_count: '0',
      last_failed_wal: null,
      last_failed_at: null,
      stats_reset_at: null,
    };
    mocks.execute.mockResolvedValue([row]);
    mocks.settings.mockResolvedValue({
      databaseBackup: 'external',
      enabled: false,
      walArchivingExpected: true,
    });
    expect(await databaseBackupHealthCheck(NOW)).toMatchObject({
      id: 'database-backup',
      status: 'warn',
    });
    mocks.settings.mockResolvedValue({
      databaseBackup: 'external',
      enabled: true,
      walArchivingExpected: false,
    });
    expect(await databaseBackupHealthCheck(NOW)).toMatchObject({ status: 'ok' });
  });

  it('offers the two metrics from the same read, the success time absent when there is none', () => {
    expect(archiverMetricSamples({ ok: true, state: state() }, 'external')).toEqual({
      lastSuccessSeconds: Math.floor(minutesAgo(1)),
      failing: 0,
    });
    expect(
      archiverMetricSamples(
        { ok: true, state: state({ lastFailedAt: minutesAgo(1), lastArchivedAt: minutesAgo(9) }) },
        'external',
      ),
    ).toEqual({ lastSuccessSeconds: Math.floor(minutesAgo(9)), failing: 1 });
    expect(
      archiverMetricSamples(
        { ok: true, state: state({ lastFailedAt: minutesAgo(1), lastArchivedAt: null }) },
        'external',
      ),
    ).toEqual({ lastSuccessSeconds: null, failing: 1 });
    // Nothing is reported in dump mode or when the read failed.
    expect(archiverMetricSamples({ ok: true, state: state() }, 'dump')).toBeNull();
    expect(archiverMetricSamples({ ok: false, reason: 'no' }, 'external')).toBeNull();
  });
});
