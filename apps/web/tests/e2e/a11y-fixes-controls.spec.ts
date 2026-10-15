import { expect, test } from '@playwright/test';
import {
  ACCENTS,
  describe,
  type Finding,
  measure,
  open,
  provideScene,
  scene,
} from './fixtures/a11y-scene';

/**
 * Regression test for D1 of the defects `pnpm a11y:audit` found (#401,
 * docs/accessibility/findings.md): the edge of a form control (1.4.11). It runs the audit's own
 * check on the real page, so the page is held to the measurement the report is. It needs a seeded
 * instance and the web app built, like the other browser specs; the viewport is set here, so the
 * mobile project leaves this file out (playwright.config.ts).
 */

provideScene();

test.describe('D1: the edge of a form control is 3:1 against what is around it (1.4.11)', () => {
  // The message box and the model picker under it are in components/chat, translated by another
  // change; they are left out here and listed in docs/accessibility/findings.md.
  const inChat = (finding: Finding) =>
    finding.targets.some((target) => /div\.border\.px-4 > /.test(target));

  const signedIn = ['/', '/settings/customization', '/admin/settings/general', '/admin/audit'];

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: fields, selects, switches and the search field, in every accent`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const found: Finding[] = [];
      for (const accent of ACCENTS) {
        const { page, context } = await open(browser, scene.admin.state, { theme, accent });
        try {
          for (const url of signedIn) {
            found.push(...(await measure(page, url, 'nonTextContrastCheck')));
          }
        } finally {
          await context.close();
        }
      }
      const failing = found.filter(
        (finding) => finding.rule === 'field-boundary-contrast' && !inChat(finding),
      );
      expect(failing.length, describe(failing)).toBe(0);
    });
  }

  test('the sign-in page, light and dark', async ({ browser }) => {
    const found: Finding[] = [];
    for (const theme of ['light', 'dark'] as const) {
      const { page, context } = await open(browser, undefined, { theme });
      try {
        found.push(...(await measure(page, '/auth/login', 'nonTextContrastCheck')));
      } finally {
        await context.close();
      }
    }
    expect(found.length, describe(found)).toBe(0);
  });
});
