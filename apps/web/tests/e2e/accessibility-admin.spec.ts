import { expect, test } from '@playwright/test';
import { describeViolations, scan, signIn, storeThemeForProject } from './accessibility.helpers';

/**
 * WCAG 2.2 AA scans: administration pages and a dialog. What automation can
 * and cannot judge: accessibility.helpers.ts.
 */

storeThemeForProject();

test.describe('WCAG 2.2 AA: authenticated surfaces', () => {
  test('admin dashboard has no violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin general settings have no violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/settings/general');
    await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin roles and access has no violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/roles');
    await expect(page.getByRole('heading', { name: 'Roles & access', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Messages per minute')).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin connectors has no violations', async ({ page }) => {
    // A routed connector with a read and a write tool, so the tool controls are scanned too.
    const connectorTool = (id: string, name: string, kind: string, enabled: boolean) => ({
      id,
      toolId: `mcp__docs__${name}`,
      name,
      title: null,
      description: `The ${name} tool.`,
      kind,
      serverKind: kind,
      enabled,
      missing: false,
      lastSeenAt: '2026-10-01T10:00:00.000Z',
    });
    await page.route('**/api/admin/connectors', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          connectors: [
            {
              id: 'c1',
              name: 'Docs',
              slug: 'docs',
              url: 'https://mcp.example.test/mcp',
              authMode: 'shared',
              sharedHeaderName: 'Authorization',
              hasSharedCredential: true,
              oauthClientId: null,
              hasOauthClientSecret: false,
              oauthClientSource: null,
              oauthScopes: '',
              enabled: true,
              allowPrivateNetwork: false,
              accountCount: 0,
              lastContactAt: '2026-10-01T10:00:00.000Z',
              lastErrorAt: '2026-10-01T11:00:00.000Z',
              lastError: 'Docs did not respond in time.',
              oauthRedirectUrl: 'https://oci.example.test/api/connectors/oauth/callback',
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
              tools: [
                connectorTool('t1', 'search', 'read', true),
                connectorTool('t2', 'create_page', 'write', false),
              ],
            },
          ],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/admin/connectors');
    await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'search' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin backups has no violations', async ({ page }) => {
    // The real page against the live API: settings form, status and (empty) history.
    await signIn(page);
    await page.goto('/admin/backups');
    await expect(page.getByRole('heading', { name: 'Backups', level: 1 })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Back up automatically' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin compliance has no violations', async ({ page }) => {
    // The real page against the live API: status, settings, legal holds and history.
    await signIn(page);
    await page.goto('/admin/compliance');
    await expect(page.getByRole('heading', { name: 'Compliance', level: 1 })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Export automatically' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Include conversation content' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('admin webhooks has no violations', async ({ page }) => {
    // A routed endpoint with a failing delivery, so the card and its log are scanned too.
    await page.route('**/api/admin/webhooks', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          webhooks: [
            {
              id: 'w1',
              url: 'https://hooks.example.test/oci',
              description: 'SIEM',
              actions: ['user.*', 'backup.run'],
              allActions: false,
              enabled: true,
              allowPrivateNetwork: false,
              secretRotatedAt: '2026-10-01T09:00:00.000Z',
              lastSuccessAt: '2026-10-01T10:00:00.000Z',
              lastFailureAt: '2026-10-01T11:00:00.000Z',
              lastError: 'The endpoint answered HTTP 500.',
              pendingDeliveries: 1,
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
            },
          ],
        }),
      }),
    );
    await page.route('**/api/admin/webhooks/w1/deliveries', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          deliveries: [
            {
              id: 'd1',
              event: 'user.create',
              status: 'pending',
              attempts: 1,
              maxAttempts: 8,
              nextAttemptAt: '2026-10-01T11:01:00.000Z',
              lastAttemptAt: '2026-10-01T11:00:00.000Z',
              lastStatusCode: 500,
              lastError: 'The endpoint answered HTTP 500.',
              deliveredAt: null,
              createdAt: '2026-10-01T11:00:00.000Z',
            },
          ],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/admin/webhooks');
    await expect(page.getByRole('heading', { name: 'Webhooks', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Show deliveries' }).click();
    await expect(page.getByRole('table')).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('a dialog has no violations while open', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/quotas');
    await page.getByRole('button', { name: 'New budget' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });
});
