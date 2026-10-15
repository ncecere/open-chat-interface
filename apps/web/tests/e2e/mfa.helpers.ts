import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';
import { whileVerificationLifted } from './fixtures/verification-lock';
import { secretFromUri, totp } from './totp';

/**
 * Shared by the two-step verification specs (#399). Every account is made fresh
 * through the administration API: the seeded administrator is never enrolled
 * (it would make every other spec's sign-in ask for a code).
 */

export interface Account {
  email: string;
  password: string;
}

export function adminCredentials(): Account {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  return { email, password };
}

/** The new-user introduction greets a fresh account; skipping it is a choice a person has. */
export async function skipIntroduction(page: Page) {
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

export async function expectInApp(page: Page) {
  await skipIntroduction(page);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

/** The password step. What follows (the app, or the second step) is the caller's to check. */
export async function submitPassword(page: Page, account: Account) {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A person with no second step: the password is the whole sign-in. */
export async function signInPlain(page: Page, account: Account) {
  await submitPassword(page, account);
  await expectInApp(page);
}

/**
 * TOTP has no memory of codes in the browser, but the server refuses a code it
 * accepted in the last two minutes (`CODE_ALREADY_USED`): the same step's code
 * cannot be used twice. The enrolment's confirming code is one such use. So
 * each secret remembers what was sent, and the next code is the current step's
 * or the next one's, never the previous one (which a step boundary between
 * here and the server would age out). When both are spent the test waits for
 * the next step, as a person would wait for the next code in their app.
 */
const sent = new Map<string, Set<string>>();

export async function freshCode(secret: string): Promise<string> {
  const used = sent.get(secret) ?? new Set<string>();
  sent.set(secret, used);
  for (let waited = 0; waited < 35; waited += 1) {
    for (const stepOffset of [0, 1]) {
      const code = totp(secret, { stepOffset });
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('No unused authenticator code became available');
}

/** Types a code the way a paste arrives: as inserted text, with a space in the middle. */
export function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * A fresh local account, made through the administration API.
 *
 * Made while the instance does not require verified addresses (the fixture
 * requires them yet cannot deliver mail), through the lock every spec shares
 * (fixtures/verification-lock.ts), so no other spec can restore the requirement
 * between the lift and the creation. The account is still checked afterwards,
 * and made again under a new address if it is not verified, as a guard against
 * the setting being changed from outside the browser tests: the precondition is
 * established, not the test's result retried.
 */
export async function createAccount(
  browser: Browser,
  role: 'user' | 'admin' | 'restricted' = 'user',
  name = 'Two-step Fixture',
): Promise<Account> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const admin = adminCredentials();
  await signInPlain(page, admin);
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const email = `mfa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
      const password = `Disposable-${Math.random().toString(36).slice(2, 10)}-Pw1!`;
      await whileVerificationLifted(page.request, async () => {
        const created = await page.request.post('/api/admin/users', {
          data: { email, name, password, role },
        });
        expect(created.status(), await created.text()).toBe(201);
      });
      const listed = await page.request.get(`/api/admin/users?search=${encodeURIComponent(email)}`);
      const { users } = (await listed.json()) as {
        users: { email: string; emailVerified: boolean }[];
      };
      if (users.find((user) => user.email === email)?.emailVerified) return { email, password };
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 400));
    }
    throw new Error(
      'A verified account could not be created: the verification setting kept changing',
    );
  } finally {
    await context.close();
  }
}

/**
 * Sets up an authenticator through the API (the UI has its own spec), as the
 * person signed in on `page`: the confirming call replaces the session with one
 * that passed a second step, and the browser keeps the cookies it is given.
 */
export async function enrolWithApi(page: Page, account: Account) {
  const begun = await page.request.post('/api/me/mfa/totp', {
    data: { password: account.password },
  });
  expect(begun.ok(), await begun.text()).toBe(true);
  const { totpURI } = (await begun.json()) as { totpURI: string };
  const secret = secretFromUri(totpURI);
  const confirmed = await page.request.post('/api/me/mfa/totp/confirm', {
    data: { code: await freshCode(secret) },
  });
  expect(confirmed.ok(), await confirmed.text()).toBe(true);
  const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
  return { secret, recoveryCodes };
}

/** The password, then the code on the second step page. */
export async function signInWithCode(page: Page, account: Account, secret: string) {
  await submitPassword(page, account);
  await expect(page).toHaveURL(/\/auth\/two-factor/);
  await page.getByLabel('Authentication code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expectInApp(page);
}

export async function signOutFromSettings(page: Page) {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/auth\/login/);
}

/** A browser context with a virtual authenticator that can hold a passkey and verify the user. */
export async function withVirtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}
