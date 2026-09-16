import { spawnSync } from 'node:child_process';

// OCI is MIT-licensed. These permissive and weak-copyleft licenses may be used
// as unmodified dependencies without changing the license of OCI's own source.
const allowedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MIT License',
  'MIT-0',
  'MPL-2.0',
  'Unlicense',
  '(AFL-2.1 OR BSD-3-Clause)',
  '(MPL-2.0 OR Apache-2.0)',
]);

const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});

if (result.status !== 0) {
  // pnpm's JSON mode reports command failures on stdout, not necessarily stderr.
  process.stderr.write(
    result.stderr || result.stdout || 'Unable to inspect production dependency licenses.\n',
  );
  process.exit(result.status ?? 1);
}

const inventory = JSON.parse(result.stdout);
const violations = [];

for (const [license, packages] of Object.entries(inventory)) {
  if (allowedLicenses.has(license)) continue;

  for (const dependency of packages) {
    // khroma 2.1.0 omits package.json#license, but its published README has an
    // explicit "MIT © Fabio Spampinato, Andrew Maney" license declaration.
    const documentedKhromaMit =
      license === 'Unknown' &&
      dependency.name === 'khroma' &&
      dependency.versions?.every((version) => version === '2.1.0');
    if (!documentedKhromaMit) {
      violations.push(`${dependency.name}@${dependency.versions?.join(',') ?? '?'}: ${license}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Production dependencies with unapproved or unknown licenses:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `License policy passed (${Object.keys(inventory).length} license expressions reviewed).`,
);
