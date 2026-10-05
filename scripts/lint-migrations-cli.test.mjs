// Tests for scripts/lint-migrations.mjs: the post-deploy folder, the release manifest, and the journal and command line.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { capture, fixtures } from './lint-migrations.helpers.mjs';
import {
  checkReleaseManifest,
  loadParser,
  main,
  parseArgs,
  readMigrationsFolder,
  readPostFolder,
} from './lint-migrations.mjs';

before(loadParser);

describe('post-deploy folder', () => {
  let work;
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'oci-lint-post-'));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  function postFolder(name, steps, extra = {}) {
    const dir = join(work, name);
    cpSync(join(fixtures, 'folder'), join(dir, 'drizzle'), { recursive: true });
    const post = join(dir, 'post');
    mkdirSync(post, { recursive: true });
    writeFileSync(
      join(post, 'journal.json'),
      JSON.stringify({
        steps: Object.keys(steps).map((tag, idx) => ({ idx, tag, release: '0.11.0' })),
      }),
    );
    for (const [tag, sql] of Object.entries({ ...steps, ...extra })) {
      if (sql !== null) writeFileSync(join(post, `${tag}.sql`), sql);
    }
    return dir;
  }

  const args = (dir) => [
    '--dir',
    join(dir, 'drizzle'),
    '--post-dir',
    join(dir, 'post'),
    '--baseline',
    join(dir, 'drizzle', 'baseline.json'),
  ];

  it('lints steps after every pre-deploy migration and passes clean ones', async () => {
    const dir = postFolder('clean', {
      '0001_index': 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_id_idx" ON "message" ("id");',
      '0002_drop':
        '-- oci:lint-allow drop-column: the previous release no longer reads it\nALTER TABLE "message" DROP COLUMN IF EXISTS "body";',
    });
    const { out, err, io } = capture();
    assert.equal(await main(args(dir), io), 0, err.join('\n'));
    assert.match(out.join('\n'), /and 2 post-deploy step\(s\)/);
  });

  it('fails a bad step, naming its file under the post folder', async () => {
    const dir = postFolder('bad', { '0001_drop': 'ALTER TABLE "message" DROP COLUMN "body";' });
    const { err, io } = capture();
    assert.equal(await main(args(dir), io), 1);
    const text = err.join('\n');
    assert.match(text, /post\/0001_drop\.sql:1 statement 1 \[drop-column\]/);
    assert.match(text, /\[post-not-idempotent\]/);
    assert.match(text, /previous release no longer reads it/);
  });

  it('checks the journal against the files', () => {
    const dir = postFolder(
      'journal',
      { '0001_ok': 'ANALYZE "message";', '0002_missing': null },
      { '0003_orphan': 'ANALYZE "message";' },
    );
    const { migrations, errors } = readPostFolder(join(dir, 'post'));
    assert.deepEqual(
      migrations.map((m) => [m.name, m.phase]),
      [['post/0001_ok.sql', 'post']],
    );
    assert.deepEqual(
      errors.map((e) => [e.rule, e.file]),
      [
        ['journal', 'post/0002_missing.sql'],
        ['journal', 'post/0003_orphan.sql'],
      ],
    );
    assert.deepEqual(readPostFolder(join(work, 'nowhere')), { migrations: [], errors: [] });
  });

  it('lints only the Drizzle folder given with --dir unless --post-dir is given', () => {
    assert.equal(parseArgs(['--dir', 'x']).postDir, undefined);
    assert.match(parseArgs([]).postDir, /packages\/db\/post$/);
  });
});

describe('release manifest', () => {
  const input = (releases) => ({
    manifest: { releases },
    migrations: ['0000_a.sql', '0001_b.sql', '0002_c.sql'],
    postSteps: ['0001_index'],
    backgroundSource: "export const x = { name: '0.11.backfill' };",
  });

  it('accepts releases that start at real migrations and require real work', () => {
    assert.deepEqual(
      checkReleaseManifest(
        input([
          { version: '0.1.0', firstMigration: '0000_a' },
          {
            version: '0.2.0',
            firstMigration: '0002_c',
            requires: { postSteps: ['0001_index'], backgroundMigrations: ['0.11.backfill'] },
          },
        ]),
      ),
      [],
    );
  });

  it('reports unknown migrations, misordered releases and missing requirements', () => {
    const errors = checkReleaseManifest(
      input([
        { version: '0.1.0', firstMigration: '0001_b' },
        { version: '0.2.0', firstMigration: '0000_a' },
        { version: '0.3.0', firstMigration: '9999_none' },
        {
          version: '0.4.0',
          firstMigration: '0002_c',
          requires: { postSteps: ['0009_gone'], backgroundMigrations: ['0.9.gone'] },
        },
      ]),
    );
    assert.deepEqual(
      errors.map((error) => error.message),
      [
        'Release 0.2.0 does not start after the release before it.',
        'Release 0.3.0 starts at 9999_none, which is not in the journal.',
        'Release 0.4.0 requires post-deploy step 0009_gone, which is not in post/journal.json.',
        'Release 0.4.0 requires background migration 0.9.gone, which no definition in packages/db/src/background names.',
      ],
    );
    assert.ok(errors.every((error) => error.rule === 'release-manifest'));
  });
});

describe('journal and command line', () => {
  let work;
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'oci-lint-journal-'));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  it('reports files missing from the journal and journal entries without files', async () => {
    const dir = join(work, 'journal');
    cpSync(join(fixtures, 'folder'), dir, { recursive: true });
    writeFileSync(join(dir, '0002_orphan.sql'), 'SELECT 1;');
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries.push({ ...journal.entries[1], idx: 5, tag: '0003_missing' });
    writeFileSync(journalPath, JSON.stringify(journal));
    const { errors } = readMigrationsFolder(dir);
    assert.deepEqual(
      errors.map((error) => [error.rule, error.file]),
      [
        ['journal', 'meta/_journal.json'],
        ['journal', '0003_missing.sql'],
        ['journal', '0002_orphan.sql'],
      ],
    );
    const { io } = capture();
    assert.equal(await main(['--dir', dir, '--baseline', join(dir, 'baseline.json')], io), 1);
  });

  it('parses arguments and rejects unknown ones', async () => {
    assert.equal(parseArgs(['--update-baseline']).update, true);
    assert.equal(parseArgs(['--help']).help, true);
    const { err, io } = capture();
    assert.equal(await main(['--frobnicate'], io), 2);
    assert.match(err.join('\n'), /Unknown argument/);
    const help = capture();
    assert.equal(await main(['--help'], help.io), 0);
    assert.match(help.out.join('\n'), /Usage/);
  });

  it('passes on the repository migrations with the committed baseline', async () => {
    const { out, err, io } = capture();
    assert.equal(await main([], io), 0, err.join('\n'));
    assert.match(
      out.join('\n'),
      /grandfathered by the baseline, 0 new violation\(s\), 0 error\(s\), 0 stale/,
    );
  });
});
