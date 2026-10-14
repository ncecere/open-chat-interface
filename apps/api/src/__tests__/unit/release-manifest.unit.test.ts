import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseOf } from '@oci/db';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../version.js';

/**
 * `packages/db/releases.json` names the first pre-deploy migration of every
 * minor release; the upgrade preflight reads the release a database is at
 * from it. v0.13.0 shipped without an entry for 0.12.0 or for itself: a
 * database at migration 0046 then read as "0.11.0", two minors behind, and the
 * preflight told every v0.12 operator that the upgrade needs a window. Nothing
 * failed, so nothing noticed. This keeps the file in step with the code.
 */
const read = (path: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../../../packages/db/${path}`, import.meta.url)),
      'utf8',
    ),
  );
const manifest: Parameters<typeof releaseOf>[2] = read('releases.json').releases;
const journal: Parameters<typeof releaseOf>[1] = read('drizzle/meta/_journal.json').entries;
const position = new Map(journal.map((entry) => [entry.tag, entry.idx]));
const minorOf = (version: string) => version.split('.').slice(0, 2).join('.');

describe('the release manifest (packages/db/releases.json)', () => {
  it('names the minor release this code is, so a database at its latest migration reads as it', () => {
    const current = `${minorOf(APP_VERSION)}.0`;
    expect(manifest.map((release) => release.version)).toContain(current);
    const latest = journal.at(-1)!.tag;
    expect(releaseOf(latest, journal, manifest)?.version).toBe(current);
  });

  it('reads a v0.12 database as 0.12.0 and the v0.13 migrations as 0.13.0 (the preflight case that failed)', () => {
    const at = (tag: string) => releaseOf(tag, journal, manifest)?.version;
    expect(at('0045_shared_attachment_objects')).toBe('0.11.0');
    expect(at('0046_invitation_emailed_at')).toBe('0.12.0');
    expect(at('0047_fold_search_text')).toBe('0.13.0');
    expect(at('0049_project_file_chunk_search_folded')).toBe('0.13.0');
  });

  it('has an entry for every minor release from 0.7 to this one, in order', () => {
    const [major, minor] = minorOf(APP_VERSION).split('.').map(Number) as [number, number];
    const expected = Array.from({ length: minor - 7 + 1 }, (_, i) => `${major}.${7 + i}.0`);
    expect(manifest.map((release) => release.version)).toEqual(expected);
  });

  it('starts every release at a migration that exists, later than the one before', () => {
    let before = -1;
    for (const release of manifest) {
      const at = position.get(release.firstMigration);
      expect(at, `${release.version} starts at ${release.firstMigration}`).toBeDefined();
      expect(at!).toBeGreaterThan(before);
      before = at!;
    }
  });
});
