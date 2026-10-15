import { expect, test } from '@playwright/test';
import { DESKTOP, describe, measure, open, provideScene, scene } from './fixtures/a11y-scene';

/**
 * Regression test for D5 of the defects `pnpm a11y:audit` found (#401,
 * docs/accessibility/findings.md): the Pin, Rename and Archive buttons on a conversation row
 * (2.5.8 Target Size, and the 2.4.11 review item that they cover the link). It runs the audit's own
 * target-size check on the real sidebar. It needs a seeded instance and the web app built; the
 * viewport is set here, so the mobile project leaves this file out (playwright.config.ts).
 */

provideScene();

test.describe('D5: the actions on a conversation row (2.5.8, 2.4.11)', () => {
  test('are 24 px or more, and clear of the link they belong to', async ({ browser }) => {
    const { page, context } = await open(browser, scene.admin.state, { size: DESKTOP });
    try {
      const found = await measure(page, '/', 'targetSizeCheck');
      expect(found.length, describe(found)).toBe(0);

      const link = page.locator(`a[href="/chat/${scene.thread.id}"]`);
      await link.focus();
      const buttons = link.locator('xpath=..').getByRole('button');
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all()) {
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box?.width, 'width').toBeGreaterThanOrEqual(24);
        expect(box?.height, 'height').toBeGreaterThanOrEqual(24);
      }
      // The audit's own test of a focused element: is anything else on top of five points of it.
      const covered = await link.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const points = [
          [0.5, 0.5],
          [0.1, 0.2],
          [0.9, 0.2],
          [0.1, 0.8],
          [0.9, 0.8],
        ] as const;
        return points.filter(([fx, fy]) => {
          const top = document.elementsFromPoint(
            rect.left + rect.width * fx,
            rect.top + rect.height * fy,
          )[0];
          return top && !node.contains(top) && !top.contains(node);
        }).length;
      });
      expect(covered, 'points of the focused link covered by its own buttons').toBe(0);
    } finally {
      await context.close();
    }
  });
});
