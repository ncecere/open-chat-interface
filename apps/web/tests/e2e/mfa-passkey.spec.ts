import { expect, test } from '@playwright/test';
import {
  createAccount,
  enrolWithApi,
  expectInApp,
  signInPlain,
  signOutFromSettings,
  submitPassword,
  withVirtualAuthenticator,
} from './mfa.helpers';

/**
 * Passkeys (#399) in Chromium with a virtual authenticator over the DevTools
 * protocol (`WebAuthn.enable`, `addVirtualAuthenticator`): CTAP2, internal
 * transport, resident keys, user verification on, presence simulated. Both the
 * desktop and the mobile project are Chromium, so nothing is skipped. The
 * app's origin is `localhost`, not an IP address, which WebAuthn refuses as a
 * relying party; the API's APP_URL is the same origin.
 */

/**
 * With a passkey in the virtual authenticator, Chromium answers the sign-in
 * page's conditional request (the browser offering passkeys in the email field)
 * by itself, without anyone choosing one, so the page would sign in the moment
 * it is opened. A person has to choose; tests that use the button or the
 * password turn the offer off, and one test relies on it.
 */
async function withoutConditionalOffer(context: import('@playwright/test').BrowserContext) {
  await context.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });
}

test.describe('passkeys', () => {
  test('are added, used to sign in without a password, renamed and removed', async ({
    browser,
  }) => {
    const account = await createAccount(browser);
    const context = await browser.newContext();
    await withoutConditionalOffer(context);
    const page = await context.newPage();
    await withVirtualAuthenticator(context, page);
    await signInPlain(page, account);

    // Add one: an optional name, then the browser's own prompt (the virtual authenticator answers).
    await page.goto('/settings');
    await expect(page.getByText('No passkeys yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    const adding = page.getByRole('dialog', { name: 'Add a passkey' });
    await adding.getByLabel('Name').fill('Virtual key');
    await adding.getByRole('button', { name: 'Add passkey' }).click();
    await expect(adding).toBeHidden();
    await expect(page.getByText('Passkey added.')).toBeVisible();
    const row = page.getByTestId('passkey').filter({ hasText: 'Virtual key' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Added ');
    await expect(page.getByText(/Status:\s*On/)).toBeVisible();

    // Sign out; the sign-in page offers the passkey, which is the whole sign-in.
    await signOutFromSettings(page);
    await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expectInApp(page);
    // The session is the passkey's: it can manage the account without a second step.
    const me = await page.request.get('/api/me');
    const body = (await me.json()) as { mfa: { enrolled: boolean; methods: string[] } };
    expect(body.mfa.enrolled).toBe(true);
    expect(body.mfa.methods).toEqual(['passkey']);

    // Rename it.
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Rename Virtual key' }).click();
    const renaming = page.getByRole('dialog', { name: 'Rename passkey' });
    await renaming.getByLabel('Name').fill('Laptop key');
    await renaming.getByRole('button', { name: 'Save name' }).click();
    await expect(renaming).toBeHidden();
    await expect(page.getByText('Passkey renamed.')).toBeVisible();
    await expect(page.getByTestId('passkey').filter({ hasText: 'Laptop key' })).toBeVisible();

    // Remove it, after being asked.
    await page.getByRole('button', { name: 'Remove Laptop key' }).click();
    const removing = page.getByRole('dialog', { name: 'Remove this passkey?' });
    await expect(removing).toContainText('Laptop key');
    await removing.getByRole('button', { name: 'Remove passkey' }).click();
    await expect(removing).toBeHidden();
    await expect(page.getByText('Passkey removed.')).toBeVisible();
    await expect(page.getByText('No passkeys yet.')).toBeVisible();
    await expect(page.getByText(/Status:\s*Off/)).toBeVisible();
    await context.close();
  });

  test('are offered at the second step as the way in that needs no code', async ({ browser }) => {
    test.setTimeout(120_000);
    const account = await createAccount(browser);
    const context = await browser.newContext();
    await withoutConditionalOffer(context);
    const page = await context.newPage();
    await withVirtualAuthenticator(context, page);
    await signInPlain(page, account);
    await enrolWithApi(page, account);

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await page.getByRole('button', { name: 'Add passkey' }).click();
    await expect(page.getByText('Passkey added.')).toBeVisible();
    await expect(page.getByText('10 recovery codes left.')).toBeVisible();

    await signOutFromSettings(page);
    await submitPassword(page, account);
    await expect(page).toHaveURL(/\/auth\/two-factor/);
    await page.getByRole('button', { name: 'Use a passkey instead' }).click();
    await expectInApp(page);
    await context.close();
  });

  test('are offered by the browser itself in the email field, where it can', async ({
    browser,
  }) => {
    const account = await createAccount(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    await withVirtualAuthenticator(context, page);
    await page.goto('/auth/login');
    // Chromium can do conditional UI: the field carries the `webauthn` autofill token.
    await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'email webauthn');
    await signInPlain(page, account);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await page.getByRole('button', { name: 'Add passkey' }).click();
    await expect(page.getByText('Passkey added.')).toBeVisible();
    await signOutFromSettings(page);

    // Opening the sign-in page is enough here: the virtual authenticator takes the
    // offer, as a person choosing their passkey from the list would.
    await expectInApp(page);
    await context.close();
  });

  test('say calmly that the request was cancelled when the browser finds no passkey to use', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // An authenticator that holds no passkey: the browser's prompt ends at once.
    await withVirtualAuthenticator(context, page);
    await page.goto('/auth/login');
    await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'cancelled or timed out' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login/);
    // The password form is still there to use.
    await expect(page.getByLabel('Email')).toBeVisible();
    await context.close();
  });

  test('are not offered where the browser has no WebAuthn, and Settings says why', async ({
    browser,
  }) => {
    const account = await createAccount(browser);
    const context = await browser.newContext();
    await context.addInitScript(() => {
      delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    });
    const page = await context.newPage();
    await page.goto('/auth/login');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use a passkey', exact: true })).toHaveCount(0);

    await signInPlain(page, account);
    await page.goto('/settings');
    await expect(page.getByText('This browser cannot make passkeys.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toHaveCount(0);
    await context.close();
  });
});
