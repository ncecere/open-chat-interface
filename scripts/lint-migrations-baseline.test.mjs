// Tests for scripts/lint-migrations.mjs: the baseline and post-deploy rules.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BP, capture, fixtures, lint, lintPhases } from './lint-migrations.helpers.mjs';
import {
  applyBaseline,
  buildBaseline,
  lintMigrations,
  loadParser,
  main,
  RULES,
  readMigrationsFolder,
} from './lint-migrations.mjs';

before(loadParser);

describe('baseline', () => {
  const folder = join(fixtures, 'folder');
  const baselinePath = join(folder, 'baseline.json');
  let work;

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'oci-lint-migrations-'));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  function copyFolder(name) {
    const target = join(work, name);
    cpSync(folder, target, { recursive: true });
    return target;
  }

  function addMigration(dir, tag, sql) {
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const last = journal.entries.at(-1);
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(dir, `${tag}.sql`), sql);
  }

  it('grandfathers listed violations and passes', async () => {
    const { out, err, io } = capture();
    assert.equal(await main(['--dir', folder, '--baseline', baselinePath], io), 0);
    assert.deepEqual(err, []);
    assert.match(out.join('\n'), /2 grandfathered by the baseline, 0 new violation/);
  });

  it('fails on a new violation, naming the rule, file, statement and fix', async () => {
    const dir = copyFolder('new-violation');
    addMigration(
      dir,
      '0002_new_index',
      `SELECT 1;${BP}CREATE INDEX "message_x_idx" ON "message" ("body");`,
    );
    const { err, io } = capture();
    assert.equal(await main(['--dir', dir, '--baseline', join(dir, 'baseline.json')], io), 1);
    const report = err.join('\n');
    assert.match(report, /0002_new_index\.sql:3 statement 2 \[index-not-concurrent\]/);
    assert.match(report, /fix: Build the index with CREATE INDEX CONCURRENTLY/);
    assert.match(report, /oci:lint-allow index-not-concurrent: <reason>/);
    assert.match(report, /2 grandfathered by the baseline, 1 new violation/);
  });

  it('matches by fingerprint, so an identical statement in a new file is not grandfathered', () => {
    const { violations } = lintMigrations(
      readMigrationsFolder(folder).migrations.concat({
        name: '0002_copy.sql',
        sql: 'CREATE INDEX "message_body_idx" ON "message" ("body");',
      }),
    );
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const { grandfathered, fresh, stale } = applyBaseline(violations, baseline);
    assert.equal(grandfathered.length, 2);
    assert.deepEqual(
      fresh.map((v) => v.file),
      ['0002_copy.sql'],
    );
    assert.deepEqual(stale, []);
  });

  it('fails on a stale entry when a grandfathered migration is edited', async () => {
    const dir = copyFolder('edited');
    writeFileSync(
      join(dir, '0001_legacy_index.sql'),
      'CREATE INDEX "message_body_idx" ON "message" ("id", "body");',
    );
    const { err, io } = capture();
    assert.equal(await main(['--dir', dir, '--baseline', join(dir, 'baseline.json')], io), 1);
    const report = err.join('\n');
    assert.match(report, /stale baseline entry/);
    assert.match(report, /1 new violation/);
  });

  it('never writes the baseline in CI, and writes it locally', async () => {
    const dir = copyFolder('update');
    addMigration(dir, '0002_new_index', 'CREATE INDEX "message_x_idx" ON "message" ("body");');
    const target = join(dir, 'baseline.json');
    const before = readFileSync(target, 'utf8');
    const ci = capture();
    ci.io.env = { CI: 'true' };
    assert.equal(await main(['--dir', dir, '--baseline', target, '--update-baseline'], ci.io), 2);
    assert.match(ci.err.join('\n'), /Refusing to write the migration lint baseline in CI/);
    assert.equal(readFileSync(target, 'utf8'), before);

    const local = capture();
    assert.equal(
      await main(['--dir', dir, '--baseline', target, '--update-baseline'], local.io),
      0,
    );
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).entries.length, 3);
    const rerun = capture();
    assert.equal(await main(['--dir', dir, '--baseline', target], rerun.io), 0);
  });

  it('refuses to baseline input errors', async () => {
    const dir = copyFolder('update-errors');
    addMigration(dir, '0002_broken', 'CREATE TABLE (');
    const { err, io } = capture();
    assert.equal(
      await main(['--dir', dir, '--baseline', join(dir, 'baseline.json'), '--update-baseline'], io),
      1,
    );
    assert.match(err.join('\n'), /\[parse-error\]/);
  });

  it('sorts entries and keeps only file, rule, statement and fingerprint', () => {
    const built = buildBaseline([
      { file: 'b.sql', rule: 'cluster', statement: 1, fingerprint: 'f2', message: 'x', text: 'y' },
      {
        file: 'a.sql',
        rule: 'lock-table',
        statement: 2,
        fingerprint: 'f1',
        message: 'x',
        text: 'y',
      },
    ]);
    assert.deepEqual(built.entries, [
      { file: 'a.sql', rule: 'lock-table', statement: 2, fingerprint: 'f1' },
      { file: 'b.sql', rule: 'cluster', statement: 1, fingerprint: 'f2' },
    ]);
  });
});

