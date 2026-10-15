import { expect, type Page, test } from '@playwright/test';
import { describeViolations, scan, signIn, storeThemeForProject } from './accessibility.helpers';
import {
  createAccount,
  enrolWithApi,
  signInPlain,
  signOutFromSettings,
  submitPassword,
  withVirtualAuthenticator,
} from './mfa.helpers';

/**
 * WCAG 2.2 AA scans of every two-step verification screen (#399), in the three
 * projects (desktop, phone, light theme). What automation can and cannot judge:
 * accessibility.helpers.ts. The explicit criteria it cannot see (autocomplete
 * tokens, no length limit, paste) are asserted in mfa.spec.ts.
 *
 * Accounts are fresh ones; the seeded administrator is only read from.
 */

storeThemeForProject();

async function clean(page: Page, where: string) {
  const results = await scan(page);
  expect(describeViolations(results), `${where}\n${describeViolations(results)}`).toBe('');
}

test.describe('WCAG 2.2 AA: second step of sign-in', () => {
  test('the code, a refusal, the recovery code and the end of the attempt', async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    const account = await createAccount(browser);
    await signInPlain(page, account);
    await enrolWithApi(page, account);
    await signOutFromSettings(page);

    await submitPassword(page, account);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Two-step verification' }),
    ).toBeVisible();
    await clean(page, 'second step');

    await page.getByLabel('Authentication code', { exact: true }).fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await clean(page, 'second step, wrong code');

    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await expect(page.getByLabel('Recovery code', { exact: true })).toBeVisible();
    await clean(page, 'second step, recovery code');

    // No challenge is pending any more: the page ends the attempt rather than ask again.
    await page.context().clearCookies();
    await page.goto('/auth/two-factor');
    await page.getByLabel('Authentication code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('link', { name: 'Start again' })).toBeVisible();
    await clean(page, 'second step, start again');
  });

  test('the sign-in page with the passkey button', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('button', { name: 'Use a passkey', exact: true })).toBeVisible();
    await clean(page, 'sign-in with passkey');
  });
});

test.describe('WCAG 2.2 AA: Settings → Account → Two-step verification', () => {
  test('off: setting up an authenticator, step by step', async ({ browser, page }) => {
    const account = await createAccount(browser);
    await signInPlain(page, account);
    await page.goto('/settings');
    await expect(page.getByText(/Status:\s*Off/)).toBeVisible();
    await clean(page, 'two-step off');

    await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
    await expect(page.getByLabel('Current password')).toBeVisible();
    await clean(page, 'enrol: password');

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Current password')).toHaveAttribute('aria-invalid', 'true');
    await clean(page, 'enrol: password refused');

    await page.getByLabel('Current password').fill(account.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('manual-key')).toBeVisible();
    await clean(page, 'enrol: QR code, key and code');

    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByLabel('Authentication code', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await clean(page, 'enrol: code missing');
  });

  test('on: recovery codes, new codes and turning it off', async ({ browser, page }) => {
    const account = await createAccount(browser);
    await signInPlain(page, account);
    await enrolWithApi(page, account);
    await page.goto('/settings');
    await expect(page.getByText(/Status:\s*On/)).toBeVisible();
    await clean(page, 'two-step on');

    await page.getByRole('button', { name: 'Get new recovery codes' }).click();
    const regenerate = page.getByRole('dialog', { name: 'Get new recovery codes' });
    await expect(regenerate).toBeVisible();
    await clean(page, 'new recovery codes dialog');
    await regenerate.getByRole('button', { name: 'Get new codes' }).click();
    await expect(regenerate.getByLabel('Current password')).toHaveAttribute('aria-invalid', 'true');
    await clean(page, 'new recovery codes dialog, fields missing');
    await regenerate.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Turn off the authenticator app?' }),
    ).toBeVisible();
    await clean(page, 'turn off dialog');
  });

  test('passkeys: the list and each dialog', async ({ browser, page, context }) => {
    const account = await createAccount(browser);
    await withVirtualAuthenticator(context, page);
    await signInPlain(page, account);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByRole('dialog', { name: 'Add a passkey' })).toBeVisible();
    await clean(page, 'add a passkey dialog');
    await page.getByRole('dialog').getByLabel('Name').fill('Scanned key');
    await page.getByRole('button', { name: 'Add passkey' }).click();
    await expect(page.getByTestId('passkey')).toHaveCount(1);
    await clean(page, 'passkey list');

    await page.getByRole('button', { name: 'Rename Scanned key' }).click();
    await expect(page.getByRole('dialog', { name: 'Rename passkey' })).toBeVisible();
    await clean(page, 'rename passkey dialog');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Remove Scanned key' }).click();
    await expect(page.getByRole('dialog', { name: 'Remove this passkey?' })).toBeVisible();
    await clean(page, 'remove passkey dialog');
  });

  test('a browser without passkeys says so', async ({ browser, context, page }) => {
    const account = await createAccount(browser);
    await context.addInitScript(() => {
      delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    });
    await signInPlain(page, account);
    await page.goto('/settings');
    await expect(page.getByText('This browser cannot make passkeys.')).toBeVisible();
    await clean(page, 'no WebAuthn');
  });
});

