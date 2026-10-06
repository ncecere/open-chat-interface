import { expect, type Page, test } from '@playwright/test';

/**
 * Providers & Models → Embeddings against a running instance. The test
 * database may or may not have pgvector enabled, so the page is checked
 * against what the API itself reports rather than a fixed state.
 */
async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  test.skip(!email || !password, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.beforeEach(async ({ page }) => signIn(page));

test('the Embeddings tab shows the pgvector state the API reports', async ({ page }) => {
  const response = await page.request.get('/api/admin/embeddings');
  expect(response.ok()).toBe(true);
  const status = (await response.json()) as {
    pgvector: { state: 'not-installed' | 'available' | 'enabled'; version: string | null };
  };

  await page.goto('/admin/models?tab=embeddings');
  await expect(page.getByRole('tab', { name: 'Embeddings', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const title = {
    'not-installed': 'pgvector is not installed on the database server',
    available: 'pgvector is installed but not enabled',
    enabled: `pgvector ${status.pgvector.version ?? ''} is enabled`,
  }[status.pgvector.state];
  await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  if (status.pgvector.state === 'available') {
    await expect(page.getByText('CREATE EXTENSION IF NOT EXISTS vector;')).toBeVisible();
  }
  // The Reranking section on the same tab has its own model id field.
  await expect(page.locator('#embeddings-model')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Search project files by meaning' })).toBeVisible();
});

test('the Embeddings tab has a Reranking section with the resolved endpoint', async ({ page }) => {
  const response = await page.request.get('/api/admin/reranking');
  expect(response.ok()).toBe(true);
  const status = (await response.json()) as { endpoint: string | null };

  await page.goto('/admin/models?tab=embeddings');
  await expect(page.getByRole('heading', { name: 'Reranking', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Rerank project search results' })).toBeVisible();
  await expect(page.getByText('Works with or without pgvector', { exact: false })).toBeVisible();
  // A saved provider that can no longer rerank shows no endpoint either. With
  // none, the field is empty and says why in its placeholder, not a value that
  // reads as an endpoint (#157).
  const endpoint = page.locator('#reranking-endpoint');
  await expect(endpoint).toHaveValue(status.endpoint ?? '');
  if (!status.endpoint) {
    await expect(endpoint).toHaveAttribute('placeholder', 'Shown once a provider is chosen');
  }
});

test('System health has a row for meaning-based search', async ({ page }) => {
  const response = await page.request.get('/api/admin/health');
  expect(response.ok()).toBe(true);
  const health = (await response.json()) as { checks: Array<{ id: string; label: string }> };
  expect(health.checks.map((check) => check.id)).toContain('embeddings');
});
