// Chooses which development images (.github/workflows/branch-images.yml's
// dev-<12 hex> tags) the weekly prune deletes. Pure: the workflow lists the
// package versions and the branches with `gh api` and deletes what this
// prints, so the choice is tested without touching a registry.
//
// Never a candidate: a version with any tag other than dev-<12 hex> (a
// release, sha8, latest), an untagged version (a platform child of a release
// index), the image of any branch's head commit (what `dev-env up --ref
// <branch>` pulls), or anything newer than the cutoff. On 2026-10-11 a manual
// run with older_than_days=0 deleted the image of main's head a minute after
// it was built; less than one day is now refused.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEV_TAG = /^dev-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;

/**
 * versions: GitHub package versions ({ id, created_at, metadata.container.tags }).
 * branches: GitHub branches ({ name, commit.sha }); an empty list means none.
 * Returns the versions to delete, and the development images kept, with why.
 */
export function selectDevImages({ versions, branches, olderThanDays, now = new Date() }) {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1)
    throw new Error('older_than_days must be a whole number of days, at least 1');
  // Fail closed: without the branches, any image could be a branch's head.
  if (!Array.isArray(branches))
    throw new Error('The branches could not be listed, so nothing is deleted');
  const heads = new Map(
    branches.map((branch) => [`dev-${branch.commit.sha.slice(0, 12)}`, branch.name]),
  );
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS).toISOString();

  const candidates = [];
  const kept = [];
  for (const version of versions) {
    const tags = version.metadata?.container?.tags ?? [];
    if (tags.length === 0 || !tags.every((tag) => DEV_TAG.test(tag))) continue;
    const image = { id: version.id, tags, createdAt: version.created_at };
    const head = tags.map((tag) => heads.get(tag)).find(Boolean);
    if (head) kept.push({ ...image, reason: `the head of ${head}` });
    else if (version.created_at >= cutoff)
      kept.push({ ...image, reason: `newer than ${olderThanDays} days` });
    else candidates.push(image);
  }
  return { candidates, kept };
}

function main() {
  const { values } = parseArgs({
    options: {
      versions: { type: 'string' },
      branches: { type: 'string' },
      'older-than-days': { type: 'string' },
      now: { type: 'string' },
    },
  });
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const days = values['older-than-days'];
  const { candidates, kept } = selectDevImages({
    versions: read(values.versions),
    branches: values.branches ? read(values.branches) : undefined,
    olderThanDays: /^\d+$/.test(days ?? '') ? Number(days) : Number.NaN,
    now: values.now ? new Date(values.now) : new Date(),
  });
  for (const image of kept)
    console.error(`keep ${image.id} (${image.tags.join(',')}): ${image.reason}`);
  for (const image of candidates) console.log(`${image.id} ${image.tags.join(',')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
