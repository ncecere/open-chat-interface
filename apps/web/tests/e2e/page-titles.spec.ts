import { expect, type Page, test } from '@playwright/test';

/**
 * Pages name themselves in the tab and have a level-one heading (#110):
 * chat and project pages were all just the app name, every settings tab was
 * "Settings", and conversations and sign-in had no h1.
 */

async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  // Sign-in has its heading too.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Sign in to /);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

test('conversations, projects and settings sections name themselves', async ({ page }) => {
  await signIn(page);
  const title = `Walk titled conversation ${Date.now()}`;
  const thread = await page.request.post('/api/threads', { data: { title } });
  expect(thread.ok()).toBe(true);
  const { thread: created } = (await thread.json()) as { thread: { id: string } };
  await page.goto(`/chat/${created.id}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeAttached();
  await expect(page).toHaveTitle(new RegExp(`^${title} · `));

  const name = `Walk titled project ${Date.now()}`;
  const project = await page.request.post('/api/projects', { data: { name } });
  expect(project.ok()).toBe(true);
  const { project: made } = (await project.json()) as { project: { id: string } };
  try {
    await page.goto(`/projects/${made.id}`);
    await expect(page).toHaveTitle(new RegExp(`^${name} · `));
  } finally {
    await page.request.delete(`/api/projects/${made.id}`);
    await page.request.delete(`/api/threads/${created.id}`);
  }

  await page.goto('/settings/memory');
  await expect(page).toHaveTitle(/^Memory · Settings · /);
});
