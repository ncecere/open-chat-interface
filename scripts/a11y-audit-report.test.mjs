import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvidence } from './a11y-audit/lib/evidence.mjs';
import { combine } from './a11y-audit/lib/mappings.mjs';
import { CRITERIA } from './a11y-audit/lib/wcag.mjs';
import { DRAFT_BANNER, deriveRow, parseInspections, renderReport } from './a11y-audit/report.mjs';

const ctx = { role: 'user', theme: 'light', accent: 'neutral', viewport: '1280', language: 'en' };

function evidenceWith(build) {
  const evidence = createEvidence();
  build(evidence);
  return {
    generatedAt: '2026-10-15T10:00:00.000Z',
    durationSeconds: 60,
    tool: {
      name: 'scripts/a11y-audit',
      '@playwright/test': '1.62.1',
      '@axe-core/playwright': '4.12.1',
      'axe-core': '4.12.1',
      browser: 'Chromium 151',
    },
    app: { version: '0.14.0', commit: 'abcdef0123456789' },
    matrix: {
      profile: 'smoke',
      roles: ['user'],
      themes: ['light'],
      accents: ['neutral'],
      views: ['1280'],
      languages: ['en'],
      contexts: 1,
    },
    routes: { listed: 2, coverage: { '/': { user: { pages: 1 } } } },
    skipped: [],
    errorCount: 0,
    ...evidence.toJSON(),
  };
}

const INSPECTIONS = `
# Inspections

### 1.2.1
- Status: Not Applicable
- Method: Searched apps/web/src for audio and video elements; there are none.
- Remarks: The product's own interface has no prerecorded audio or video.
- Date: 2026-10-15

### 2.4.2
- Status: Supports
- Method: Read the document titles of every route.
- Remarks: Each is descriptive.
- Date: 2026-10-15
`;

test('inspections are read from their blocks, and a malformed one is an error', () => {
  const parsed = parseInspections(INSPECTIONS);
  assert.deepEqual(Object.keys(parsed), ['1.2.1', '2.4.2']);
  assert.equal(parsed['1.2.1'].status, 'Not Applicable');
  assert.match(parsed['1.2.1'].method, /Searched apps\/web\/src/);
  assert.throws(
    () => parseInspections('### 1.1.1\n- Status: Fine\n- Method: m\n- Remarks: r\n- Date: d\n'),
    /status "Fine"/,
  );
  assert.throws(
    () => parseInspections('### 1.1.1\n- Status: Supports\n- Remarks: r\n'),
    /Method, Remarks and Date/,
  );
  assert.throws(() => parseInspections(`${INSPECTIONS}\n${INSPECTIONS}`), /twice/);
});

test('a criterion the measurements decide is Supports only when every check for it ran and none failed', () => {
  const evidence = evidenceWith((e) => {
    e.sample(['1.4.3'], 'contrast', '/');
    e.sample(['1.4.3'], 'axe', '/');
  });
  const row = deriveRow('1.4.3', evidence, {});
  assert.equal(row.status, 'Supports');
  assert.equal(row.source, 'Measured');
  assert.match(row.remarks, /2 samples on 1 route/);
  assert.match(row.remarks, /criteria\["1\.4\.3"\]/);

  // Only one of the two checks ran: not enough.
  const partial = evidenceWith((e) => e.sample(['1.4.3'], 'axe', '/'));
  const incomplete = deriveRow('1.4.3', partial, {});
  assert.equal(incomplete.status, 'Not Evaluated');
  assert.match(incomplete.remarks, /did not all run/);
});

test('a criterion that automation only partly tests stays Not Evaluated, however many samples pass', () => {
  const evidence = evidenceWith((e) => {
    for (let i = 0; i < 50; i += 1) e.sample(['2.1.1'], 'walkthrough', `walkthrough:${i}`);
  });
  const row = deriveRow('2.1.1', evidence, {});
  assert.equal(row.status, 'Not Evaluated');
  assert.match(row.remarks, /only part of this criterion/);
  assert.match(row.remarks, /inspection is needed/);
});

test('a failure makes a row Partially Supports, or Does Not Support when every route failed', () => {
  const some = evidenceWith((e) => {
    e.sample(['2.5.8'], 'target-size', '/');
    e.sample(['2.5.8'], 'target-size', '/settings');
    e.finding({
      criteria: ['2.5.8'],
      check: 'target-size',
      rule: 'target-size',
      severity: 'moderate',
      route: '/',
      context: ctx,
      message: 'Target 16x16 px',
      targets: ['button.x'],
    });
  });
  const partially = deriveRow('2.5.8', some, {});
  assert.equal(partially.status, 'Partially Supports');
  assert.match(partially.remarks, /F001/);
  assert.match(partially.remarks, /Target 16x16 px/);

  const every = evidenceWith((e) => {
    for (const route of ['/', '/settings']) {
      e.finding({
        criteria: ['2.5.8'],
        check: 'target-size',
        rule: 'target-size',
        severity: 'moderate',
        route,
        context: ctx,
        message: 'm',
        targets: [`b${route}`],
      });
    }
  });
  assert.equal(deriveRow('2.5.8', every, {}).status, 'Does Not Support');
});

test('an inspection cannot hide a failure: Not Applicable never lowers a failing row', () => {
  const failing = evidenceWith((e) =>
    e.finding({
      criteria: ['1.2.1'],
      check: 'axe',
      rule: 'x',
      severity: 'serious',
      route: '/',
      context: ctx,
      message: 'm',
      targets: ['a'],
    }),
  );
  const row = deriveRow('1.2.1', failing, parseInspections(INSPECTIONS));
  assert.notEqual(row.status, 'Not Applicable');
  assert.equal(row.source, 'Measured and inspection');
  assert.equal(combine(['Partially Supports', 'Not Applicable']), 'Partially Supports');
});

