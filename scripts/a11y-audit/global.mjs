/**
 * Checks about the product as a whole rather than one page in one context: orientation (1.3.4),
 * and that each role is kept out of what it may not open.
 */

import { settle } from './checks/measured.mjs';
import { collectMediaRules } from './checks/page-scripts.mjs';
import { newContextFor, visit } from './run.mjs';

const context = {
  role: 'user',
  theme: 'light',
  accent: 'neutral',
  viewport: '1280',
  language: 'en',
};

export async function runGlobalChecks({
  browser,
  baseUrl,
  accounts,
  routes,
  evidence,
  errors,
  log,
}) {
  log('whole-product checks');

  // 1.3.4: the content works in both orientations, and the manifest does not lock one.
  const person = accounts.user ?? accounts.restricted ?? accounts.admin;
  if (person) {
    evidence.sample(['1.3.4'], 'orientation', '/');
    const results = {};
    for (const [name, size] of [
      ['portrait', { width: 390, height: 844 }],
      ['landscape', { width: 844, height: 390 }],
    ]) {
      const browserContext = await browser.newContext({
        baseURL: baseUrl,
        storageState: person.state,
        viewport: size,
      });
      try {
        const page = await browserContext.newPage();
        await visit(page, '/');
        await settle(page);
        const seen = await page.evaluate(() => ({
          composer: Boolean(document.querySelector('[role="textbox"], textarea')),
          rotateMessage:
            /rotate (your|the) (device|phone|screen)|portrait mode|landscape mode/i.test(
              document.body.innerText,
            ),
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        }));
        const rules = await page.evaluate(collectMediaRules);
        results[name] = { ...seen, orientationRules: rules.orientationRules };
        if (!seen.composer || seen.rotateMessage) {
          evidence.finding({
            criteria: ['1.3.4'],
            check: 'orientation',
            rule: 'orientation-restricted',
            severity: 'serious',
            route: '/',
            context,
            message: `In ${name} the page ${seen.rotateMessage ? 'asks the person to rotate the device' : 'does not show the message box'}`,
            targets: ['body'],
          });
        }
      } finally {
        await browserContext.close();
      }
    }
    const manifest = await fetch(`${baseUrl}/api/manifest.webmanifest`).then(
      (response) => (response.ok ? response.json() : null),
      () => null,
    );
    results.manifestOrientation = manifest
      ? (manifest.orientation ?? 'not set')
      : 'manifest not readable';
    if (manifest && /^(portrait|landscape)/.test(manifest.orientation ?? '')) {
      evidence.finding({
        criteria: ['1.3.4'],
        check: 'orientation',
        rule: 'manifest-locks-orientation',
        severity: 'serious',
        route: '/api/manifest.webmanifest',
        context,
        message: `The web manifest locks the orientation to ${manifest.orientation}`,
        targets: ['manifest'],
      });
    }
    evidence.fact('orientation', 'results', results);
    evidence.limit(
      'orientation',
      'Two window shapes (390 by 844 and 844 by 390) on the chat home page, as a signed-in person, and the manifest. Other pages and a real device being turned are not tested.',
    );
  }

  // Each role is kept out of what it may not open, and old addresses still land somewhere.
  const checkPath = async (role, from, expected, label) => {
    const account = accounts[role];
    if (!account) return;
    const browserContext = await newContextFor(browser, {
      baseUrl,
      account,
      context: { ...context, role },
    });
    try {
      const page = await browserContext.newPage();
      const opened = await visit(page, from);
      evidence.fact('roleBoundaries', `${role} ${from}`, {
        landedOn: opened.path,
        expected,
        ok: opened.path === expected,
      });
      if (opened.path !== expected) {
        errors.push({
          route: from,
          check: label,
          message: `${role} opening ${from} landed on ${opened.path}, expected ${expected}`,
        });
      }
    } finally {
      await browserContext.close();
    }
  };
  for (const role of ['user', 'restricted']) await checkPath(role, '/admin', '/', 'role-boundary');
  for (const route of routes.filter((candidate) => candidate.kind === 'redirect')) {
    await checkPath(
      route.audience === 'admin' ? 'admin' : 'user',
      route.path,
      route.to,
      'redirect',
    );
  }
}
