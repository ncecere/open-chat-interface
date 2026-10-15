import { expect, type Page, test } from '@playwright/test';
import {
  createAccount,
  enrolWithApi,
  expectInApp,
  freshCode,
  signInPlain,
  signOutFromSettings,
  spaced,
  submitPassword,
} from './mfa.helpers';
import { secretFromUri } from './totp';

/**
 * Two-step verification with an authenticator app (#399) in a real browser
 * against the real API: setting it up from the page's own manual key, signing
 * in with a pasted code and with a recovery code, the refusals, and turning it
 * off. Accounts are fresh ones an administrator creates for each test, never the
 * seeded administrator. Codes are computed here from the secret with RFC 6238
 * (tests/e2e/totp.ts), so the library under test is not its own oracle.
 */

/** What a paste does to a field: the text arrives as inserted text, not as typing. */
async function paste(page: Page, label: string, text: string) {
  const field = page.getByLabel(label, { exact: true });
  await field.focus();
  await page.keyboard.insertText(text);
  return field;
}

test.describe('with an authenticator app', () => {
  test('is set up from the manual key, used to sign in with a pasted code and a recovery code, and turned off', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const account = await createAccount(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInPlain(page, account);

    // Set up: password, then the key and the link, then a code.
    await page.goto('/settings');
    await expect(page.getByText(/Status:\s*Off/)).toBeVisible();
    await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
    await page.getByLabel('Current password').fill('not the password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Your password is not correct.')).toBeVisible();
    await page.getByLabel('Current password').fill(account.password);
    await page.getByRole('button', { name: 'Continue' }).click();

    const manualKey = page.getByTestId('manual-key');
    await expect(manualKey).toBeVisible();
    const secret = (await manualKey.innerText()).replace(/\s+/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    // The QR code is decoration; the key and the link are the way for a person without a camera.
    await expect(page.locator('svg[aria-hidden="true"][viewBox]').first()).toBeVisible();
    const link = page.getByRole('link', { name: 'Open in your authenticator app' });
    expect(secretFromUri((await link.getAttribute('href')) ?? '')).toBe(secret);

    // SC 3.3.8: one field, the right autofill token, a numeric keyboard, no length limit.
    const code = page.getByLabel('Authentication code', { exact: true });
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(await code.getAttribute('maxlength')).toBeNull();

    await paste(page, 'Authentication code', '000 000');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText(/That code is not right/)).toBeVisible();

    await code.fill('');
    const enrolling = await freshCode(secret);
    await paste(page, 'Authentication code', spaced(enrolling));
    await page.getByRole('button', { name: 'Turn on' }).click();

    // The recovery codes, once; Done waits for "I saved them".
    const listed = page.getByTestId('recovery-code');
    await expect(listed).toHaveCount(10);
    const recoveryCodes = await listed.allInnerTexts();
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(recoveryCodes[0]).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
    await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
    await page.getByLabel('I have saved my recovery codes').check();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(/Status:\s*On/)).toBeVisible();
    await expect(page.getByText('10 recovery codes left.')).toBeVisible();
    await expect(page.getByTestId('recovery-code')).toHaveCount(0);
    // Gone for good: a reload does not bring them back.
    await page.reload();
    await expect(page.getByText('10 recovery codes left.')).toBeVisible();
    await expect(page.getByTestId('recovery-code')).toHaveCount(0);

    // Sign out, sign in with the password: the second step, and a pasted code.
    await signOutFromSettings(page);
    await submitPassword(page, account);
    await expect(page).toHaveURL(/\/auth\/two-factor/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Two-step verification' }),
    ).toBeVisible();
    const field = page.getByLabel('Authentication code', { exact: true });
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(await field.getAttribute('maxlength')).toBeNull();

    // Nothing is sent by itself at six digits.
    await paste(page, 'Authentication code', '123 456');
    await expect(field).toHaveValue('123 456');
    await expect(page).toHaveURL(/\/auth\/two-factor/);
    await field.fill('');
    const signedInWith = await freshCode(secret);
    await paste(page, 'Authentication code', spaced(signedInWith));
    await expect(field).toHaveValue(spaced(signedInWith));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expectInApp(page);

    // The same code again is refused with the next code asked for.
    await signOutFromSettings(page);
    await submitPassword(page, account);
    await page.getByLabel('Authentication code', { exact: true }).fill(signedInWith);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Wait for the next code' }),
    ).toBeVisible();

    // A recovery code instead; it works once.
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    const recovery = page.getByLabel('Recovery code', { exact: true });
    await expect(recovery).toBeFocused();
    await expect(recovery).toHaveAttribute('autocomplete', 'off');
    await paste(page, 'Recovery code', ` ${recoveryCodes[0]} `);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expectInApp(page);

    await signOutFromSettings(page);
    await submitPassword(page, account);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code', { exact: true }).fill(recoveryCodes[0]!);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'recovery code was already used' }),
    ).toBeVisible();
    await page.getByLabel('Recovery code', { exact: true }).fill(recoveryCodes[1]!);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expectInApp(page);

    // Turn it off: the password and a current code.
    await page.goto('/settings');
    await expect(page.getByText('8 recovery codes left.')).toBeVisible();
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn off the authenticator app?' });
    await dialog.getByLabel('Current password').fill(account.password);
    await dialog.getByLabel('Authentication or recovery code').fill('000000');
    await dialog.getByRole('button', { name: 'Turn off authenticator' }).click();
    await expect(dialog.getByText(/That code is not right/)).toBeVisible();
    const turningOff = await freshCode(secret);
    await dialog.getByLabel('Authentication or recovery code').fill(spaced(turningOff));
    await dialog.getByRole('button', { name: 'Turn off authenticator' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('The authenticator app is turned off.')).toBeVisible();
    await expect(page.getByText(/Status:\s*Off/)).toBeVisible();

    // And the password alone signs in again.
    await signOutFromSettings(page);
    await signInPlain(page, account);
    await context.close();
  });

  test('says what went wrong at the second step, and starts again when the challenge is over', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const account = await createAccount(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInPlain(page, account);
    await enrolWithApi(page, account);
    await signOutFromSettings(page);

    // No challenge was started: the page says so rather than "wrong code".
    await page.goto('/auth/two-factor');
    await page.getByLabel('Authentication code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Start again' });
    await expect(alert).toBeVisible();
    await expect(page.getByLabel('Authentication code', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Start again' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);

    // A wrong code keeps the form, the field marked and focused.
    await submitPassword(page, account);
    const field = page.getByLabel('Authentication code', { exact: true });
    await field.fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'That code is not right' }),
    ).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toBeFocused();
    // Editing the code takes the message away.
    await field.fill('1');
    await expect(page.getByRole('alert')).toHaveCount(0);

    // An empty submit is said in words.
    await field.fill('');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toHaveText('Enter the code from your authenticator app.');

    // Back to sign-in is one link away.
    await page.getByRole('link', { name: 'Back to sign in' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    await context.close();
  });

  test('the sixth wrong code finds the attempt over: start again', async ({ browser }) => {
    // The server allows five wrong codes per challenge and refuses the next one.
    test.setTimeout(120_000);
    const account = await createAccount(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInPlain(page, account);
    await enrolWithApi(page, account);
    await signOutFromSettings(page);

    await submitPassword(page, account);
    const field = page.getByLabel('Authentication code', { exact: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await field.fill(`10000${attempt}`);
      await page.getByRole('button', { name: 'Verify' }).click();
      await expect(page.getByRole('alert')).toContainText('That code is not right');
      await expect(field).toBeFocused();
    }
    await field.fill('100005');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert')).toContainText('Too many wrong codes');
    await expect(field).toHaveCount(0);
    await page.getByRole('link', { name: 'Start again' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    await context.close();
  });

  test('the second step works by keyboard alone', async ({ browser }) => {
    test.setTimeout(180_000);
    const account = await createAccount(browser);
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInPlain(page, account);
    const { secret } = await enrolWithApi(page, account);
    await signOutFromSettings(page);

    // From the sign-in page to the app without the mouse.
    await page.goto('/auth/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Email')).toBeFocused();
    await page.keyboard.type(account.email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(account.password);
    await page.keyboard.press('Enter');

    // The code field has focus on arrival: the person typed their password a moment ago.
    await expect(page).toHaveURL(/\/auth\/two-factor/);
    const field = page.getByLabel('Authentication code', { exact: true });
    await expect(field).toBeFocused();

    // The order of the rest is the order on the page, ending in the way back.
    const order = [
      page.getByRole('button', { name: 'Verify' }),
      page.getByRole('button', { name: 'Use a recovery code instead' }),
      page.getByRole('button', { name: 'Use a passkey instead' }),
      page.getByRole('link', { name: 'Back to sign in' }),
    ];
    for (const stop of order) {
      await page.keyboard.press('Tab');
      await expect(stop).toBeFocused();
    }
    for (let back = 0; back < order.length; back += 1) await page.keyboard.press('Shift+Tab');
    await expect(field).toBeFocused();

    // The recovery code is reached and left with Space, and focus lands in the new field.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Use a recovery code instead' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByLabel('Recovery code', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Use an authenticator code instead' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(field).toBeFocused();

    // A code typed and sent with Enter.
    await page.keyboard.type(await freshCode(secret));
    await page.keyboard.press('Enter');
    await expectInApp(page);
    await context.close();
  });
});
