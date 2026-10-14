import { postStepStates, runPostMigrations, sql } from '@oci/db';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';

/**
 * Tables a release stops using are dropped by a later release's post-deploy
 * step, once every replica runs a release that no longer reads them
 * (docs/dev/database.md). v0.11 replaced `project_file_embedding_failure`
 * with `embedding_generation_failure`; v0.12.1 drops it (step 0013).
 *
 * Runs the real, bundled steps against a database migrated by the real
 * pre-deploy migrations, which still create the table.
 */

const available = await livePostgresAvailable();
const quiet = { info: () => {}, warn: () => {} };

async function tableExists(live: LiveDatabase, name: string): Promise<boolean> {
  const [row] = await live.db.execute<{ found: boolean }>(
    sql`select to_regclass(${`public.${name}`}) is not null as found`,
  );
  return row?.found === true;
}

describe.skipIf(!available)('live: tables dropped by post-deploy steps', () => {
  let live: LiveDatabase;

  beforeEach(async () => {
    live = await createLiveDatabase('post_deploy_drops');
  });

  afterEach(async () => {
    await live?.destroy();
  });

  it('drops project_file_embedding_failure once, and leaves its replacement', async () => {
    // Created by migration 0029; the pre-deploy migrations never drop it.
    expect(await tableExists(live, 'project_file_embedding_failure')).toBe(true);

    await runPostMigrations(live.connectionString, { logger: quiet, backgroundMigrations: [] });

    expect(await tableExists(live, 'project_file_embedding_failure')).toBe(false);
    expect(await tableExists(live, 'embedding_generation_failure')).toBe(true);
    const client = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    try {
      const states = await postStepStates(client);
      expect(
        states.find((step) => step.name === '0013_drop_project_file_embedding_failure'),
      ).toMatchObject({ state: 'finished', release: '0.12.1', attempts: 1 });
    } finally {
      await client.end({ timeout: 1 });
    }

    // A second run repeats nothing and does not fail.
    const again = await runPostMigrations(live.connectionString, {
      logger: quiet,
      backgroundMigrations: [],
    });
    expect(again.steps.filter((step) => step.outcome === 'applied')).toEqual([]);
  });

  it('is idempotent when the table is already gone', async () => {
    await live.db.execute(sql`drop table project_file_embedding_failure`);
    await expect(
      runPostMigrations(live.connectionString, { logger: quiet, backgroundMigrations: [] }),
    ).resolves.toBeDefined();
    expect(await tableExists(live, 'project_file_embedding_failure')).toBe(false);
  });

  it('drops the optional folded message index v0.12 let an operator build, and only that one (0015)', async () => {
    const client = postgres(live.connectionString, { max: 1, onnotice: () => {} });
    const indexes = async () =>
      (
        await client<{ name: string }[]>`
          select indexname as name from pg_indexes
          where tablename = 'message' and indexname in
            ('message_text_search_folded_idx', 'message_text_search_idx', 'message_search_folded_idx')
          order by indexname`
      ).map((row) => row.name);
    try {
      // What an operator ran, outside any transaction (the v0.12 optional file's index).
      await client
        .unsafe(
          `create index concurrently "message_text_search_folded_idx" on message using gin (to_tsvector('simple'::regconfig, parts::text))`,
        )
        .simple();
      expect(await indexes()).toEqual([
        'message_text_search_folded_idx',
        'message_text_search_idx',
      ]);
      await runPostMigrations(live.connectionString, { logger: quiet, backgroundMigrations: [] });
      // Gone; the exact index and step 0014's index are untouched.
      expect(await indexes()).toEqual(['message_search_folded_idx', 'message_text_search_idx']);
    } finally {
      await client.end({ timeout: 1 });
    }
  });
});
