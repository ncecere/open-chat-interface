import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';

/**
 * Negative controls for `pnpm a11y:audit` (scripts/a11y-audit, #401).
 *
 * An automated check that has never been seen to fail proves nothing: a conformance report
 * built on it would be a statement about the script, not the app. Each check of the audit is
 * run here against scripts/a11y-audit/fixtures/broken.html, which has one known defect per
 * check, and must flag it; and against clean.html, the same kinds of content done properly,
 * which it must not flag. No server is needed: the fixtures are local files.
 */

const AUDIT = fileURLToPath(new URL('../../../../scripts/a11y-audit/', import.meta.url));
const BROKEN = pathToFileURL(join(AUDIT, 'fixtures', 'broken.html')).href;
const CLEAN = pathToFileURL(join(AUDIT, 'fixtures', 'clean.html')).href;

const load = (file: string) => import(pathToFileURL(join(AUDIT, file)).href);

const context = {
  role: 'control',
  theme: 'light',
  accent: 'neutral',
  viewport: 1280,
  language: 'en',
};

interface Finding {
  rule: string;
  criteria: string[];
  severity: string;
  targets: string[];
  message: string;
}

/** A fresh browser context, so the project's own device emulation does not leak in. */
async function open(
  browser: Browser,
  url: string,
  options: { width?: number; height?: number; reducedMotion?: 'reduce' | 'no-preference' } = {},
) {
  const browserContext = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    reducedMotion: options.reducedMotion ?? 'no-preference',
  });
  const page = await browserContext.newPage();
  await page.goto(url);
  return { page, close: () => browserContext.close() };
}

async function run(
  browser: Browser,
  url: string,
  check: (page: Page, env: Record<string, unknown>) => Promise<unknown>,
  options: Parameters<typeof open>[2] & { env?: Record<string, unknown> } = {},
) {
  const { createEvidence } = await load('lib/evidence.mjs');
  const evidence = createEvidence();
  const { page, close } = await open(browser, url, options);
  try {
    await check(page, { evidence, route: '/control', context, AxeBuilder, ...options.env });
  } finally {
    await close();
  }
  const json = evidence.toJSON();
  return { json, findings: json.findings as Finding[] };
}

const rules = (findings: Finding[]) => findings.map((finding) => finding.rule);

