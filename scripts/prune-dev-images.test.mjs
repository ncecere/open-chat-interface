import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectDevImages } from './prune-dev-images.mjs';

const now = new Date('2026-10-11T19:20:13Z');
const days = (n) => new Date(now.getTime() - n * 86_400_000).toISOString();
const sha = (prefix) => prefix.padEnd(40, '0');

/** A package version as GitHub's API lists it. */
const version = (id, tags, createdAt) => ({
  id,
  created_at: createdAt,
  metadata: { container: { tags } },
});

const branches = [
  { name: 'main', commit: { sha: sha('fa6837f9ff11') } },
  { name: 'patch/v0.12.1', commit: { sha: sha('ef66c673aaaa') } },
];

const versions = [
  // The head of main, built a minute before the run (2026-10-11): never deleted.
  version(1, ['dev-fa6837f9ff11'], days(0.001)),
  // The head of another branch, built long ago: kept while the branch exists.
  version(2, ['dev-ef66c673aaaa'], days(40)),
  // Old development images of commits no branch points at: deleted.
  version(3, ['dev-0123456789ab'], days(20)),
  version(4, ['dev-ba9876543210'], days(15)),
  // Recent, but no branch head: kept by age.
  version(5, ['dev-aaaaaaaaaaaa'], days(3)),
  // A release (other tags): never a candidate, whatever its age.
  version(6, ['v0.12.0', 'fa6837f9', 'latest'], days(90)),
  version(7, ['dev-cccccccccccc', 'v0.11.0'], days(90)),
  // Untagged (a platform child of a release index): never touched.
  version(8, [], days(90)),
];

test('deletes only old development images that no branch head uses', () => {
  const { candidates, kept } = selectDevImages({ versions, branches, olderThanDays: 14, now });
  assert.deepEqual(
    candidates.map((image) => image.id),
    [3, 4],
  );
  const reasons = Object.fromEntries(kept.map((image) => [image.id, image.reason]));
  assert.match(reasons[1], /head of main/);
  assert.match(reasons[2], /head of patch\/v0\.12\.1/);
  assert.match(reasons[5], /newer than 14 days/);
  assert.equal(reasons[6], undefined, 'releases are not development images, so not listed');
});

test('keeps every branch head even when asked to delete everything older than 1 day', () => {
  // On 2026-10-11 a manual run with older_than_days=0 deleted main's head image.
  const { candidates } = selectDevImages({ versions, branches, olderThanDays: 1, now });
  const ids = candidates.map((image) => image.id);
  assert.ok(!ids.includes(1) && !ids.includes(2));
  assert.deepEqual(ids, [3, 4, 5]);
});

test('refuses less than one day, and anything that is not a whole number', () => {
  for (const olderThanDays of [0, -1, 0.5, Number.NaN, '14', undefined])
    assert.throws(
      () => selectDevImages({ versions, branches, olderThanDays, now }),
      /older_than_days must be a whole number of days, at least 1/,
    );
});

test('fails closed without a list of branches', () => {
  for (const missing of [undefined, null, {}])
    assert.throws(
      () => selectDevImages({ versions, branches: missing, olderThanDays: 14, now }),
      /branches could not be listed/,
    );
  // An empty repository has no branches; then nothing is protected by being a head.
  assert.deepEqual(
    selectDevImages({ versions, branches: [], olderThanDays: 14, now }).candidates.map(
      (image) => image.id,
    ),
    [2, 3, 4],
  );
});

test('the command line prints the ids to delete and explains what it keeps', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oci-prune-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'versions.json'), JSON.stringify(versions));
  writeFileSync(join(dir, 'branches.json'), JSON.stringify(branches));
  const script = fileURLToPath(new URL('./prune-dev-images.mjs', import.meta.url));
  const run = (days) =>
    execFileSync(
      process.execPath,
      [
        script,
        '--versions',
        join(dir, 'versions.json'),
        '--branches',
        join(dir, 'branches.json'),
        '--older-than-days',
        String(days),
        '--now',
        now.toISOString(),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  assert.equal(run(14), '3 dev-0123456789ab\n4 dev-ba9876543210\n');
  assert.throws(() => run(0), /older_than_days must be a whole number of days, at least 1/);
});
