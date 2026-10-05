/**
 * Helpers shared by the lint-migrations test files: SQL builders, fixture
 * reading and output capture.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintMigrations } from './lint-migrations.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const fixtures = join(here, 'lint-migrations', 'fixtures');
export const BP = '\n--> statement-breakpoint\n';

/** Lints migrations given as SQL strings, named 0000_m0.sql, 0001_m1.sql, ... */
export function lint(...sqls) {
  return lintMigrations(
    sqls.map((sql, index) => ({ name: `${String(index).padStart(4, '0')}_m${index}.sql`, sql })),
  );
}

/** Lints pre-deploy migrations, then post-deploy steps (`post/0000_p0.sql`, ...). */
export function lintPhases(pre, post) {
  return lintMigrations([
    ...pre.map((sql, index) => ({ name: `${String(index).padStart(4, '0')}_m${index}.sql`, sql })),
    ...post.map((sql, index) => ({
      name: `post/${String(index).padStart(4, '0')}_p${index}.sql`,
      sql,
      phase: 'post',
    })),
  ]);
}

export function readFixture(rule) {
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

export function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: { log: (line) => out.push(line), error: (line) => err.push(line), env: {} },
  };
}
