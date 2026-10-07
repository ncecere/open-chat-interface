#!/usr/bin/env node
// Migration linter (v0.11 design, section 4).
//
// Parses every Drizzle migration with PostgreSQL's own parser (libpg-query,
// compiled to WebAssembly) and fails on statements that lock or rewrite a table
// that already holds data. "Existing" means created by an earlier migration in
// journal order, or not created by any migration at all; a table created
// earlier in the same file is new and empty, so anything goes.
//
// Post-deploy steps (packages/db/post, v0.11 design section 1) are linted
// after every pre-deploy migration, with post-deploy rules: every table
// exists, CONCURRENTLY is required (and possible: steps run outside a
// transaction), a step is exactly one idempotent statement, and drops are
// allowed only here, with a reason.
//
//   pnpm lint:migrations                      lint packages/db/drizzle and packages/db/post
//   pnpm lint:migrations --dir <folder>       lint another Drizzle folder (and --post-dir)
//   pnpm lint:migrations --update-baseline    rewrite the baseline (never in CI)
//
// An exception is a comment directly above the statement:
//   -- oci:lint-allow <rule>: <reason>
// Migrations 0000-0038 predate the linter; their violations are listed in
// scripts/lint-migrations/baseline.json so that only new ones fail.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyBaseline, buildBaseline } from './lint-migrations/baseline.mjs';
import {
  checkReleaseManifest,
  POST_PREFIX,
  readMigrationsFolder,
  readPostFolder,
} from './lint-migrations/folders.mjs';
import { lintMigrations } from './lint-migrations/lint.mjs';
import { META_RULES, RULES } from './lint-migrations/rules.mjs';
import { loadParser } from './lint-migrations/sql.mjs';

export { applyBaseline, buildBaseline } from './lint-migrations/baseline.mjs';
export {
  checkReleaseManifest,
  POST_PREFIX,
  readMigrationsFolder,
  readPostFolder,
} from './lint-migrations/folders.mjs';
export { createSchemaState } from './lint-migrations/inspect.mjs';
export { lintMigrations } from './lint-migrations/lint.mjs';
export { META_RULES, RULES } from './lint-migrations/rules.mjs';
export { allowCommentsAbove, loadParser, splitStatements } from './lint-migrations/sql.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MIGRATIONS_DIR = join(repoRoot, 'packages/db/drizzle');
export const DEFAULT_POST_DIR = join(repoRoot, 'packages/db/post');
export const DEFAULT_RELEASE_MANIFEST = join(repoRoot, 'packages/db/releases.json');
export const DEFAULT_BACKGROUND_DIR = join(repoRoot, 'packages/db/src/background');
export const DEFAULT_BASELINE = join(repoRoot, 'scripts/lint-migrations/baseline.json');