test.describe('WCAG 2.2 AA: the setup page of a limited person', () => {
  /** The server limits only under a requirement, a setting of the whole instance: the answers are staged. */
  async function limited(page: Page, mfa: Record<string, unknown>) {
    await page.route('**/api/me', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { mfa: Record<string, unknown> };
      await route.fulfill({ response, json: { ...body, mfa: { ...body.mfa, ...mfa } } });
    });
    await page.route('**/api/me/mfa', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, ...mfa } });
    });
  }

  test('with nothing set up: enrolment and sign out', async ({ browser, page }) => {
    const account = await createAccount(browser);
    await signInPlain(page, account);
    await limited(page, { required: true, limited: true, deadline: '2026-01-01T12:00:00.000Z' });
    await page.goto('/auth/mfa-setup');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up two-step verification' }),
    ).toBeVisible();
    await clean(page, 'setup page');
    await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
    await expect(page.getByLabel('Current password')).toBeVisible();
    await clean(page, 'setup page, password');
  });

  test('with a second step but a password-only session: sign in again', async ({
    browser,
    page,
  }) => {
    const account = await createAccount(browser);
    await signInPlain(page, account);
    await limited(page, {
      required: true,
      limited: true,
      enrolled: true,
      methods: ['totp'],
      recoveryCodesLeft: 10,
    });
    await page.goto('/auth/mfa-setup');
    await expect(page.getByText(/this session was opened with your password only/)).toBeVisible();
    await clean(page, 'setup page, sign in again');
  });
});

test.describe('WCAG 2.2 AA: administration', () => {
  test('the requirement on Authentication settings', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/settings/authentication');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Two-step verification' }),
    ).toBeVisible();
    await expect(page.getByRole('row', { name: /^Restricted/ })).toBeVisible();
    await clean(page, 'requirement');

    await page.getByRole('checkbox', { name: 'Restricted' }).check();
    await page.getByLabel('Grace period (days)').fill('0');
    await expect(
      page.getByRole('alert').filter({ hasText: 'limited at their next request' }),
    ).toBeVisible();
    await clean(page, 'requirement, grace 0');

    await page.getByLabel('Grace period (days)').fill('400');
    await page
      .getByRole('button', { name: 'Save changes to the two-step verification requirement' })
      .click();
    await expect(page.getByLabel('Grace period (days)')).toHaveAttribute('aria-invalid', 'true');
    await clean(page, 'requirement, grace refused');
  });

  test("a person's second step and the reset dialog", async ({ browser, page }) => {
    const account = await createAccount(browser);
    const context = await browser.newContext();
    const person = await context.newPage();
    await signInPlain(person, account);
    await enrolWithApi(person, account);
    const me = (await (await person.request.get('/api/me')).json()) as { user: { id: string } };
    await context.close();

    await signIn(page);
    await page.goto(`/admin/users/${me.user.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Two-step verification' }),
    ).toBeVisible();
    await clean(page, 'person, second step');
    await page.getByRole('button', { name: 'Reset two-step verification' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await clean(page, 'reset dialog');
  });
});
