/**
 * Negative controls: deliberately unsafe migrations appended to the new
 * release's bundled migrations, to prove the rolling-upgrade test catches
 * them. Each case is one extra Drizzle migration (SQL file plus journal entry)
 * layered onto the TO API image; nothing in the repository changes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { must, run } from './lib.mjs';

const MIGRATIONS = '/app/packages/db/drizzle';

export const CASES = {
  /** Builds an index on a big table inside the migration transaction: writes to `message` wait. */
  index: {
    summary: 'CREATE INDEX without CONCURRENTLY on message (blocks writes while it builds)',
    expect: 'chat writes stall behind the SHARE lock; latency bound and lock-wait bound fail',
    sql: `CREATE INDEX "upgrade_test_unsafe_idx" ON "message" USING gin (to_tsvector('english', "parts"::text));`,
  },
  /** Drops a column the previous release still selects. */
  'drop-column': {
    summary: 'DROP COLUMN message.web_search_used, which the previous release still reads',
    expect: 'every previous-release read of message fails with 500; smoke on the old release fails',
    sql: 'ALTER TABLE "message" DROP COLUMN "web_search_used";',
  },
  /** Renames a column the previous release still selects. */
  'rename-column': {
    summary: 'RENAME COLUMN thread.pinned, which the previous release still reads',
    expect: 'sidebar and thread reads fail with 500 on the previous release',
    sql: 'ALTER TABLE "thread" RENAME COLUMN "pinned" TO "is_pinned";',
  },
  /**
   * A volatile default forces a rewrite under ACCESS EXCLUSIVE. (`DEFAULT now()`
   * does not: now() is stable, so PostgreSQL 11+ stores it as a fast default.)
   */
  rewrite: {
    summary: 'ADD COLUMN ... NOT NULL DEFAULT clock_timestamp() on message (table rewrite)',
    expect: 'reads and writes of message stall for the rewrite; latency bound fails',
    sql: `ALTER TABLE "message" ADD COLUMN "upgrade_test_seen_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp();`,
  },
  /** An explicit long lock, standing in for any slow step that holds one. */
  lock: {
    summary: 'LOCK TABLE thread IN ACCESS EXCLUSIVE MODE, held for 15 s',
    expect: 'every request touching thread stalls; latency bound fails',
    sql: 'LOCK TABLE "thread" IN ACCESS EXCLUSIVE MODE;\n--> statement-breakpoint\nSELECT pg_sleep(15);',
  },
};

/**
 * Builds `<baseImage>` plus one extra migration as `oci-upgrade-api:inject-<case>`.
 * The journal is read from the base image so the entry follows its newest one.
 */
export async function buildInjectedImage(caseName, baseImage, workDir, log) {
  const injected = CASES[caseName];
  if (!injected)
    throw new Error(`Unknown --inject case "${caseName}". Known: ${Object.keys(CASES).join(', ')}`);
  const journalText = (
    await must(
      run('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'cat',
        baseImage,
        `${MIGRATIONS}/meta/_journal.json`,
      ]),
      'reading the migration journal from the TO image',
    )
  ).stdout;
  const journal = JSON.parse(journalText);
  const last = journal.entries.at(-1);
  const tag = `${String(last.idx + 1).padStart(4, '0')}_upgrade_test_${caseName.replace(/-/g, '_')}`;
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 1000,
    tag,
    breakpoints: true,
  });

  const context = join(workDir, `inject-${caseName}`);
  rmSync(context, { recursive: true, force: true });
  mkdirSync(context, { recursive: true });
  writeFileSync(
    join(context, `${tag}.sql`),
    `-- Negative control (${caseName}): ${injected.summary}\n${injected.sql}\n`,
  );
  writeFileSync(join(context, '_journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(
    join(context, 'Dockerfile'),
    `FROM ${baseImage}\nCOPY ${tag}.sql ${MIGRATIONS}/${tag}.sql\nCOPY _journal.json ${MIGRATIONS}/meta/_journal.json\n`,
  );
  const image = `oci-upgrade-api:inject-${caseName}`;
  await must(run('docker', ['build', '-q', '-t', image, context]), `building ${image}`);
  log?.(`built ${image}: ${tag} — ${injected.summary}`);
  return { image, tag, ...injected };
}