describe('post-deploy rules', () => {
  const setup = 'CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text);';
  const rules = (post) => lintPhases([setup], [post]).violations.map((v) => v.rule);
  const errorRules = (pre, post) => lintPhases(pre, post).errors.map((e) => e.rule);

  it('accepts CONCURRENTLY, which pre-deploy cannot run', () => {
    const index = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "t_a_idx" ON "t" ("a");';
    assert.deepEqual(rules(index), []);
    assert.deepEqual(
      lint(setup, index).violations.map((v) => v.rule),
      ['concurrent-in-transaction'],
    );
    assert.deepEqual(rules('REINDEX INDEX CONCURRENTLY "t_a_idx";'), []);
  });

  it('requires CONCURRENTLY for every index: all tables exist by then', () => {
    assert.deepEqual(rules('CREATE INDEX IF NOT EXISTS "t_a_idx" ON "t" ("a");'), [
      'index-not-concurrent',
    ]);
  });

  it('allows a drop only with a reason, and never in pre-deploy', () => {
    const drop = 'ALTER TABLE "t" DROP COLUMN IF EXISTS "a";';
    const allowed = `-- oci:lint-allow drop-column: v0.10 stopped reading a\n${drop}`;
    assert.deepEqual(rules(drop), ['drop-column']);
    assert.deepEqual(rules(allowed), []);
    // The same allow comment in a pre-deploy migration is refused.
    const pre = lint(setup, allowed);
    assert.deepEqual(
      pre.violations.map((v) => v.rule),
      ['drop-column'],
    );
    assert.deepEqual(
      pre.errors.map((e) => e.rule),
      ['allow-not-permitted'],
    );
    assert.match(pre.errors[0].message, /post-deploy step/);
  });

  it('requires idempotent statements', () => {
    assert.deepEqual(rules('DROP INDEX CONCURRENTLY "t_a_idx";'), ['post-not-idempotent']);
    assert.deepEqual(
      rules('-- oci:lint-allow drop-column: unused since v0.10\nALTER TABLE "t" DROP COLUMN "a";'),
      ['post-not-idempotent'],
    );
    assert.deepEqual(rules('ALTER TABLE "t" ADD COLUMN "b" text;'), ['post-not-idempotent']);
    assert.deepEqual(rules('ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "b" text;'), []);
  });

  it('refuses transactions, DO blocks and data changes', () => {
    assert.deepEqual(rules('BEGIN;'), ['post-transaction']);
    assert.deepEqual(rules('COMMIT;'), ['post-transaction']);
    assert.deepEqual(rules('UPDATE "t" SET "a" = \'x\';'), ['data-change']);
    assert.match(RULES['data-change'].hint, /background migration/);
  });

  it('is exactly one statement per step', () => {
    assert.deepEqual(
      errorRules(
        [setup],
        ['ANALYZE "t";\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "t_a_idx" ON "t" ("a");'],
      ),
      ['post-one-statement'],
    );
    assert.deepEqual(errorRules([setup], [`ANALYZE "t";${BP}ANALYZE "t";`]), [
      'post-one-statement',
    ]);
    assert.deepEqual(errorRules([setup], ['-- nothing here\n']), ['post-one-statement']);
  });

  it('points pre-deploy rule hints at post-deploy steps and background migrations', () => {
    for (const rule of [
      'index-not-concurrent',
      'concurrent-in-transaction',
      'constraint-not-valid',
    ]) {
      assert.match(RULES[rule].hint, /post-deploy step \(packages\/db\/post/);
      assert.doesNotMatch(RULES[rule].hint, /coming in v0\.11/);
    }
    for (const rule of ['data-change', 'alter-column-type', 'volatile-default']) {
      assert.match(RULES[rule].hint, /background migration/);
    }
  });
});
