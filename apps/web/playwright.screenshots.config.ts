import { defineConfig, devices } from '@playwright/test';

/**
 * Documentation captures, kept apart from the end-to-end suite.
 *
 * These sign in and photograph the interface rather than asserting anything,
 * so they must never run in CI: a failure here means an image is stale, not
 * that the application is broken.
 *
 * Run serially. Several captures change instance state — opening a dialog,
 * applying a filter — and parallel workers would photograph each other's
 * changes.
 */
export default defineConfig({
  testDir: './tests/screenshots',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    // Retina, so the images stay legible when a reader zooms a screenshot of
    // small print such as an audit identifier.
    deviceScaleFactor: 2,
    // Freezes transitions, which otherwise capture a half-faded panel.
    reducedMotion: 'reduce',
  },
  /*
   * Each project takes only its own files.
   *
   * A shared pattern makes the mobile project re-run every desktop capture at
   * a phone viewport and overwrite the images under the same names, which
   * looks like the whole set was photographed on a phone.
   */
  projects: [
    {
      name: 'desktop',
      testMatch: /(admin|user)\.shot\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.shot\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],
});
