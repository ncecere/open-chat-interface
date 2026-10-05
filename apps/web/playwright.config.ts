import { defineConfig, devices } from '@playwright/test';

/**
 * Specs that need the deterministic browser-performance fixture
 * (apps/api/test/browser-performance): its 2,000-message conversation and
 * stub model. CI's seeded run leaves them out (E2E_SEEDED=1) and runs them in
 * a separate step against the fixture; locally, e2e against the fixture runs
 * everything. Left out, never skipped.
 */
export const FIXTURE_SPECS = ['**/long-conversation.spec.ts'];

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: process.env.E2E_SEEDED === '1' ? FIXTURE_SPECS : [],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['line']] : 'line',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    // The instance falls back to the dark theme, so the scans above never saw
    // light, where every AA contrast failure the QA walk found was (#72). The
    // specs store the light theme for projects whose name ends in -light.
    {
      name: 'chromium-light',
      testMatch: '**/accessibility-*.spec.ts',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
  ],
});
