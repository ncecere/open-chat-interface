import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allowCommentsAbove,
  applyBaseline,
  buildBaseline,
  checkReleaseManifest,
  lintMigrations,
  loadParser,
  main,
  parseArgs,
  RULES,
  readMigrationsFolder,
  readPostFolder,
  splitStatements,
} from './lint-migrations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'lint-migrations', 'fixtures');
const BP = '\n--> statement-breakpoint\n';

before(loadParser);

/** Lints migrations given as SQL strings, named 0000_m0.sql, 0001_m1.sql, ... */
function lint(...sqls) {
  return lintMigrations(
    sqls.map((sql, index) => ({ name: `${String(index).padStart(4, '0')}_m${index}.sql`, sql })),
  );
}

/** Lints pre-deploy migrations, then post-deploy steps (`post/0000_p0.sql`, ...). */
function lintPhases(pre, post) {
  return lintMigrations([
    ...pre.map((sql, index) => ({ name: `${String(index).padStart(4, '0')}_m${index}.sql`, sql })),
    ...post.map((sql, index) => ({
      name: `post/${String(index).padStart(4, '0')}_p${index}.sql`,
      sql,
      phase: 'post',
    })),
  ]);
}

function readFixture(rule) {
  const text = readFileSync(join(fixtures, 'rules', `${rule}.sql`), 'utf8');
  const sections = { phase: 'pre' };
  let current;
  for (const line of text.split('\n')) {
    const marker = line.match(/^-- fixture: ([a-z-]+)$/);
    const phase = line.match(/^-- fixture-phase: (pre|post)$/);
    if (phase && !current) {
      sections.phase = phase[1];
    } else if (marker) {
      current = marker[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(
    Object.entries(sections).map(([name, lines]) => [
      name,
      Array.isArray(lines) ? lines.join('\n').trim() : lines,
    ]),
  );
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: { log: (line) => out.push(line), error: (line) => err.push(line), env: {} },
  };
}

describe('rule fixtures', () => {
  const ruleFiles = readdirSync(join(fixtures, 'rules')).map((name) => name.replace(/\.sql$/, ''));

  it('has a fixture for every rule', () => {
    assert.deepEqual([...ruleFiles].sort(), Object.keys(RULES).sort());
  });

  for (const rule of Object.keys(RULES)) {
    describe(rule, () => {
      const fixture = readFixture(rule);
      const run = (section) => {
        assert.ok(fixture[section], `${rule}.sql needs a "${section}" section`);
        // A post-deploy fixture lints its sections as post-deploy step 1 (as
        // 0001_m1.sql, so the assertions below read the same for both).
        const result = lintMigrations([
          { name: '0000_m0.sql', sql: fixture.setup },
          { name: '0001_m1.sql', sql: fixture[section], phase: fixture.phase },
        ]);
        assert.deepEqual(
          result.violations.filter((v) => v.file === '0000_m0.sql'),
          [],
          'setup must be clean',
        );
        return result;
      };

      it('bad: reports the rule with its file, statement and a fix hint', () => {
        const { violations, errors } = run('bad');
        assert.deepEqual(errors, []);
        assert.ok(violations.length > 0, 'expected a violation');
        for (const violation of violations) {
          assert.equal(violation.rule, rule);
          assert.equal(violation.file, '0001_m1.sql');
          assert.equal(violation.statement, 1);
          assert.match(violation.fingerprint, /^[0-9a-f]{16}$/);
        }
        assert.ok(RULES[rule].hint.length > 20);
      });

      it('good: passes', () => {
        const { violations, errors } = run('good');
        assert.deepEqual(violations, []);
        assert.deepEqual(errors, []);
      });

      it('allowed with a reason: passes', () => {
        const { violations, errors } = run('allowed');
        assert.deepEqual(violations, []);
        assert.deepEqual(errors, []);
      });

      it('allowed without a reason: still fails, plus an error for the comment', () => {
        const { violations, errors } = run('missing-reason');
        assert.ok(violations.some((violation) => violation.rule === rule));
        assert.deepEqual(
          errors.map((error) => error.rule),
          ['allow-missing-reason'],
        );
      });
    });
  }
});

describe('more rule cases', () => {
  const setup = 'CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text);';
  const rules = (...sqls) => lint(...sqls).violations.map((violation) => violation.rule);

  it('flags every kind of data change on existing tables but not seed rows', () => {
    assert.deepEqual(rules(setup, 'DELETE FROM "t"'), ['data-change']);
    assert.deepEqual(rules(setup, 'TRUNCATE "t"'), ['data-change']);
    assert.deepEqual(rules(setup, "INSERT INTO \"t\" SELECT 'x', 'y'"), ['data-change']);
    assert.deepEqual(
      rules(
        setup,
        'MERGE INTO "t" USING (SELECT 1 AS id) s ON false WHEN NOT MATCHED THEN DO NOTHING',
      ),
      ['data-change'],
    );
    assert.deepEqual(rules(setup, 'INSERT INTO "t" ("id") VALUES (\'seed\')'), []);
    assert.deepEqual(rules(setup, 'INSERT INTO "t" DEFAULT VALUES'), []);
  });

  it('flags serial, identity, generated and CURRENT_TIMESTAMP columns added to existing tables', () => {
    assert.deepEqual(rules(setup, 'ALTER TABLE "t" ADD COLUMN "n" bigserial'), [
      'volatile-default',
    ]);
    assert.deepEqual(
      rules(setup, 'ALTER TABLE "t" ADD COLUMN "n" integer GENERATED ALWAYS AS IDENTITY'),
      ['volatile-default'],
    );
    assert.deepEqual(
      rules(setup, 'ALTER TABLE "t" ADD COLUMN "n" integer GENERATED ALWAYS AS (length(a)) STORED'),
      ['volatile-default'],
    );
    assert.deepEqual(
      rules(setup, 'ALTER TABLE "t" ADD COLUMN "at" timestamptz DEFAULT CURRENT_TIMESTAMP'),
      ['volatile-default'],
    );
    assert.deepEqual(rules(setup, 'ALTER TABLE "t" ADD COLUMN "n" integer DEFAULT 1 + 2'), []);
  });

  it('flags inline constraints on columns added to existing tables', () => {
    const u = `${setup}${BP}CREATE TABLE "u" ("id" text PRIMARY KEY);`;
    assert.deepEqual(rules(u, 'ALTER TABLE "t" ADD COLUMN "u_id" text REFERENCES "u"("id")'), [
      'constraint-not-valid',
    ]);
    assert.deepEqual(rules(u, 'ALTER TABLE "t" ADD COLUMN "code" text UNIQUE'), [
      'unique-constraint',
    ]);
    assert.deepEqual(rules(u, 'ALTER TABLE "t" ADD CONSTRAINT "t_pk2" PRIMARY KEY ("a")'), [
      'unique-constraint',
    ]);
  });

  it('accepts SET NOT NULL only after a validated IS NOT NULL check', () => {
    const notValid = 'ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("a" IS NOT NULL) NOT VALID';
    const setNotNull = 'ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL';
    // Not yet validated: still a full scan.
    assert.deepEqual(rules(setup, notValid, setNotNull), ['set-not-null']);
    // Validated in an earlier migration.
    assert.deepEqual(
      rules(setup, `${notValid}${BP}ALTER TABLE "t" VALIDATE CONSTRAINT "c"`, setNotNull),
      [],
    );
    // A check on another column does not count; a dropped check no longer counts.
    assert.deepEqual(
      rules(
        setup,
        `${notValid}${BP}ALTER TABLE "t" VALIDATE CONSTRAINT "c"${BP}ALTER TABLE "t" DROP CONSTRAINT "c"`,
        setNotNull,
      ),
      ['set-not-null'],
    );
    assert.deepEqual(
      rules(
        `CREATE TABLE "t" ("id" text, "a" text, "b" text, CONSTRAINT "cb" CHECK ("b" IS NOT NULL))`,
        setNotNull,
      ),
      ['set-not-null'],
    );
    // A check created with its table is validated.
    assert.deepEqual(
      rules(
        `CREATE TABLE "t" ("id" text, "a" text, CONSTRAINT "ca" CHECK ("a" IS NOT NULL))`,
        setNotNull,
      ),
      [],
    );
  });

  it('treats REINDEX like CREATE INDEX', () => {
    const withIndex = `${setup}${BP}CREATE INDEX "t_a_idx" ON "t" ("a")`;
    assert.deepEqual(rules(withIndex, 'REINDEX INDEX "t_a_idx"'), ['index-not-concurrent']);
    assert.deepEqual(rules(withIndex, 'REINDEX TABLE "t"'), ['index-not-concurrent']);
    assert.deepEqual(rules(withIndex, 'REINDEX INDEX CONCURRENTLY "t_a_idx"'), [
      'concurrent-in-transaction',
    ]);
    assert.deepEqual(
      rules(`${setup}${BP}CREATE INDEX "t_a_idx" ON "t" ("a")${BP}REINDEX INDEX "t_a_idx"`),
      [],
    );
  });

  it('checks the statements inside DO blocks, including nested blocks', () => {
    const block = `DO $$ BEGIN
      IF true THEN UPDATE "t" SET "a" = 'x'; END IF;
      CREATE INDEX "t_a_idx" ON "t" ("a");
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
    const { violations } = lint(setup, block);
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      ['data-change', 'index-not-concurrent'],
    );
    assert.match(violations[0].message, /inside a DO block/);
    assert.equal(violations[0].statement, 1);
  });
});

describe('existing-table tracking', () => {
  const index = (table) => `CREATE INDEX "${table}_idx" ON ${table} ("id")`;
  const flagged = (result) => result.violations.map((v) => `${v.file}#${v.statement}`);

  it('treats a table created earlier in the same file as new', () => {
    assert.deepEqual(flagged(lint(`CREATE TABLE t (id text)${BP}${index('t')}`)), []);
  });

  it('treats a table created by an earlier migration file as existing', () => {
    const result = lint('CREATE TABLE t (id text)', index('t'));
    assert.deepEqual(flagged(result), ['0001_m1.sql#1']);
    assert.match(
      result.violations[0].message,
      /existing table public\.t \(created in 0000_m0\.sql\)/,
    );
  });

  it('does not make an existing table new with CREATE TABLE IF NOT EXISTS', () => {
    const result = lint(
      'CREATE TABLE t (id text)',
      `CREATE TABLE IF NOT EXISTS t (id text)${BP}${index('t')}`,
    );
    assert.deepEqual(flagged(result), ['0001_m1.sql#2']);
  });

  it('assumes a table no migration created exists (runtime-created or external)', () => {
    const result = lint(index('elsewhere'));
    assert.deepEqual(flagged(result), ['0000_m0.sql#1']);
    assert.match(result.violations[0].message, /not created by an earlier migration/);
  });

  it('follows renames, drops and schema qualification', () => {
    // Renamed in the file that created it: still new.
    assert.deepEqual(
      flagged(lint(`CREATE TABLE a (id text)${BP}ALTER TABLE a RENAME TO b${BP}${index('b')}`)),
      [],
    );
    // Renamed later: the new name is existing.
    assert.deepEqual(
      flagged(lint('CREATE TABLE a (id text)', `ALTER TABLE a RENAME TO b${BP}${index('b')}`)),
      ['0001_m1.sql#2'],
    );
    // Dropped and recreated in a later file: new again (the drop itself is flagged).
    const recreated = lint(
      'CREATE TABLE a (id text)',
      `DROP TABLE a${BP}CREATE TABLE a (id text)${BP}${index('a')}`,
    );
    assert.deepEqual(
      recreated.violations.map((v) => v.rule),
      ['drop-table'],
    );
    // "public"."a" and a are the same table; other schemas are distinct.
    assert.deepEqual(
      flagged(lint('CREATE TABLE a (id text)', 'CREATE INDEX x ON "public"."a" (id)')),
      ['0001_m1.sql#1'],
    );
    assert.deepEqual(
      flagged(lint(`CREATE TABLE app.a (id text)${BP}CREATE INDEX x ON app.a (id)`)),
      [],
    );
  });

  it('numbers statements across breakpoints and within a chunk, with lines', () => {
    const sql = `-- Comment with UTF-8: café — ✓\nCREATE TABLE n (id text); CREATE TABLE m (id text);${BP}\n\n${index('t')};`;
    const { statements } = splitStatements(sql);
    assert.equal(statements.length, 3);
    assert.equal(statements[1].text, 'CREATE TABLE m (id text)');
    const result = lint('CREATE TABLE t (id text)', sql);
    assert.deepEqual(
      result.violations.map((v) => [v.statement, v.line]),
      [[3, 6]],
    );
  });

  it('reports a statement PostgreSQL cannot parse as an error', () => {
    const { errors } = lint(`CREATE TABLE ok (id text)${BP}CREATE TABLE broken (`);
    assert.deepEqual(
      errors.map((error) => [error.rule, error.line]),
      [['parse-error', 3]],
    );
  });
});

describe('allow comments', () => {
  const setup = 'CREATE TABLE t (id text)';
  const bad = 'CREATE INDEX t_idx ON t (id)';
  const allow = '-- oci:lint-allow index-not-concurrent: tiny table';

  it('apply only to the statement directly below them', () => {
    assert.deepEqual(lint(setup, `${allow}\n-- more context\n${bad}`).violations, []);
    // A blank line separates the comment from the statement.
    assert.equal(lint(setup, `${allow}\n\n${bad}`).violations.length, 1);
    // The next statement is not covered.
    const result = lint(setup, `${allow}\n${bad};\nCREATE INDEX t_idx2 ON t (id);`);
    assert.deepEqual(
      result.violations.map((v) => v.statement),
      [2],
    );
  });

  it('may sit above the statement-breakpoint marker', () => {
    assert.deepEqual(
      lint(setup, `SELECT 1;\n${allow}\n--> statement-breakpoint\n${bad}`).violations,
      [],
    );
  });

  it('report unknown rules and unused exceptions', () => {
    const unknown = lint(setup, `-- oci:lint-allow no-such-rule: because\n${bad}`);
    assert.deepEqual(
      unknown.errors.map((e) => e.rule),
      ['allow-unknown-rule'],
    );
    assert.equal(unknown.violations.length, 1);
    const unused = lint(setup, `-- oci:lint-allow drop-table: not needed\n${bad}`);
    assert.deepEqual(
      unused.errors.map((e) => e.rule),
      ['allow-unused'],
    );
  });

  it('are read from the comment run above the line', () => {
    const sql = `-- a\n-- oci:lint-allow lock-table: x\n-- oci:lint-allow  cluster :  y z \nLOCK TABLE t`;
    assert.deepEqual(
      allowCommentsAbove(sql, sql.indexOf('LOCK')).map(({ rule, reason }) => [rule, reason]),
      [
        ['lock-table', 'x'],
        ['cluster', 'y z'],
      ],
    );
    // Code before the statement on the same line belongs to another statement.
    const sameLine = `${allow}\nSELECT 1; ${bad}`;
    assert.deepEqual(allowCommentsAbove(sameLine, sameLine.indexOf('CREATE')), []);
  });

  it('cover the statements inside a DO block below them', () => {
    const block = `${allow}\nDO $$ BEGIN CREATE INDEX t_idx ON t (id); END $$;`;
    assert.deepEqual(lint(setup, block).violations, []);
  });
});

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
