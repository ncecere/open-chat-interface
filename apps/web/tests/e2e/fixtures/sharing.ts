import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
} from '@playwright/test';
import { reachApp } from './introduction';
import { whileVerificationLifted } from './verification-lock';

/**
 * Helpers for the project-sharing specs (v0.14, #394): accounts an
 * administrator creates, a sign-in that clears the introduction, and calls
 * that set projects up through the API so a test spends its time on the screen
 * it is about.
 */

const PASSWORD_SUFFIX = '-Pw1!';

export interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
}

export const uniqueRun = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function signInAs(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await reachApp(page, page.getByRole('textbox', { name: 'Message input' }));
}

export async function signInAdmin(browser: Browser) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, email, password);
  return { context, page };
}

/** A signed-in person in a context of their own, so several people are on screen at once. */
export async function signInPerson(browser: Browser, person: Person) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, person.email, person.password);
  return { context, page };
}

/**
 * Accounts an administrator creates. Verification is lifted while they are
 * made (an account made while it is required stays unverified and cannot sign
 * in) and put back after. Each is added to `people` as it is made, so a failure
 * part-way still leaves them to remove.
 */
export async function createPeople(
  admin: APIRequestContext,
  run: string,
  labels: string[],
  people: Person[],
) {
  await whileVerificationLifted(admin, async () => {
    for (const label of labels) {
      const person = {
        name: `Sharing ${label} ${run}`,
        email: `sharing-${label}-${run}@example.test`,
        password: `Disposable-${run}${PASSWORD_SUFFIX}`,
      };
      const created = await admin.post('/api/admin/users', {
        data: { ...person, role: 'user' },
      });
      expect(created.status(), await created.text()).toBe(201);
      people.push({ ...person, id: ((await created.json()) as { id: string }).id });
    }
  });
}

export async function removePeople(admin: APIRequestContext, people: Person[]) {
  for (const person of people) await admin.delete(`/api/admin/users/${person.id}`);
}

export async function closeAll(contexts: BrowserContext[]) {
  for (const context of contexts) await context.close();
}

export async function createProject(
  request: APIRequestContext,
  name: string,
  instructions = 'Answer in plain English.',
) {
  const made = await request.post('/api/projects', { data: { name, instructions } });
  expect(made.status(), await made.text()).toBe(201);
  return ((await made.json()) as { project: { id: string } }).project.id;
}

export async function uploadProjectFile(
  request: APIRequestContext,
  projectId: string,
  filename: string,
  text: string,
) {
  const uploaded = await request.post(`/api/projects/${projectId}/files`, {
    multipart: { files: { name: filename, mimeType: 'text/plain', buffer: Buffer.from(text) } },
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
}

export async function shareProject(
  request: APIRequestContext,
  projectId: string,
  subject: { type: 'person'; email: string } | { type: 'group'; groupId: string },
  permission: 'viewer' | 'editor',
) {
  const shared = await request.post(`/api/projects/${projectId}/shares`, {
    data: { subject, permission },
  });
  expect(shared.status(), await shared.text()).toBe(201);
  return ((await shared.json()) as { share: { id: string } }).share.id;
}

/** On a phone the sidebar is a drawer: open it. A no-op where it is always on screen. */
export async function openSidebar(page: Page) {
  const open = page.getByRole('button', { name: 'Open sidebar' });
  if (await open.isVisible()) await open.click();
}

export interface SharingScene {
  /** A project the signed-in administrator owns, shared with `editor` (so Transfer has someone to offer). */
  owned: { id: string; name: string };
  /** A project `owner` owns and shared with the administrator as a viewer. */
  shared: { id: string; name: string };
  owner: Person;
  editor: Person;
}

/**
 * Two people and two projects for a scan or a walk that needs the signed-in
 * administrator on both sides of a share. Everything is removed afterwards
 * (a person's projects go with them). Needs an administrator's `page`.
 */
export async function withSharingScene(
  browser: Browser,
  page: Page,
  body: (scene: SharingScene) => Promise<void>,
) {
  const admin = page.request;
  const run = uniqueRun();
  const people: Person[] = [];
  const contexts: BrowserContext[] = [];
  let ownedId: string | undefined;
  try {
    await createPeople(admin, run, ['scene-owner', 'scene-editor'], people);
    const [owner, editor] = people as [Person, Person];
    const owned = { id: '', name: `A11y owned ${run}` };
    owned.id = ownedId = await createProject(admin, owned.name, 'Owned by the scanned account.');
    await uploadProjectFile(admin, owned.id, 'owned.txt', 'Owned file.');
    await shareProject(admin, owned.id, { type: 'person', email: editor.email }, 'editor');

    const { context, page: ownerPage } = await signInPerson(browser, owner);
    contexts.push(context);
    const sharedName = `A11y shared ${run}`;
    const sharedId = await createProject(
      ownerPage.request,
      sharedName,
      'Shared with the scanned account.',
    );
    await uploadProjectFile(ownerPage.request, sharedId, 'shared.txt', 'Shared file.');
    const me = await admin.get('/api/me');
    const { user } = (await me.json()) as { user: { email: string } };
    await shareProject(
      ownerPage.request,
      sharedId,
      { type: 'person', email: user.email },
      'viewer',
    );

    await body({ owned, shared: { id: sharedId, name: sharedName }, owner, editor });
  } finally {
    if (ownedId) await admin.delete(`/api/projects/${ownedId}`);
    await removePeople(admin, people);
    await closeAll(contexts);
  }
}
