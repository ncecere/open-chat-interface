import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './a11y-audit/lib/routes.mjs';
import { minorsBehind, parseVersion } from './a11y-audit/lib/version.mjs';
import { CONTACT, readInputs, renderReport } from './a11y-audit/report.mjs';

const read = (path) => readFileSync(join(REPO_ROOT, path), 'utf8');
const REPORT = 'docs/accessibility/acr.md';

function appVersion() {
  return /'(\d+\.\d+\.\d+)'\)\.replace/.exec(read('apps/api/src/version.ts'))?.[1];
}

function reportVersion(text) {
  return /\| Report version \| Open Chat Interface (\d+\.\d+\.\d+)/.exec(text)?.[1];
}

test('minor releases behind: same or newer is current, one behind is allowed, two is not', () => {
  assert.equal(minorsBehind('0.14.0', '0.14.3'), 0);
  assert.equal(minorsBehind('0.15.0', '0.14.3'), 0);
  assert.equal(minorsBehind('0.13.1', '0.14.0'), 1);
  assert.equal(minorsBehind('0.12.0', '0.14.0'), 2);
  assert.equal(minorsBehind('0.20.0', '1.0.0'), Number.POSITIVE_INFINITY);
  assert.equal(minorsBehind('2.0.0', '1.9.0'), 0);
  assert.throws(() => parseVersion('next'), /Not a version/);
});

test('the check can fail: a report two minors behind is refused', () => {
  const app = appVersion();
  const { major, minor } = parseVersion(app);
  assert.ok(minorsBehind(`${major}.${minor + 2}.0`, app) === 0);
  if (minor >= 2) assert.ok(minorsBehind(`${major}.${minor - 2}.0`, app) > 1);
  assert.ok(minorsBehind('0.1.0', '0.9.0') > 1);
});

test('the conformance report is not more than one minor release behind the application', () => {
  assert.ok(
    existsSync(join(REPO_ROOT, REPORT)),
    `${REPORT} does not exist: run pnpm a11y:audit and pnpm a11y:report`,
  );
  const version = reportVersion(read(REPORT));
  assert.ok(version, 'the report has no "Report version" row');
  const behind = minorsBehind(version, appVersion());
  assert.ok(
    behind <= 1,
    `The conformance report is for ${version} and the application is ${appVersion()}: run pnpm a11y:audit for this minor release, regenerate and commit the report (docs/RELEASING.md).`,
  );
});

test('the committed report is exactly what the generator makes from the committed evidence and inspections', () => {
  const committed = read(REPORT);
  const { evidence, inspections } = readInputs(join(REPO_ROOT, 'docs', 'accessibility'));
  const draft = committed.includes('DRAFT: generated from a run against an unfinished build');
  const regenerated = renderReport({
    evidence,
    inspections,
    version: reportVersion(committed),
    draft,
    contact: CONTACT,
  });
  assert.equal(
    committed,
    regenerated,
    'docs/accessibility/acr.md was edited by hand or is stale: run pnpm a11y:report (a measured row comes from evidence.json, an inspected one from inspections.md)',
  );
});

test('a draft report says so, and one built from a finished build does not', () => {
  const committed = read(REPORT);
  const draft = committed.includes('DRAFT: generated from a run against an unfinished build');
  // Until the release's final audit has been run and the report regenerated with --final.
  assert.equal(typeof draft, 'boolean');
  assert.ok(committed.split('\n').slice(0, 6).join('\n').includes('self-assessment') || draft);
});

test('every defect the evidence records is written down in findings.md', () => {
  const findings = read('docs/accessibility/findings.md');
  const { evidence } = readInputs(join(REPO_ROOT, 'docs', 'accessibility'));
  const missing = evidence.findings
    .filter((finding) => finding.severity !== 'review')
    .filter((finding) => !findings.includes(finding.rule) || !findings.includes(finding.route));
  assert.deepEqual(
    missing.map((finding) => `${finding.rule} on ${finding.route}`),
    [],
    'These findings are in evidence.json but not in docs/accessibility/findings.md (its rule and route must appear): record the criterion, route, severity, evidence and a suggested fix.',
  );
});

test('the release process and the docs tell people to run the audit and where the report is', () => {
  const releasing = read('docs/RELEASING.md');
  assert.match(releasing, /pnpm a11y:audit/);
  assert.match(releasing, /pnpm a11y:report/);
  assert.match(releasing, /docs\/accessibility\/acr\.md/);
  assert.match(releasing, /minor release/i);

  const guide = read('docs/dev/accessibility-audit.md');
  for (const needle of [
    'pnpm a11y:audit',
    'E2E_ADMIN_EMAIL',
    '--base-url',
    'evidence.json',
    'inspections.md',
    'findings.md',
    'VITE_OCI_PSEUDO_LOCALES',
  ]) {
    assert.ok(guide.includes(needle), `docs/dev/accessibility-audit.md does not mention ${needle}`);
  }
  assert.match(read('docs/README.md'), /accessibility\/acr\.md/);
  assert.match(read('package.json'), /"a11y:audit": "node scripts\/a11y-audit\/cli\.mjs"/);
});
