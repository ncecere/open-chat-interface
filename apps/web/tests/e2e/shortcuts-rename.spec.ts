import { expect, type Page, test } from '@playwright/test';

/**
 * Real keyboard input against the real API: the global shortcuts from the
 * composer (⌘ on a Mac, Ctrl elsewhere), and renaming a conversation with
 * Enter to save and Escape to cancel.
 */

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

/** Same-origin from the page, so the session cookie and origin are the browser's own. */
async function createThread(page: Page, title: string): Promise<string> {
  return page.evaluate(async (name) => {
    const response = await fetch('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: name }),
    });
    if (!response.ok) throw new Error(`Create failed: ${response.status}`);
    return ((await response.json()) as { thread: { id: string } }).thread.id;
  }, title);
}

async function sidebarTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch('/api/threads?view=sidebar');
    const body = (await response.json()) as { threads: Array<{ title: string }> };
    return body.threads.map((thread) => thread.title);
  });
}

/** The modifier the app announces, so the test presses what a person on this platform would. */
async function modifier(page: Page): Promise<'Meta' | 'Control'> {
  const toggle = page.locator('[aria-label="Close sidebar"], [aria-label="Open sidebar"]').first();
  const shortcut = await toggle.getAttribute('aria-keyshortcuts');
  expect(shortcut).toMatch(/^(Meta|Control)\+B$/);
  return shortcut!.startsWith('Meta') ? 'Meta' : 'Control';
}

test('the global shortcuts work from the composer', async ({ page }) => {
  await signIn(page);
  const mod = await modifier(page);
  const composer = page.getByRole('textbox', { name: 'Message input' });
  const sidebar = page.locator('aside');
  const hidden = async () => (await sidebar.getAttribute('aria-hidden')) === 'true';

  await composer.click();
  const before = await hidden();
  await page.keyboard.press(`${mod}+B`);
  await expect.poll(hidden).toBe(!before);
  await page.keyboard.press(`${mod}+B`);
  await expect.poll(hidden).toBe(before);

  await composer.click();
  await page.keyboard.press(`${mod}+/`);
  await expect(page.getByRole('dialog', { name: 'Choose a model' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search models' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Choose a model' })).toBeHidden();

  const id = await createThread(page, 'Shortcut source');
  await page.goto(`/chat/${id}`);
  await composer.click();
  await page.keyboard.press(`${mod}+Shift+O`);
  await expect(page).toHaveURL(/\/$/);
});

test('renames a conversation with Enter, and Escape cancels', async ({ page }) => {
  await signIn(page);
  const original = `Rename source ${Date.now()}`;
  const renamed = `Renamed ${Date.now()}`;
  const id = await createThread(page, original);
  await page.goto(`/chat/${id}`);

  const rename = page.getByRole('button', { name: 'Rename conversation' });
  await rename.click();
  const field = page.getByRole('dialog', { name: 'Rename conversation' }).getByLabel('Name');
  await expect(field).toHaveValue(original);
  await field.fill('Not this one');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Rename conversation' })).toBeHidden();
  expect(await sidebarTitles(page)).toContain(original);

  await rename.click();
  await field.fill(`  ${renamed}  `);
  await field.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Rename conversation' })).toBeHidden();
  await expect.poll(() => sidebarTitles(page)).toContain(renamed);

  // The open conversation knows its new name straight away.
  await rename.click();
  await expect(field).toHaveValue(renamed);
  await page.keyboard.press('Escape');
});
