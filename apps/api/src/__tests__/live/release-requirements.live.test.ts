import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ReleaseEntry,
  runMigrationsWithLock,
  sql,
  UnfinishedRequirementsError,
  unfinishedRequirements,
} from '@oci/db';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * Finalisation (v0.11 design, section 1): a release may declare, in
 * packages/db/releases.json, that it relies on an earlier release's
 * background migration or post-deploy step. The migrator refuses that
 * release's pre-deploy migrations until the work is finished, naming it, and
 * changes nothing. Before this, the migrator applied them regardless.
 */

const available = await livePostgresAvailable();
const WHEN = 4_100_000_000_000;
const TAG = '9000_relies_on_backfill';

const manifest: ReleaseEntry[] = [
  {
    version: '9.0.0',
    firstMigration: TAG,
    requires: { backgroundMigrations: ['8.9.backfill'], postSteps: ['0099_index'] },
  },
];

describe.skipIf(!available)('live PostgreSQL release requirements', () => {
  let live: LiveDatabase;
  let folder: string;
  let client: postgres.Sql;

  beforeEach(async () => {
    live = await createLiveDatabase('release_requirements');
    client = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    folder = await mkdtemp(join(tmpdir(), 'oci-requirements-'));
    await mkdir(join(folder, 'meta'));
    await writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: WHEN, tag: TAG, breakpoints: true }],
      }),
    );
    await writeFile(join(folder, `${TAG}.sql`), 'CREATE TABLE "requirement_probe" ("id" text);');
  });

  afterEach(async () => {
    await client?.end({ timeout: 1 });
    await rm(folder, { recursive: true, force: true });
    await live?.destroy();
  });

  const migrate = () =>
    runMigrationsWithLock(live.connectionString, {
      migrationsFolder: folder,
      releaseManifest: manifest,
      maxAttempts: 1,
    });

  async function probeExists(): Promise<boolean> {
    const [row] = await live.db.execute<{ found: boolean }>(
      sql`select to_regclass('public.requirement_probe') is not null as found`,
    );
    return row!.found;
  }

  it('refuses a release whose required work is unfinished, naming it, and changes nothing', async () => {
    const refused = await migrate().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnfinishedRequirementsError);
    const message = (refused as Error).message;
    expect(message).toContain('Release 9.0.0 needs earlier work finished');
    expect(message).toContain('background migration "8.9.backfill" (not scheduled)');
    expect(message).toContain('post-deploy step "0099_index" (not applied)');
    expect(message).toContain('Nothing was changed');
    expect(await probeExists()).toBe(false);

    // Started is not finished.
    await live.db.execute(sql`insert into background_migration (name, table_name, batch_size, pause_ms, status)
      values ('8.9.backfill', 'public.message', 100, 0, 'running')`);
    await live.db.execute(sql`insert into oci_post_migration (name, checksum, started_at)
      values ('0099_index', 'x', now())`);
    const still = (await migrate().catch((error: unknown) => error)) as UnfinishedRequirementsError;
    expect(still.unfinished.map((item) => [item.name, item.state])).toEqual([
      ['0099_index', 'started, not finished'],
      ['8.9.backfill', 'running'],
    ]);
    expect(await probeExists()).toBe(false);

    await live.db.execute(sql`update background_migration set status = 'finished'`);
    await live.db.execute(sql`update oci_post_migration set finished_at = now()`);
    await expect(migrate()).resolves.toEqual({ applied: true });
    expect(await probeExists()).toBe(true);
    // Once applied, nothing is pending, so nothing is checked again.
    await live.db.execute(sql`update background_migration set status = 'paused'`);
    await expect(migrate()).resolves.toEqual({ applied: true });
  });

  it('checks nothing for a new database, or for migrations no release requires work for', async () => {
    expect(
      await unfinishedRequirements(client, { migrationsFolder: folder, manifest: [] }),
    ).toEqual([]);
    expect(
      await unfinishedRequirements(client, {
        migrationsFolder: folder,
        manifest: [{ version: '9.0.0', firstMigration: TAG }],
      }),
    ).toEqual([]);
    await client`drop schema drizzle cascade`;
    expect(await unfinishedRequirements(client, { migrationsFolder: folder, manifest })).toEqual(
      [],
    );
  });

  it('names a requirement whose tables an older schema does not have yet', async () => {
    await client`drop table background_migration`;
    await client`drop table oci_post_migration`;
    const unfinished = await unfinishedRequirements(client, { migrationsFolder: folder, manifest });
    expect(unfinished.map((item) => item.state)).toEqual(['not applied', 'not scheduled']);
  });

  it('the bundled manifest requires nothing of this release', async () => {
    expect(await unfinishedRequirements(client)).toEqual([]);
  });
});
