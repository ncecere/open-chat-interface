import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  type Account,
  createAccount,
  enrolWithApi,
  expectInApp,
  freshCode,
  signInPlain,
  signInWithCode,
  spaced,
  submitPassword,
} from './mfa.helpers';

/**
 * Requiring two-step verification per role (#399): an administrator turns it on
 * for the `restricted` role (nobody else's spec reads that role but
 * settings-people.spec.ts, for one test), a limited person can reach only
 * enrolment and sign-out, and the app works again once they have enrolled.
 *
 * The requirement is a setting of the whole instance and the specs run in
 * parallel, so this is one serial describe that holds it for as short a time as
 * each test needs and removes it in `finally` and in `afterAll`. It runs in the
 * desktop project only (playwright.config.ts): two projects would set and clear
 * the same setting under each other.
 *
 * The administrator saving the requirement must have used a second step in the
 * session, so it is a fresh administrator, enrolled here; the seeded one is
 * never enrolled.
 */

const SAVE = 'Save changes to the two-step verification requirement';

test.describe.configure({ mode: 'serial' });

let admin: { account: Account; context: BrowserContext; page: Page };

async function clearRequirement() {
  const cleared = await admin.page.request.patch('/api/admin/settings', {
    data: { mfaRequirement: { roles: [], graceDays: 14 } },
  });
  expect(cleared.ok(), await cleared.text()).toBe(true);
}

async function requirement() {
  const response = await admin.page.request.get('/api/admin/settings');
  const settings = (await response.json()) as { mfaRequirement: { roles: string[] } };
  return settings.mfaRequirement;
}

/** The administrator's Authentication settings page, with Restricted chosen and a grace typed. */
async function chooseRestricted(page: Page, graceDays: string) {
  await page.goto('/admin/settings/authentication');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Two-step verification' }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'Restricted' }).check();
  await page.getByLabel('Grace period (days)').fill(graceDays);
}

test.beforeAll(async ({ browser }) => {
  // Making the account waits on the lock the specs share: more than a test's 30 seconds when
  // other workers are doing the same.
  test.setTimeout(120_000);
  const account = await createAccount(browser, 'admin', 'Requirement Admin');
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInPlain(page, account);
  await enrolWithApi(page, account);
  admin = { account, context, page };
});

test.afterAll(async () => {
  try {
    await clearRequirement();
  } finally {
    await admin.context.close();
  }
});

test('an administrator who has not used a second step is told to, and nothing is saved', async ({
  browser,
}) => {
  const account = await createAccount(browser, 'admin', 'Plain Admin');
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInPlain(page, account);

  await chooseRestricted(page, '14');
  await page.getByRole('button', { name: SAVE }).click();
  const refusal = page.getByRole('alert').filter({ hasText: 'used it yourself' });
  await expect(refusal).toBeVisible();
  await expect(
    refusal.getByRole('link', { name: 'Set it up under Settings → Account' }),
  ).toBeVisible();
  expect((await requirement()).roles).toEqual([]);
  await context.close();
});

test('shows who it would limit before saving, and reminds people before the deadline', async ({
  browser,
}) => {
  const person = await createAccount(browser, 'restricted', 'Reminded Person');
  try {
    await chooseRestricted(admin.page, '30');
    // The figures are there before anything is saved, for every role, and the form changes the sentence.
    const restricted = admin.page.getByRole('row', { name: /^Restricted/ });
    await expect(restricted).toBeVisible();
    await expect(admin.page.getByRole('row', { name: /^Admin/ })).toBeVisible();
    await expect(admin.page.getByText(/would be limited after 30 days/)).toBeVisible();
    await admin.page.getByLabel('Grace period (days)').fill('0');
    await expect(admin.page.getByText(/would be limited at their next request/)).toBeVisible();
    await expect(
      admin.page.getByRole('alert').filter({ hasText: 'limited at their next request' }),
    ).toBeVisible();
    await admin.page.getByLabel('Grace period (days)').fill('30');
    await admin.page.getByRole('button', { name: SAVE }).click();
    await expect(admin.page.getByText('Two-step verification requirement saved.')).toBeVisible();
    expect((await requirement()).roles).toEqual(['restricted']);

    // Before the deadline: the app works, and says by when to set it up.
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInPlain(page, person);
    const banner = page.getByRole('status').filter({ hasText: 'Set up two-step verification by' });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Set up now' })).toBeVisible();
    expect((await page.request.get('/api/threads')).status()).toBe(200);
    await page.goto('/settings');
    await expect(page.getByText(/Required by your administrator\. Set it up by /)).toBeVisible();
    await context.close();
  } finally {
    await clearRequirement();
  }
});

test('limits a person to enrolment and sign-out at once, and the app works once they have enrolled', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const person = await createAccount(browser, 'restricted', 'Limited Person');
  const context = await browser.newContext();
  const page = await context.newPage();
  // Signed in before the requirement exists: the session is not signed out when it starts.
  await signInPlain(page, person);
  expect((await page.request.get('/api/threads')).status()).toBe(200);

  try {
    await chooseRestricted(admin.page, '0');
    await admin.page.getByRole('button', { name: SAVE }).click();
    await expect(admin.page.getByText('Two-step verification requirement saved.')).toBeVisible();

    // The next request of the open session is refused, except enrolment and sign-out.
    const refused = await page.request.get('/api/threads');
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'MFA_ENROLMENT_REQUIRED',
    );
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { mfa: { limited: boolean } }).mfa.limited).toBe(true);
    expect((await page.request.get('/api/health/live')).status()).toBe(200);

    // The page the app opens is the setup page, and the rest of the app is out of reach.
    await page.goto('/');
    await expect(page).toHaveURL(/\/auth\/mfa-setup/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up two-step verification' }),
    ).toBeVisible();
    await expect(page.getByText('Your administrator requires two-step verification')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up an authenticator app' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toHaveCount(0);
    for (const path of ['/settings', '/admin', '/chat/anything']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/auth\/mfa-setup/);
    }

    // Sign out is there, and signing in again lands on the same page.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    await submitPassword(page, person);
    await expect(page).toHaveURL(/\/auth\/mfa-setup/);

    // Enrol: the same steps as in Settings.
    await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
    await page.getByLabel('Current password').fill(person.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    const secret = (await page.getByTestId('manual-key').innerText()).replace(/\s+/g, '');
    await page
      .getByLabel('Authentication code', { exact: true })
      .fill(spaced(await freshCode(secret)));
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByTestId('recovery-code')).toHaveCount(10);
    // Nothing leads on until the codes are saved.
    await expect(page).toHaveURL(/\/auth\/mfa-setup/);
    await page.getByLabel('I have saved my recovery codes').check();
    await page.getByRole('button', { name: 'Done' }).click();

    // The session is the authenticator's now: the app works.
    await expectInApp(page);
    expect((await page.request.get('/api/threads')).status()).toBe(200);
    const after = await page.request.get('/api/me');
    expect(((await after.json()) as { mfa: { limited: boolean } }).mfa.limited).toBe(false);

    // A new sign-in asks for the code, and then the app works.
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signInWithCode(page, person, secret);
    expect((await page.request.get('/api/threads')).status()).toBe(200);
  } finally {
    await clearRequirement();
    await context.close();
  }
});