test('a review is shown but is not a failure', () => {
  const evidence = evidenceWith((e) => {
    e.sample(['2.4.11'], 'keyboard', '/');
    e.finding({
      criteria: ['2.4.11'],
      check: 'keyboard',
      rule: 'focus-partly-obscured',
      severity: 'review',
      route: '/',
      context: ctx,
      message: 'partly covered',
      targets: ['a'],
    });
  });
  const row = deriveRow('2.4.11', evidence, {});
  assert.equal(row.status, 'Not Evaluated');
  assert.match(row.remarks, /1 item to review/);
});

test('an inspection supplies a row that nothing measured, and the remark says so', () => {
  const row = deriveRow(
    '1.2.1',
    evidenceWith(() => {}),
    parseInspections(INSPECTIONS),
  );
  assert.equal(row.status, 'Not Applicable');
  assert.equal(row.source, 'Inspection');
  assert.match(row.remarks, /^Inspection\./);
  assert.match(row.remarks, /Searched apps\/web\/src/);
});

test('a criterion with nothing behind it says so', () => {
  const row = deriveRow(
    '1.4.5',
    evidenceWith(() => {}),
    {},
  );
  assert.equal(row.status, 'Not Evaluated');
  assert.match(row.remarks, /Neither a measurement nor an inspection/);
});

test('the report has a row for every A and AA criterion, AAA as Not Evaluated, and the derived tables', () => {
  const evidence = evidenceWith((e) => {
    e.sample(['2.5.8'], 'target-size', '/');
    e.finding({
      criteria: ['2.5.8'],
      check: 'target-size',
      rule: 'target-size',
      severity: 'moderate',
      route: '/',
      context: ctx,
      message: 'Target 16x16 px',
      targets: ['button.x'],
    });
    e.sample(['1.4.3'], 'contrast', '/');
    e.sample(['1.4.3'], 'axe', '/');
  });
  const text = renderReport({
    evidence,
    inspections: parseInspections(INSPECTIONS),
    version: '0.14.0',
    draft: true,
    contact: 'an issue',
  });
  for (const criterion of CRITERIA)
    assert.ok(text.includes(`| ${criterion.id} ${criterion.name} |`), criterion.id);
  assert.match(text, /Table 3: Success Criteria, Level AAA/);
  assert.match(text, /All level AAA criteria \| Not Evaluated/);
  assert.match(
    text,
    /self-assessment by the Open Chat Interface project\. It is not an audit by a third party/,
  );
  for (const limit of [
    'No person used a screen reader or voice control',
    'No independent evaluator',
    'User-generated and model-generated content',
    'logos and documents',
  ]) {
    assert.ok(text.includes(limit), limit);
  }
  // Derived: 302.7 includes 2.5.8, which failed; EN 9.1.4.3 is the WCAG 1.4.3 row.
  assert.match(text, /\| 302\.7 With Limited Manipulation \| Partially Supports \|/);
  assert.match(text, /\| 9\.1\.4\.3 Contrast \(Minimum\) \| Supports \|/);
  assert.match(text, /\| 4\.1\.1 Parsing \| Not Evaluated \|/);
  // 2.5.8 is a WCAG 2.2 criterion: not in the Section 508 or EN 301 549 V3.2.1 tables.
  assert.ok(!/\| 9\.2\.5\.8/.test(text));
  assert.match(text, /\| 401 to 415 Hardware \| Not Applicable \|/);
  assert.ok(!text.includes('University AI gateway'));
});

test('a draft says so in its header and a final report does not', () => {
  const evidence = evidenceWith(() => {});
  const draft = renderReport({
    evidence,
    inspections: {},
    version: '0.14.0',
    draft: true,
    contact: 'c',
  });
  assert.ok(draft.split('\n').slice(0, 5).join('\n').includes(DRAFT_BANNER));
  assert.equal(DRAFT_BANNER, 'DRAFT: generated from a run against an unfinished build');
  const final = renderReport({
    evidence,
    inspections: {},
    version: '0.14.0',
    draft: false,
    contact: 'c',
  });
  assert.ok(!final.includes('DRAFT'));
});

test('the same inputs always give the same report', () => {
  const evidence = evidenceWith((e) => e.sample(['1.4.3'], 'contrast', '/'));
  const make = () =>
    renderReport({
      evidence,
      inspections: parseInspections(INSPECTIONS),
      version: '0.14.0',
      draft: true,
      contact: 'c',
    });
  assert.equal(make(), make());
});

test('an example inside a code fence is not an inspection', () => {
  const text = `Format:\n\n\`\`\`\n### 1.1.1\n- Status: Supports | Not Applicable\n\`\`\`\n\n${INSPECTIONS}`;
  assert.deepEqual(Object.keys(parseInspections(text)), ['1.2.1', '2.4.2']);
});

test('the report lists the contexts that ran, not the dimensions that were asked for', () => {
  const evidence = evidenceWith(() => {});
  evidence.matrix = {
    ...evidence.matrix,
    themes: ['light', 'dark'],
    contexts: 2,
    ran: ['user/light/neutral/1280/en', 'user/dark/neutral/320/ar-XB'],
  };
  const text = renderReport({
    evidence,
    inspections: {},
    version: '0.14.0',
    draft: true,
    contact: 'c',
  });
  assert.match(text, /\| Views \| 1280 px, 320 px \|/);
  assert.match(text, /\| Languages \| en, ar-XB \|/);
  assert.match(
    text,
    /\| user \| light \/ neutral \/ 1280 \/ en; dark \/ neutral \/ 320 \/ ar-XB \|/,
  );
});
