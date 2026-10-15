import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMatrix, checksFor, routesForRole, VIEWS } from './a11y-audit/lib/matrix.mjs';

const ROUTES = [
  { path: '/auth/login', audience: 'public', kind: 'page' },
  { path: '/auth/two-factor', audience: 'public', kind: 'page', state: 'second-step' },
  { path: '/', audience: 'end-user', kind: 'page' },
  { path: '/auth/mfa-setup', audience: 'end-user', kind: 'page', state: 'mfa-limited' },
  { path: '/settings/contact', audience: 'end-user', kind: 'redirect', to: '/settings' },
  { path: '/admin', audience: 'admin', kind: 'page' },
  { path: '/__not-found__', audience: 'public', kind: 'notfound', synthetic: true },
];

test('views name their size, and the zoom and text-size views are real settings', () => {
  assert.deepEqual(VIEWS['1280'], { width: 1280, height: 800 });
  assert.deepEqual(VIEWS['320'], { width: 320, height: 640 });
  assert.deepEqual(VIEWS.zoom400, { width: 320, height: 256, deviceScaleFactor: 4 });
  assert.equal(VIEWS.text200.width, 1280);
  assert.equal(VIEWS.reduce.reducedMotion, 'reduce');
});

test('each role reaches only what its audience allows, and state-only pages are left to their own pass', () => {
  const paths = (role) => routesForRole(ROUTES, role).map((route) => route.path);
  assert.deepEqual(paths('anonymous'), ['/auth/login', '/__not-found__']);
  assert.deepEqual(paths('user'), ['/', '/__not-found__']);
  assert.deepEqual(paths('restricted'), ['/', '/__not-found__']);
  assert.deepEqual(paths('admin'), ['/', '/admin', '/__not-found__']);
});

test('the full matrix is every combination, once', () => {
  const contexts = buildMatrix({
    profile: 'full',
    roles: ['admin', 'user'],
    themes: ['light', 'dark'],
    accents: ['neutral', 'blue'],
    views: ['1280', '320'],
    languages: ['en', 'ar-XB'],
  });
  assert.equal(contexts.length, 2 * 2 * 2 * 2 * 2);
  assert.equal(new Set(contexts.map((c) => JSON.stringify(c))).size, contexts.length);
});

test('the standard matrix varies one dimension at a time from the baseline', () => {
  const contexts = buildMatrix({
    profile: 'standard',
    roles: ['user'],
    themes: ['light', 'dark'],
    accents: ['neutral', 'blue', 'violet', 'emerald'],
    views: ['1280', '768', '320', 'zoom400', 'text200', 'reduce'],
    languages: ['en', 'ar', 'ar-XB'],
  });
  const key = (c) => [c.theme, c.accent, c.viewport, c.language].join('/');
  const keys = new Set(contexts.map(key));
  assert.equal(keys.size, contexts.length, 'no context twice');
  // Every theme with every accent at desktop, in English.
  for (const theme of ['light', 'dark']) {
    for (const accent of ['neutral', 'blue', 'violet', 'emerald']) {
      assert.ok(keys.has(`${theme}/${accent}/1280/en`), `${theme} ${accent}`);
    }
  }
  // Every view in both themes with the first accent.
  for (const view of ['768', '320', 'zoom400', 'text200', 'reduce']) {
    assert.ok(keys.has(`light/neutral/${view}/en`));
    assert.ok(keys.has(`dark/neutral/${view}/en`));
  }
  // Each other language at desktop and at 320, in both themes.
  for (const language of ['ar', 'ar-XB']) {
    for (const theme of ['light', 'dark']) {
      assert.ok(keys.has(`${theme}/neutral/1280/${language}`));
      assert.ok(keys.has(`${theme}/neutral/320/${language}`));
    }
  }
  assert.ok(contexts.length < 40, `${contexts.length} contexts is not a bounded run`);
});

test('the smoke matrix is small and still touches every dimension', () => {
  const contexts = buildMatrix({
    profile: 'smoke',
    roles: ['admin', 'user', 'restricted'],
    themes: ['light', 'dark'],
    accents: ['neutral', 'blue', 'violet', 'emerald'],
    views: ['1280', '768', '320', 'zoom400', 'text200', 'reduce'],
    languages: ['en', 'ar-XB'],
  });
  const per = contexts.filter((c) => c.role === 'user');
  assert.ok(per.length <= 10);
  assert.ok(per.some((c) => c.theme === 'dark'));
  assert.ok(per.some((c) => c.accent === 'blue'));
  assert.ok(per.some((c) => c.viewport === '320'));
  assert.ok(per.some((c) => c.language === 'ar-XB'));
  assert.ok(per.some((c) => c.viewport === 'zoom400'));
  assert.ok(per.some((c) => c.viewport === 'text200'));
  assert.ok(per.some((c) => c.viewport === 'reduce'));
});

test('an unknown profile or view is an error, not an empty run', () => {
  assert.throws(
    () =>
      buildMatrix({
        profile: 'huge',
        roles: ['user'],
        themes: ['light'],
        accents: ['neutral'],
        views: ['1280'],
        languages: ['en'],
      }),
    /profile/,
  );
  assert.throws(
    () =>
      buildMatrix({
        profile: 'full',
        roles: ['user'],
        themes: ['light'],
        accents: ['neutral'],
        views: ['999'],
        languages: ['en'],
      }),
    /view/,
  );
});

test('checks follow the view: layout checks where layout matters, tree and forms once', () => {
  const first = {
    theme: 'light',
    accent: 'neutral',
    themes: ['light', 'dark'],
    accents: ['neutral', 'blue'],
  };
  const at = (viewport, over = {}) => new Set(checksFor({ viewport, ...first, ...over }));
  assert.deepEqual([...at('1280')].sort(), [
    'axe',
    'contrast',
    'document',
    'forms',
    'motion',
    'non-text',
    'targets',
    'text-spacing',
    'tree',
  ]);
  assert.ok(at('320').has('reflow') && at('320').has('text-spacing') && !at('320').has('tree'));
  assert.ok(at('768').has('axe') && !at('768').has('text-spacing'));
  assert.deepEqual([...at('zoom400')], ['reflow']);
  assert.deepEqual([...at('text200')], ['text-resize']);
  assert.deepEqual([...at('reduce')], ['motion']);
  // A second theme repeats what depends on colour only.
  const dark = at('1280', { theme: 'dark' });
  assert.deepEqual([...dark].sort(), ['axe', 'contrast', 'non-text', 'targets']);
  const blue = at('1280', { accent: 'blue' });
  assert.ok(blue.has('contrast') && !blue.has('tree'));
});
