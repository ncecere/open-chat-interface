/**
 * Runs the matrix: for each context (role, theme, accent, view, language) opens the routes the
 * role can reach and runs the checks `checksFor` names for it. Walkthroughs, orientation and the
 * other whole-product checks are in walkthroughs.mjs and global.mjs.
 */

import {
  axeCheck,
  contrastCheck,
  documentCheck,
  formsCheck,
  motionCheck,
  nonTextContrastCheck,
  reflowCheck,
  settle,
  targetSizeCheck,
  textResizeCheck,
  textSpacingCheck,
} from './checks/measured.mjs';
import { treeCheck } from './checks/tree.mjs';
import { checksFor, routesForRole, VIEWS } from './lib/matrix.mjs';
import { resolveConcretePath } from './lib/routes.mjs';

export const CHECKS = {
  axe: axeCheck,
  contrast: contrastCheck,
  'non-text': nonTextContrastCheck,
  targets: targetSizeCheck,
  'text-spacing': textSpacingCheck,
  'text-resize': textResizeCheck,
  reflow: reflowCheck,
  motion: motionCheck,
  forms: formsCheck,
  document: documentCheck,
  tree: treeCheck,
};

/** The language tag `<html lang>` should carry for a language the audit was asked to show. */
const expectedLanguage = (language) => language;

/** Opens a route and waits until it has rendered and stopped moving. */
export async function visit(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page
    .locator('main, [role="main"], h1')
    .first()
    .waitFor({ state: 'attached', timeout: 8_000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  await settle(page);
  return { status: response?.status() ?? 0, path: new URL(page.url()).pathname };
}

// Runs in the page before any script of its own: what a person's browser would already hold.
const setPreferences = ({ theme, accent, language }) => {
  try {
    localStorage.setItem('oci.theme', theme);
    localStorage.setItem('oci.colorTheme', accent);
    localStorage.removeItem('oci.pseudoLocale');
    if (language === 'en-XA' || language === 'ar-XB') {
      localStorage.setItem('oci.pseudoLocale', language);
    } else if (language !== 'en') {
      localStorage.setItem('oci.locale', language);
    }
  } catch {
    // Storage is blocked: the page shows its defaults, and the language check says so.
  }
};

function coverageEntry(coverage, route, role) {
  coverage[route] ??= {};
  coverage[route][role] ??= {};
  return coverage[route][role];
}

/** One browser context for one matrix entry, closed when the routes are done. */
export async function newContextFor(browser, { baseUrl, account, context }) {
  const view = VIEWS[context.viewport];
  const browserContext = await browser.newContext({
    baseURL: baseUrl,
    storageState: account?.state,
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.deviceScaleFactor ?? 1,
    reducedMotion: view.reducedMotion ?? 'no-preference',
    locale: context.language === 'ar' ? 'ar' : 'en-US',
    colorScheme: context.theme === 'dark' ? 'dark' : 'light',
  });
  await browserContext.addInitScript(setPreferences, {
    theme: context.theme,
    accent: context.accent,
    language: context.language,
  });
  return browserContext;
}

/**
 * @param {object} input
 * @param {import('playwright-core').Browser} input.browser
 * @param {string} input.baseUrl
 * @param {Array<object>} input.routes all routes from routes.json
 * @param {Record<string, { state?: object, params: Record<string, string> }>} input.accounts by role
 * @param {Array<object>} input.contexts one accent group of the matrix
 * @param {object} input.run the run's settings (themes, accents) and shared services
 */
export async function auditContexts({
  browser,
  baseUrl,
  routes,
  accounts,
  contexts,
  run,
  AxeBuilder,
  evidence,
  coverage,
  errors,
  log,
}) {
  const queue = [...contexts];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      await auditContext({
        browser,
        baseUrl,
        routes,
        accounts,
        context: entry,
        run,
        AxeBuilder,
        evidence,
        coverage,
        errors,
        log,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, run.concurrency) }, worker));
}

async function auditContext({
  browser,
  baseUrl,
  routes,
  accounts,
  context,
  run,
  AxeBuilder,
  evidence,
  coverage,
  errors,
  log,
}) {
  const account = context.role === 'anonymous' ? undefined : accounts[context.role];
  const wanted = checksFor({ ...context, themes: run.themes, accents: run.accents });
  if (wanted.length === 0) return;
  const browserContext = await newContextFor(browser, { baseUrl, account, context });
  const page = await browserContext.newPage();
  const params = account?.params ?? { slug: 'a11y-audit-missing' };
  try {
    for (const route of routesForRole(routes, context.role)) {
      if (run.routeFilter && !run.routeFilter.test(route.path)) continue;
      let url;
      try {
        url =
          route.kind === 'notfound'
            ? '/a11y-audit/no-such-page'
            : resolveConcretePath(route.path, { slug: 'a11y-audit-missing', ...params });
      } catch (error) {
        // No fixture for this role (it cannot have projects): said so, never counted as covered.
        coverageEntry(coverage, route.path, context.role).skipped = String(error.message);
        continue;
      }
      const opened = await visit(page, url).catch((error) => ({ failed: String(error.message) }));
      const key = `${context.role}`;
      coverage[route.path] ??= {};
      if (opened.failed) {
        errors.push({ route: route.path, check: 'open', message: opened.failed });
        coverage[route.path][key] = {
          ...(coverage[route.path][key] ?? {}),
          failed: (coverage[route.path][key]?.failed ?? 0) + 1,
        };
        continue;
      }
      const expected = route.kind === 'notfound' ? opened.path : url.split('?')[0];
      if (opened.path !== expected) {
        const entry = coverageEntry(coverage, route.path, key);
        entry.redirected = (entry.redirected ?? 0) + 1;
        entry.redirectedTo = opened.path;
        continue;
      }
      const entry = coverageEntry(coverage, route.path, key);
      entry.pages = (entry.pages ?? 0) + 1;
      const env = {
        evidence,
        route: route.path,
        context,
        AxeBuilder,
        ownDetails: Boolean(route.ownDetails),
        expectedLanguage: expectedLanguage(context.language),
        reduced: context.viewport === 'reduce',
      };
      for (const name of wanted) {
        try {
          await CHECKS[name](page, env);
        } catch (error) {
          errors.push({
            route: route.path,
            check: name,
            message: String(error.message).split('\n')[0],
          });
        }
      }
    }
  } finally {
    await browserContext.close();
  }
  log(
    `  done ${context.role}/${context.theme}/${context.accent}/${context.viewport}/${context.language}`,
  );
}
