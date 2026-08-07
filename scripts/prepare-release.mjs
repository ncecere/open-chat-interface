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
const escapedVersion = version.replaceAll('.', '\\.');
const heading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
const match = heading.exec(changelog);
if (!match) {
  throw new Error(`CHANGELOG.md needs a dated "## [${version}] - YYYY-MM-DD" section`);
}

const sectionStart = match.index;
const possibleEnds = [
  changelog.indexOf('\n## [', sectionStart + match[0].length),
  changelog.indexOf('\n[Unreleased]:', sectionStart + match[0].length),
].filter((index) => index !== -1);
const sectionEnd = possibleEnds.length > 0 ? Math.min(...possibleEnds) : undefined;
let releaseNotes = changelog.slice(sectionStart, sectionEnd).trim();

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
