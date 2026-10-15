import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AUDIENCES,
  extractRouterPaths,
  loadRoutes,
  REPO_ROOT,
  resolveConcretePath,
  routesMissingFromList,
} from './a11y-audit/lib/routes.mjs';
import {
  CRITERIA,
  compareCriteria,
  criteriaFromAxeTags,
  criterionFromAxeTag,
} from './a11y-audit/lib/wcag.mjs';

const ROUTER = `${REPO_ROOT}/apps/web/src/router.tsx`;

test('every route in router.tsx is in routes.json', () => {
  const found = extractRouterPaths(readFileSync(ROUTER, 'utf8'), REPO_ROOT);
  const missing = routesMissingFromList(found, loadRoutes());
  assert.deepEqual(
    missing,
    [],
    `router.tsx has routes that scripts/a11y-audit/routes.json does not list: ${missing.join(', ')}.\n` +
      'Add each with its audience (public, end-user or admin); the audit cannot cover a page it does not know.',
  );
});

test('the check can fail: a router with a new page and a list without it', () => {
  const source = readFileSync(ROUTER, 'utf8').replace(
    "path: '/projects',",
    "path: '/projects',\n  }); createRoute({ getParentRoute: () => authenticatedRoute, path: '/brand-new-page',",
  );
  const found = extractRouterPaths(source, REPO_ROOT);
  assert.deepEqual(routesMissingFromList(found, loadRoutes()), ['/brand-new-page']);
  // And a router edited to drop a page leaves a stale entry for the second check to catch.
  assert.ok(found.includes('/projects'));
});

test('routes.json lists nothing the router does not have, except named synthetic pages', () => {
  const found = new Set(extractRouterPaths(readFileSync(ROUTER, 'utf8'), REPO_ROOT));
  const stale = loadRoutes().filter((route) => !route.synthetic && !found.has(route.path));
  assert.deepEqual(
    stale.map((route) => route.path),
    [],
    'These routes are in routes.json but not in router.tsx: remove them, or mark them "synthetic" with a reason.',
  );
  for (const route of loadRoutes().filter((candidate) => candidate.synthetic)) {
    assert.ok(route.reason, `${route.path} is synthetic and needs a reason`);
  }
});

test('every entry has an audience, a kind, and what its kind needs', () => {
  const routes = loadRoutes();
  const paths = new Set(routes.map((route) => route.path));
  for (const route of routes) {
    assert.ok(AUDIENCES.includes(route.audience), `${route.path}: audience ${route.audience}`);
    assert.ok(['page', 'redirect', 'notfound'].includes(route.kind), `${route.path}: kind`);
    if (route.kind === 'redirect') {
      assert.ok(paths.has(route.to), `${route.path} redirects to ${route.to}, which is not listed`);
    }
    if (route.path.includes('$')) {
      assert.ok(route.fixture, `${route.path} has a parameter and needs a "fixture" to fill it`);
    }
  }
  assert.equal(
    new Set(routes.map((route) => route.path)).size,
    routes.length,
    'a path is listed twice',
  );
});

test('administration pages are admin, and nothing else is', () => {
  for (const route of loadRoutes()) {
    assert.equal(
      route.path.startsWith('/admin'),
      route.audience === 'admin',
      `${route.path} is ${route.audience}`,
    );
  }
});

test('extraction reads every way router.tsx declares a path', () => {
  const source = `
    const a = createRoute({ getParentRoute: () => rootRoute, path: '/one', component: X });
    const b = createRoute({
      getParentRoute: () => rootRoute,
      path: LATE_PATH,
      beforeLoad: async () => { const { x } = await y({ path: '/ignored-inner' }); },
    });
    const c = createRoute({ getParentRoute: () => rootRoute, id: 'layout', component: X });
    const d = redirectRoute('/two', '/one');
    const tabs = [{ path: '/tab', component: X }] as const;
    const tabRoutes = tabs.map((tab) => createRoute({ getParentRoute: () => c, path: tab.path }));
    const retired = ['/old-a', '/old-b'].map((path) => createRoute({ getParentRoute: () => c, path }));
    function redirectRoute(path, to) { return createRoute({ getParentRoute: () => c, path, beforeLoad: () => {} }); }
  `;
  const found = extractRouterPaths(source, REPO_ROOT, { LATE_PATH: '/late' });
  assert.deepEqual([...found].sort(), ['/late', '/old-a', '/old-b', '/one', '/tab', '/two']);
});

test('a route whose path cannot be read stops the audit instead of being missed', () => {
  const source = `const x = createRoute({ getParentRoute: () => r, path: buildPath(), component: X });`;
  assert.throws(() => extractRouterPaths(source, REPO_ROOT), /cannot read the path/i);
});

test('parameters are filled from a fixture, and a missing one is an error', () => {
  assert.equal(resolveConcretePath('/chat/$threadId', { threadId: 'abc' }), '/chat/abc');
  assert.equal(resolveConcretePath('/settings', {}), '/settings');
  assert.throws(() => resolveConcretePath('/chat/$threadId', {}), /threadId/);
});

test('the criteria list is every level A and AA criterion of WCAG 2.2', () => {
  assert.equal(CRITERIA.filter((criterion) => criterion.level === 'A').length, 31);
  assert.equal(CRITERIA.filter((criterion) => criterion.level === 'AA').length, 24);
  assert.equal(new Set(CRITERIA.map((criterion) => criterion.id)).size, 55);
  // The 2.2 additions are all there; 2.4.13 and 3.3.9 are AAA and are not.
  for (const id of ['2.4.11', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8']) {
    assert.ok(
      CRITERIA.some((criterion) => criterion.id === id),
      id,
    );
  }
  assert.ok(!CRITERIA.some((criterion) => ['2.4.13', '3.3.9', '4.1.1'].includes(criterion.id)));
});

test('axe tags map to criteria, and digits run together unambiguously', () => {
  assert.equal(criterionFromAxeTag('wcag143'), '1.4.3');
  assert.equal(criterionFromAxeTag('wcag1410'), '1.4.10');
  assert.equal(criterionFromAxeTag('wcag2411'), '2.4.11');
  assert.equal(criterionFromAxeTag('wcag258'), '2.5.8');
  assert.equal(criterionFromAxeTag('wcag412'), '4.1.2');
  assert.equal(criterionFromAxeTag('wcag2a'), null);
  assert.equal(criterionFromAxeTag('wcag22aa'), null);
  assert.equal(criterionFromAxeTag('cat.color'), null);
  // Level AAA and the obsolete 4.1.1 are not in the report.
  assert.equal(criterionFromAxeTag('wcag146'), null);
  assert.equal(criterionFromAxeTag('wcag411'), null);
  assert.deepEqual(criteriaFromAxeTags(['cat.aria', 'wcag2a', 'wcag412', 'wcag131']), [
    '4.1.2',
    '1.3.1',
  ]);
  assert.deepEqual(['1.4.10', '1.4.3', '2.4.11', '2.4.2'].sort(compareCriteria), [
    '1.4.3',
    '1.4.10',
    '2.4.2',
    '2.4.11',
  ]);
});
