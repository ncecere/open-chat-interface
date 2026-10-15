import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextKey, createEvidence, redact, SEVERITIES } from './a11y-audit/lib/evidence.mjs';

const ctx = (over = {}) => ({
  role: 'user',
  theme: 'light',
  accent: 'neutral',
  viewport: 1280,
  language: 'en',
  ...over,
});

test('a context is named by its five dimensions', () => {
  assert.equal(contextKey(ctx()), 'user/light/neutral/1280/en');
});

test('samples are counted per criterion, check and route', () => {
  const evidence = createEvidence();
  evidence.sample(['1.4.3'], 'contrast', '/settings', ctx());
  evidence.sample(['1.4.3'], 'contrast', '/settings', ctx({ theme: 'dark' }));
  evidence.sample(['1.4.3', '1.4.11'], 'contrast', '/admin', ctx());
  const json = evidence.toJSON();
  assert.equal(json.criteria['1.4.3'].samples, 3);
  assert.equal(json.criteria['1.4.3'].routes['/settings'].samples, 2);
  assert.equal(json.criteria['1.4.11'].samples, 1);
  assert.equal(json.checks.contrast.samples, 3);
});

test('the same defect found in many contexts is one finding with its contexts counted', () => {
  const evidence = createEvidence();
  for (const theme of ['light', 'dark']) {
    evidence.sample(['1.4.3'], 'contrast', '/settings', ctx({ theme }));
    evidence.finding({
      criteria: ['1.4.3'],
      check: 'contrast',
      rule: 'text-contrast',
      severity: 'serious',
      route: '/settings',
      context: ctx({ theme }),
      message: 'Text contrast 2.9:1, needs 4.5:1',
      targets: ['.hint'],
    });
  }
  evidence.finding({
    criteria: ['1.4.3'],
    check: 'contrast',
    rule: 'text-contrast',
    severity: 'serious',
    route: '/admin',
    context: ctx(),
    message: 'Text contrast 2.9:1, needs 4.5:1',
    targets: ['.hint'],
  });
  const json = evidence.toJSON();
  assert.equal(json.findings.length, 2);
  const settings = json.findings.find((finding) => finding.route === '/settings');
  assert.equal(settings.occurrences, 2);
  assert.deepEqual(settings.contexts.sort(), [
    'user/dark/neutral/1280/en',
    'user/light/neutral/1280/en',
  ]);
  assert.equal(json.criteria['1.4.3'].failures, 3);
  assert.equal(json.criteria['1.4.3'].routes['/settings'].failures, 2);
  assert.equal(json.criteria['1.4.3'].findingCount, 2);
});

test('a finding names a severity from the known list, and an unknown one is refused', () => {
  assert.deepEqual(SEVERITIES, ['critical', 'serious', 'moderate', 'minor', 'review']);
  const evidence = createEvidence();
  assert.throws(
    () =>
      evidence.finding({
        criteria: ['1.4.3'],
        check: 'contrast',
        rule: 'x',
        severity: 'bad',
        route: '/',
        context: ctx(),
        message: 'm',
      }),
    /severity/,
  );
  assert.throws(
    () =>
      evidence.finding({
        criteria: ['9.9.9'],
        check: 'contrast',
        rule: 'x',
        severity: 'minor',
        route: '/',
        context: ctx(),
        message: 'm',
      }),
    /criterion/,
  );
});

test('a criterion with failures and no samples is impossible: a finding counts as a sample', () => {
  const evidence = createEvidence();
  evidence.finding({
    criteria: ['2.5.8'],
    check: 'target-size',
    rule: 'target-size',
    severity: 'moderate',
    route: '/',
    context: ctx(),
    message: 'm',
  });
  const json = evidence.toJSON();
  assert.ok(json.criteria['2.5.8'].samples >= json.criteria['2.5.8'].failures);
});

test('nothing that looks like a secret or an address is written', () => {
  assert.equal(redact('mail ada@example.test now'), 'mail <email> now');
  assert.equal(redact('token=abcdef0123456789abcdef0123456789abcdef'), 'token=<token>');
  assert.equal(redact('Disposable-abc123xy-Pw1!'), '<password>');
  assert.equal(
    redact('http://127.0.0.1:4699/settings?code=123456&x=1'),
    'http://127.0.0.1:4699/settings?<query>',
  );
  assert.equal(redact('plain text'), 'plain text');

  const evidence = createEvidence();
  evidence.finding({
    criteria: ['3.3.2'],
    check: 'forms',
    rule: 'label',
    severity: 'serious',
    route: '/',
    context: ctx(),
    message: 'Field for ada@example.test has no label',
    targets: ['input[value="ada@example.test"]'],
  });
  const text = JSON.stringify(evidence.toJSON());
  assert.ok(!text.includes('ada@example.test'));
});

test('a limit is recorded once and shown with the check it belongs to', () => {
  const evidence = createEvidence();
  evidence.limit('contrast', 'Text over images and gradients cannot be measured.');
  evidence.limit('contrast', 'Text over images and gradients cannot be measured.');
  assert.deepEqual(evidence.toJSON().checks.contrast.limits, [
    'Text over images and gradients cannot be measured.',
  ]);
});

test('counters keep what could not be judged, so it is not mistaken for a pass', () => {
  const evidence = createEvidence();
  evidence.count('contrast', 'indeterminate', 7);
  evidence.count('contrast', 'indeterminate', 3);
  assert.equal(evidence.toJSON().checks.contrast.counters.indeterminate, 10);
});

test('every measured pair is kept per theme and accent, weakest first, with how many routes had it', () => {
  const evidence = createEvidence();
  const pair = (ratio, fg) => ({
    kind: 'text',
    fg,
    bg: '#ffffff',
    required: 4.5,
    ratio,
    pass: ratio >= 4.5,
    count: 2,
  });
  evidence.pair('light/neutral', '/a', pair(7, '#595959'));
  evidence.pair('light/neutral', '/b', pair(3.1, '#999999'));
  evidence.pair('light/neutral', '/c', pair(3.1, '#999999'));
  evidence.pair('dark/blue', '/a', pair(9, '#eeeeee'));
  const { contrastPairs } = evidence.toJSON();
  assert.deepEqual(
    contrastPairs['light/neutral'].map((entry) => [entry.fg, entry.count, entry.routeCount]),
    [
      ['#999999', 4, 2],
      ['#595959', 2, 1],
    ],
  );
  assert.equal(Object.keys(contrastPairs).length, 2);
});