test.describe('the audit checks can fail, and do not flag a page that is right', () => {
  test('axe flags the broken page and finds nothing serious on the clean one', async ({
    browser,
  }) => {
    const { axeCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, axeCheck);
    expect(rules(broken.findings)).toEqual(
      expect.arrayContaining(['color-contrast', 'label', 'document-title', 'html-has-lang']),
    );
    const clean = await run(browser, CLEAN, axeCheck);
    expect(clean.findings.filter((f) => ['serious', 'critical'].includes(f.severity))).toEqual([]);
    expect(clean.json.criteria['1.4.3'].samples).toBeGreaterThan(0);
  });

  test('1.4.3 contrast flags light grey text and passes dark grey', async ({ browser }) => {
    const { contrastCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, contrastCheck);
    const flagged = broken.findings.filter((f) => f.rule === 'text-contrast');
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0].criteria).toEqual(['1.4.3']);
    expect(flagged[0].message).toMatch(/#999999 on #ffffff is 2\.8\d:1/);
    const clean = await run(browser, CLEAN, contrastCheck);
    expect(clean.findings).toEqual([]);
    expect(Object.keys(clean.json.contrastPairs)).toEqual(['light/neutral']);
  });

  test('1.4.11 flags a pale field edge and a pale icon, and passes strong ones', async ({
    browser,
  }) => {
    const { nonTextContrastCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, nonTextContrastCheck);
    expect(rules(broken.findings)).toEqual(
      expect.arrayContaining(['field-boundary-contrast', 'icon-contrast']),
    );
    const clean = await run(browser, CLEAN, nonTextContrastCheck);
    expect(clean.findings).toEqual([]);
    expect(clean.json.checks['non-text-contrast'].counters['field-boundaries']).toBeGreaterThan(0);
  });

  test('2.5.8 flags two 10px buttons 4px apart and passes 44px targets', async ({ browser }) => {
    const { targetSizeCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, targetSizeCheck);
    const tiny = broken.findings.filter((f) => f.rule === 'target-size');
    expect(tiny.map((f) => f.targets[0])).toContain('div#content > p > button.tiny');
    const clean = await run(browser, CLEAN, targetSizeCheck);
    expect(clean.findings).toEqual([]);
    expect(clean.json.checks['target-size'].counters.targets).toBeGreaterThan(3);
  });

  test('1.4.12 flags a box that clips once text spacing grows, and passes one that grows', async ({
    browser,
  }) => {
    const { textSpacingCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, textSpacingCheck);
    const clipped = broken.findings.filter((f) => f.rule === 'text-spacing-clipping');
    expect(clipped.map((f) => f.targets[0])).toContain('div.clip');
    const clean = await run(browser, CLEAN, textSpacingCheck);
    expect(clean.findings).toEqual([]);
  });

  test('1.4.4 flags text that outgrows a pixel-sized box at 200%', async ({ browser }) => {
    const { textResizeCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, textResizeCheck);
    const clipped = broken.findings.filter((f) => f.rule === 'text-resize-clipping');
    expect(clipped.map((f) => f.targets[0])).toContain('div.clip-rem');
    const clean = await run(browser, CLEAN, textResizeCheck);
    expect(clean.findings).toEqual([]);
  });

  test('1.4.10 flags sideways scrolling at 320px and passes a page that reflows', async ({
    browser,
  }) => {
    const { reflowCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, reflowCheck, { width: 320, height: 640 });
    expect(rules(broken.findings)).toEqual(['two-dimensional-scroll']);
    expect(broken.findings[0].targets).toContain('div.wide');
    const clean = await run(browser, CLEAN, reflowCheck, { width: 320, height: 640 });
    expect(clean.findings).toEqual([]);
    // At desktop width the same broken page is fine: the check is about the narrow window.
    const desktop = await run(browser, BROKEN, reflowCheck);
    expect(desktop.findings).toEqual([]);
  });

  test('2.2.2 flags endless motion, and a stylesheet that honours reduced motion passes', async ({
    browser,
  }) => {
    const { motionCheck } = await load('checks/measured.mjs');
    const reduced = await run(browser, BROKEN, motionCheck, {
      reducedMotion: 'reduce',
      env: { reduced: true },
    });
    expect(rules(reduced.findings)).toEqual(['animation-ignores-reduced-motion']);
    expect(reduced.findings[0].severity).toBe('moderate');
    const normal = await run(browser, BROKEN, motionCheck, { env: { reduced: false } });
    expect(rules(normal.findings)).toEqual(['auto-starting-motion']);
    // The clean page's spinner is a loading indicator and stops under reduced motion.
    const clean = await run(browser, CLEAN, motionCheck, {
      reducedMotion: 'reduce',
      env: { reduced: true },
    });
    expect(clean.findings).toEqual([]);
    const cleanNormal = await run(browser, CLEAN, motionCheck, { env: { reduced: false } });
    expect(cleanNormal.findings).toEqual([]);
  });

  test('1.3.5 and 3.3.8 flag missing autocomplete tokens and a refused paste', async ({
    browser,
  }) => {
    const { formsCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, formsCheck, { env: { ownDetails: true } });
    expect(rules(broken.findings)).toEqual(
      expect.arrayContaining(['autocomplete-missing', 'paste-blocked']),
    );
    const clean = await run(browser, CLEAN, formsCheck, { env: { ownDetails: true } });
    expect(clean.findings).toEqual([]);
    expect(clean.json.criteria['3.3.8'].samples).toBe(1);
  });

  test('2.4.2, 3.1.1, 1.3.1 and 1.4.4 flag a page with no title, language, main or zoom', async ({
    browser,
  }) => {
    const { documentCheck } = await load('checks/measured.mjs');
    const broken = await run(browser, BROKEN, documentCheck, { env: { expectedLanguage: 'en' } });
    expect(rules(broken.findings)).toEqual(
      expect.arrayContaining([
        'page-without-title',
        'page-without-language',
        'no-main-landmark',
        'zoom-disabled',
      ]),
    );
    const clean = await run(browser, CLEAN, documentCheck, { env: { expectedLanguage: 'en' } });
    expect(clean.findings).toEqual([]);
  });

  test('the language and direction of a page are held to what was asked for', async ({
    browser,
  }) => {
    const { documentCheck } = await load('checks/measured.mjs');
    const wrong = await run(browser, CLEAN, documentCheck, { env: { expectedLanguage: 'ar' } });
    expect(rules(wrong.findings)).toEqual(
      expect.arrayContaining(['language-mismatch', 'direction-mismatch']),
    );
  });

  test('4.1.2 reads the accessibility tree: an empty button and a checkbox with no state', async ({
    browser,
  }) => {
    const { treeCheck } = await load('checks/tree.mjs');
    const broken = await run(browser, BROKEN, treeCheck);
    expect(rules(broken.findings)).toEqual(
      expect.arrayContaining(['control-without-name', 'control-without-state']),
    );
    // The unlabelled text field is also the 3.3.2 failure: a field with no name has no label.
    const field = broken.findings.find((f) => f.targets.includes('div > p > input'));
    expect(field?.criteria).toEqual(['4.1.2', '3.3.2', '1.3.1']);
    const clean = await run(browser, CLEAN, treeCheck);
    expect(clean.findings).toEqual([]);
  });

  test('2.4.7, 2.4.11 and 2.1.2 flag a removed focus ring, a covered link and a trap', async ({
    browser,
  }) => {
    const { walkTabs } = await load('checks/keyboard.mjs');
    let broken: Awaited<ReturnType<typeof walkTabs>> | undefined;
    const result = await run(browser, BROKEN, async (page, env) => {
      broken = await walkTabs(page, { ...env, label: 'control', limit: 40 });
    });
    const byRule = new Map(result.findings.map((finding) => [finding.rule, finding]));
    expect(byRule.get('no-focus-indicator')?.targets).toEqual(['a.noring']);
    expect(byRule.get('focus-obscured')?.message).toMatch(/Link under the bar/);
    expect(byRule.get('keyboard-trap')?.criteria).toEqual(['2.1.2']);
    expect(broken?.trapped).toBe(true);

    let cleanWalk: Awaited<ReturnType<typeof walkTabs>> | undefined;
    const clean = await run(browser, CLEAN, async (page, env) => {
      cleanWalk = await walkTabs(page, { ...env, label: 'control', limit: 40 });
    });
    expect(clean.findings).toEqual([]);
    expect(cleanWalk?.reachedEnd).toBe(true);
    expect(cleanWalk?.stops.length).toBeGreaterThan(5);
  });

  test('2.4.1 finds a skip link that works, and none on a page without one', async ({
    browser,
  }) => {
    const { skipLinkCheck } = await load('checks/keyboard.mjs');
    let cleanWorks: unknown;
    const clean = await run(browser, CLEAN, async (page, env) => {
      cleanWorks = await skipLinkCheck(page, env);
    });
    expect(cleanWorks).toBe(true);
    expect(clean.findings).toEqual([]);
    let brokenWorks: unknown;
    await run(browser, BROKEN, async (page, env) => {
      brokenWorks = await skipLinkCheck(page, env);
    });
    expect(brokenWorks).toBe(false);
  });
});
