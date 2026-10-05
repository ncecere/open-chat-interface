// Tests for scripts/lint-migrations.mjs: rule fixtures, more rule cases, existing-table tracking and allow comments.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { BP, fixtures, lint, readFixture } from './lint-migrations.helpers.mjs';
import {
  allowCommentsAbove,
  lintMigrations,
  loadParser,
  RULES,
  splitStatements,
} from './lint-migrations.mjs';

before(loadParser);

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
