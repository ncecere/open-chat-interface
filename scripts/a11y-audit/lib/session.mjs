/**
 * Accounts and sessions for the audit.
 *
 * The same environment as the e2e suite: E2E_BASE_URL, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD.
 * The seeded administrator is used only to make fresh accounts through the administration API
 * and to change instance settings the audit restores afterwards. It is never audited as, and
 * never enrolled in two-step verification (that would make every other suite's sign-in ask
 * for a code).
 */

import { randomBytes } from 'node:crypto';
import { secretFromUri, totp } from './totp.mjs';

export const ROLES = ['admin', 'user', 'restricted'];

const unique = () => randomBytes(4).toString('hex');

export function adminCredentials(env = process.env) {
  const email = env.E2E_ADMIN_EMAIL;
  const password = env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  return { email, password };
}

async function expectOk(response, what) {
  if (!response.ok()) {
    throw new Error(
      `${what} failed: ${response.status()} ${(await response.text()).slice(0, 200)}`,
    );
  }
  return response;
}

/** An API client signed in as `account`, with the origin header Better Auth checks. */
export async function apiAs(playwright, baseUrl, account) {
  const api = await playwright.request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin: new URL(baseUrl).origin },
  });
  await expectOk(
    await api.post('/api/auth/sign-in/email', {
      data: { email: account.email, password: account.password },
    }),
    'Sign-in',
  );
  return api;
}

/**
 * A verified local account of `role`. An account an administrator creates is verified only if
 * the instance does not require verified addresses at that moment, and the seeded instance
 * does and cannot send mail: so the requirement is lifted for the creation and put back.
 */
export async function createAccount(admin, role, label = 'Audit') {
  const settings = await (
    await expectOk(await admin.get('/api/admin/settings'), 'Reading settings')
  ).json();
  const email = `a11y-${role}-${Date.now()}-${unique()}@example.test`;
  const password = `Disposable-${unique()}-Pw1!`;
  try {
    if (settings.emailVerificationRequired) {
      await expectOk(
        await admin.patch('/api/admin/settings', { data: { emailVerificationRequired: false } }),
        'Lifting the verification requirement',
      );
    }
    await expectOk(
      await admin.post('/api/admin/users', {
        data: { email, name: `${label} ${role}`, password, role },
      }),
      `Creating the ${role} account`,
    );
  } finally {
    if (settings.emailVerificationRequired) {
      await admin.patch('/api/admin/settings', { data: { emailVerificationRequired: true } });
    }
  }
  return { email, password, role };
}

/** Signs the account in through the API, skips the new-user introduction, returns storage state. */
export async function storageStateFor(browser, baseUrl, account) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin: new URL(baseUrl).origin },
  });
  try {
    await expectOk(
      await context.request.post('/api/auth/sign-in/email', {
        data: { email: account.email, password: account.password },
      }),
      'Sign-in',
    );
    // A fresh account is greeted by the introduction wizard, which would cover every page.
    await context.request.post('/api/me/onboarding/skip');
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/** Sets up an authenticator for the account through the API; returns what a sign-in needs. */
export async function enrolTotp(api, account) {
  const begun = await expectOk(
    await api.post('/api/me/mfa/totp', { data: { password: account.password } }),
    'Starting two-step verification',
  );
  const { totpURI } = await begun.json();
  const secret = secretFromUri(totpURI);
  const confirmed = await expectOk(
    await api.post('/api/me/mfa/totp/confirm', { data: { code: totp(secret) } }),
    'Confirming two-step verification',
  );
  const { recoveryCodes } = await confirmed.json();
  return { secret, recoveryCodes };
}

/**
 * A fresh code for `secret`. The server refuses a code it accepted in the last two minutes, so
 * the step after the one used to enrol is taken when this one is spent.
 */
export function nextCode(secret, used) {
  for (const stepOffset of [0, 1, 2]) {
    const code = totp(secret, { stepOffset });
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
  }
  throw new Error('No unused authenticator code is available');
}

/** Creates a conversation for the account through the API (a stored one, with a title). */
export async function createThread(api, title) {
  const response = await expectOk(
    await api.post('/api/threads', { data: { title } }),
    'Creating a thread',
  );
  return (await response.json()).thread.id;
}

export async function createProject(api, name) {
  const response = await expectOk(
    await api.post('/api/projects', { data: { name, instructions: 'Answer clearly.' } }),
    'Creating a project',
  );
  return (await response.json()).project.id;
}