function formatProblem(problem, dir, postDir) {
  const path =
    postDir && problem.file.startsWith(POST_PREFIX)
      ? join(postDir, problem.file.slice(POST_PREFIX.length))
      : join(dir, problem.file);
  const where = `${relative(process.cwd(), path) || problem.file}${problem.line ? `:${problem.line}` : ''}`;
  const statement = problem.statement ? ` statement ${problem.statement}` : '';
  const rule = RULES[problem.rule];
  const lines = [`${where}${statement} [${problem.rule}] ${problem.message}`];
  if (rule) {
    lines.push(`  why: ${rule.summary}.`);
    lines.push(`  fix: ${rule.hint}`);
    lines.push(`  or allow it: -- oci:lint-allow ${problem.rule}: <reason>`);
  } else if (META_RULES[problem.rule]) {
    lines.push(`  ${META_RULES[problem.rule]}.`);
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {
    dir: DEFAULT_MIGRATIONS_DIR,
    postDir: undefined,
    baseline: DEFAULT_BASELINE,
    update: false,
  };
  let dirGiven = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--update-baseline') options.update = true;
    else if (arg === '--dir') {
      options.dir = resolve(argv[++index] ?? '');
      dirGiven = true;
    } else if (arg === '--post-dir') options.postDir = resolve(argv[++index] ?? '');
    else if (arg === '--baseline') options.baseline = resolve(argv[++index] ?? '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  // Another Drizzle folder has no post-deploy steps unless they are named.
  if (options.postDir === undefined && !dirGiven) options.postDir = DEFAULT_POST_DIR;
  return options;
}

/** Runs the linter; returns the exit code. `log`/`error` are injectable for tests. */
export async function main(
  argv,
  { env = process.env, log = console.log, error = console.error } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (failure) {
    error(failure.message);
    return 2;
  }
  if (options.help) {
    log(
      'Usage: node scripts/lint-migrations.mjs [--dir <drizzle folder>] [--post-dir <post-deploy folder>] [--baseline <file>] [--update-baseline]',
    );
    return 0;
  }
  await loadParser();
  const { migrations, errors: journalErrors } = readMigrationsFolder(options.dir);
  const post = options.postDir ? readPostFolder(options.postDir) : { migrations: [], errors: [] };
  const result = lintMigrations([...migrations, ...post.migrations]);
  const errors = [...journalErrors, ...post.errors, ...result.errors];
  if (options.postDir === DEFAULT_POST_DIR && existsSync(DEFAULT_RELEASE_MANIFEST)) {
    const backgroundSource = readdirSync(DEFAULT_BACKGROUND_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(DEFAULT_BACKGROUND_DIR, name), 'utf8'))
      .join('\n');
    errors.push(
      ...checkReleaseManifest({
        manifest: JSON.parse(readFileSync(DEFAULT_RELEASE_MANIFEST, 'utf8')),
        migrations: migrations.map((migration) => migration.name),
        postSteps: post.migrations.map((step) => step.name.slice(POST_PREFIX.length, -4)),
        backgroundSource,
      }),
    );
  }
  const format = (problem) => formatProblem(problem, options.dir, options.postDir);

  if (options.update) {
    if (env.CI) {
      error(
        'Refusing to write the migration lint baseline in CI. Run --update-baseline locally and commit the result.',
      );
      return 2;
    }
    if (errors.length) {
      for (const problem of errors) error(format(problem));
      error('Fix the errors above before updating the baseline.');
      return 1;
    }
    writeFileSync(
      options.baseline,
      `${JSON.stringify(buildBaseline(result.violations), null, 2)}\n`,
    );
    log(
      `Wrote ${result.violations.length} baseline entries to ${relative(process.cwd(), options.baseline)}.`,
    );
    return 0;
  }

  const baseline = existsSync(options.baseline)
    ? JSON.parse(readFileSync(options.baseline, 'utf8'))
    : { entries: [] };
  const { grandfathered, fresh, stale } = applyBaseline(result.violations, baseline);
  for (const problem of [...errors, ...fresh]) error(`${format(problem)}\n`);
  for (const entry of stale) {
    error(
      `${entry.file} statement ${entry.statement} [${entry.rule}] stale baseline entry: no matching violation. ` +
        'Migrations that have shipped must not change; if this is intended, run --update-baseline locally.\n',
    );
  }
  const failed = errors.length + fresh.length + stale.length;
  const postSummary = options.postDir
    ? ` and ${post.migrations.length} post-deploy step(s) in ${relative(process.cwd(), options.postDir) || basename(options.postDir)}`
    : '';
  const summary =
    `Checked ${migrations.length} migrations (${result.statementCount} statements) in ` +
    `${relative(process.cwd(), options.dir) || basename(options.dir)}${postSummary}: ` +
    `${grandfathered.length} grandfathered by the baseline, ${fresh.length} new violation(s), ` +
    `${errors.length} error(s), ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'}.`;
  (failed ? error : log)(summary);
  if (failed) {
    error(
      'See docs/dev/database.md, "Migration linter", for the rules and how to allow an exception.',
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
