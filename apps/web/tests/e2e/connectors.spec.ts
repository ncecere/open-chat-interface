import { expect, type Page, test } from '@playwright/test';

/**
 * MCP connectors in the browser: an administrator enabling a connector tool,
 * and a person connecting and disconnecting their account.
 *
 * Self-contained so it runs on any seeded instance (no MCP server needed): the
 * connector APIs and the service's sign-in page are routed, backed by a small
 * in-test server state.
 */

const tool = (overrides: Record<string, unknown>) => ({
  description: '',
  title: null,
  missing: false,
  lastSeenAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

function adminConnector(searchEnabled: boolean) {
  return {
    id: 'c1',
    name: 'Docs',
    slug: 'docs',
    url: 'https://mcp.example.test/mcp',
    authMode: 'oauth',
    sharedHeaderName: 'Authorization',
    hasSharedCredential: false,
    oauthClientId: 'client-1',
    hasOauthClientSecret: true,
    oauthClientSource: 'dynamic',
    oauthScopes: '',
    enabled: true,
    allowPrivateNetwork: false,
    accountCount: 1,
    lastContactAt: '2026-10-01T10:00:00.000Z',
    lastErrorAt: null,
    lastError: null,
    oauthRedirectUrl: 'https://oci.example.test/api/connectors/oauth/callback',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    tools: [
      tool({
        id: 't1',
        toolId: 'mcp__docs__search',
        name: 'search',
        title: 'Search documents',
        description: 'Finds documents.',
        kind: 'read',
        serverKind: 'read',
        enabled: searchEnabled,
      }),
      tool({
        id: 't2',
        toolId: 'mcp__docs__create_page',
        name: 'create_page',
        description: 'Creates a page.',
        kind: 'write',
        serverKind: 'write',
        enabled: false,
      }),
    ],
  };
}

async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

test('an administrator enables a connector tool', async ({ page }) => {
  const server = { enabled: false, patches: [] as unknown[] };
  await page.route('**/api/admin/connectors', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ connectors: [adminConnector(server.enabled)] }),
    }),
  );
  await page.route('**/api/admin/connectors/c1/tools/t1', async (route) => {
    expect(route.request().method()).toBe('PATCH');
    const body = route.request().postDataJSON() as { enabled: boolean };
    server.patches.push(body);
    server.enabled = body.enabled;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(adminConnector(server.enabled).tools[0]),
    });
  });
  await signIn(page);
  await page.goto('/admin/connectors');

  await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
  const card = page.getByRole('region', { name: 'Docs' });
  await expect(card).toContainText('Each person signs in (OAuth)');
  await expect(card).toContainText('client registered by OCI');
  const toggle = card.getByRole('switch', { name: 'Search documents' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(server.patches).toEqual([{ enabled: true }]);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Docs' }).getByRole('switch', { name: 'Search documents' }),
  ).toBeChecked();
});

test('a person connects and disconnects their account', async ({ page }) => {
  const server = { connected: false, started: 0, disconnected: 0 };
  await page.route('**/api/connectors', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        connectors: [
          {
            id: 'c1',
            name: 'Docs',
            slug: 'docs',
            connected: server.connected,
            needsReconnect: false,
            toolCount: 1,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/connectors/c1/connect', (route) => {
    server.started++;
    expect(route.request().postDataJSON()).toEqual({ returnTo: 'settings' });
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ authorizationUrl: 'https://auth.example.test/authorize?state=s' }),
    });
  });
  // The service's sign-in page: approves at once and sends the browser back.
  await page.route('https://auth.example.test/**', (route) => {
    server.connected = true;
    return route.fulfill({
      status: 302,
      headers: { location: `${new URL(page.url()).origin}/settings/connectors?connected=docs` },
    });
  });
  await page.route('**/api/connectors/c1/account', (route) => {
    expect(route.request().method()).toBe('DELETE');
    server.disconnected++;
    server.connected = false;
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true,"revoked":true}' });
  });
  await signIn(page);
  await page.goto('/settings/connectors');

  await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
  await expect(page.getByText('Not connected')).toBeVisible();
  await page.getByRole('button', { name: 'Connect Docs', exact: true }).click();

  await expect(page).toHaveURL(/\/settings\/connectors\?connected=docs$/);
  await expect(page.getByText('Docs is connected.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Docs', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect Docs' }).click();
  await expect(page.getByRole('button', { name: 'Connect Docs', exact: true })).toBeVisible();
  expect(server).toEqual({ connected: false, started: 1, disconnected: 1 });
});
