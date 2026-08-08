import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const packageFiles = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/config/package.json',
  'packages/db/package.json',
  'packages/shared/package.json',
];

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const manifests = await Promise.all(
  packageFiles.map(async (file) => ({
    file,
    value: JSON.parse(await readFile(file, 'utf8')),
  })),
);
const rootVersion = manifests[0].value.version;
const tag = option('--tag') ?? `v${rootVersion}`;
const output = option('--output');

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Release tag must be stable semantic version vX.Y.Z; received ${tag}`);
}

const version = tag.slice(1);
const mismatches = manifests.filter(({ value }) => value.version !== version);
if (mismatches.length > 0) {
  throw new Error(
    `Package versions must match ${tag}: ${mismatches
      .map(({ file, value }) => `${file}=${value.version}`)
      .join(', ')}`,
  );
}

const changelog = await readFile('CHANGELOG.md', 'utf8');

// Located by literal prefix rather than a regex built from the version. The
// version is already constrained above, but a constructed pattern invites the
// question every time this is read; a fixed date check answers it outright.
const headingPrefix = `## [${version}] - `;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const lines = changelog.split('\n');
const headingIndex = lines.findIndex(
  (line) => line.startsWith(headingPrefix) && datePattern.test(line.slice(headingPrefix.length)),
);
if (headingIndex === -1) {
  throw new Error(`CHANGELOG.md needs a dated "## [${version}] - YYYY-MM-DD" section`);
}

// The section runs to the next release heading, or to the link definitions.
const restIndex = lines
  .slice(headingIndex + 1)
  .findIndex((line) => line.startsWith('## [') || line.startsWith('[Unreleased]:'));
const sectionLines =
  restIndex === -1
    ? lines.slice(headingIndex)
    : lines.slice(headingIndex, headingIndex + 1 + restIndex);
let releaseNotes = sectionLines.join('\n').trim();

const registry = process.env.CI_REGISTRY_IMAGE;
if (registry) {
  releaseNotes += `\n\n### Container images\n\n- \`${registry}/api:${tag}\`\n- \`${registry}/web:${tag}\``;
}
releaseNotes += '\n';

if (output) await writeFile(output, releaseNotes);

console.log(
  `Release ${tag} is consistent across ${manifests.length} package manifests and CHANGELOG.md${
    output ? `; wrote ${output}` : ''
  }.`,
);
