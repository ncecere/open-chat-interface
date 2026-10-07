// Migration linter inputs: Drizzle and post-deploy folders, and the release manifest.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads a Drizzle folder in journal order and checks journal/file agreement. */
export function readMigrationsFolder(dir) {
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const migrations = [];
  const errors = [];
  journal.entries.forEach((entry, index) => {
    if (entry.idx !== index) {
      errors.push({
        rule: 'journal',
        file: 'meta/_journal.json',
        message: `Entry ${index} (${entry.tag}) has idx ${entry.idx}; indexes must be sequential.`,
      });
    }
    const name = `${entry.tag}.sql`;
    const path = join(dir, name);
    if (!existsSync(path)) {
      errors.push({
        rule: 'journal',
        file: name,
        message: `Journal entry ${entry.tag} has no file.`,
      });
      return;
    }
    migrations.push({ name, sql: readFileSync(path, 'utf8') });
  });
  const listed = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    if (!listed.has(name)) {
      errors.push({
        rule: 'journal',
        file: name,
        message: `${name} is not in meta/_journal.json, so the migrator will never run it.`,
      });
    }
  }
  return { migrations, errors };
}

/** Prefix of post-deploy step names in reports and the baseline. */
export const POST_PREFIX = 'post/';

/**
 * Reads a post-deploy folder (`journal.json` listing `NNNN_name.sql` files) in
 * journal order, as `{ name: 'post/<file>', sql, phase: 'post' }`, and checks
 * the journal and files agree. A missing folder has no steps.
 */
export function readPostFolder(dir) {
  const journalPath = join(dir, 'journal.json');
  if (!existsSync(journalPath)) return { migrations: [], errors: [] };
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const migrations = [];
  const errors = [];
  (journal.steps ?? []).forEach((entry, index) => {
    if (entry.idx !== index) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}journal.json`,
        message: `Step ${index} (${entry.tag}) has idx ${entry.idx}; indexes must be sequential.`,
      });
    }
    if (!entry.release) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}journal.json`,
        message: `Step ${entry.tag} names no release.`,
      });
    }
    const name = `${entry.tag}.sql`;
    if (!existsSync(join(dir, name))) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}${name}`,
        message: `Post-deploy journal entry ${entry.tag} has no file.`,
      });
      return;
    }
    migrations.push({
      name: `${POST_PREFIX}${name}`,
      sql: readFileSync(join(dir, name), 'utf8'),
      phase: 'post',
    });
  });
  const listed = new Set((journal.steps ?? []).map((entry) => `${entry.tag}.sql`));
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    if (!listed.has(name)) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}${name}`,
        message: `${name} is not in journal.json, so \`migrate --post\` will never run it.`,
      });
    }
  }
  return { migrations, errors };
}

/**
 * Checks packages/db/releases.json against what exists: each release's first
 * migration is in the journal, in release order, and every required
 * post-deploy step is in the post journal and every required background
 * migration is a name defined in packages/db/src/background.
 */
export function checkReleaseManifest({ manifest, migrations, postSteps, backgroundSource }) {
  const errors = [];
  const fail = (message) =>
    errors.push({ rule: 'release-manifest', file: '../releases.json', message });
  const position = new Map(migrations.map((name, index) => [name.replace(/\.sql$/, ''), index]));
  let previous = -1;
  for (const release of manifest.releases ?? []) {
    const at = position.get(release.firstMigration);
    if (at === undefined) {
      fail(
        `Release ${release.version} starts at ${release.firstMigration}, which is not in the journal.`,
      );
      continue;
    }
    if (at <= previous)
      fail(`Release ${release.version} does not start after the release before it.`);
    previous = at;
    for (const step of release.requires?.postSteps ?? []) {
      if (!postSteps.includes(step)) {
        fail(
          `Release ${release.version} requires post-deploy step ${step}, which is not in post/journal.json.`,
        );
      }
    }
    for (const name of release.requires?.backgroundMigrations ?? []) {
      if (!backgroundSource.includes(`'${name}'`)) {
        fail(
          `Release ${release.version} requires background migration ${name}, which no definition in packages/db/src/background names.`,
        );
      }
    }
  }
  return errors;
}
