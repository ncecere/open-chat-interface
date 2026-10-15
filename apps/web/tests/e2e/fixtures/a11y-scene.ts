import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  createPeople,
  createProject,
  type Person,
  removePeople,
  signInAdmin,
  signInPerson,
  uniqueRun,
} from './sharing';

/**
 * What the specs for the audit's findings (a11y-fixes-*.spec.ts, #401) share: the checks of
 * scripts/a11y-audit run on a real page, and a scene of data with long names, so that text which
 * is shortened or overlaps under the 1.4.12 text spacing has something to do it to.
 */

const AUDIT = fileURLToPath(new URL('../../../../../scripts/a11y-audit/', import.meta.url));
const load = (file: string) => import(pathToFileURL(join(AUDIT, file)).href);

export interface Finding {
  rule: string;
  severity: string;
  targets: string[];
  message: string;
}

export type Theme = 'light' | 'dark';
export const ACCENTS = ['neutral', 'blue', 'violet', 'emerald'] as const;
export const DESKTOP = { width: 1280, height: 800 };
export const NARROW = { width: 320, height: 640 };

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface Scene {
  admin: { state: StorageState };
  person: Person;
  personId: string;
  personState: StorageState;
  thread: { id: string; title: string };
  project: { id: string; name: string };
  groupName: string;
}

/** Filled in by `provideScene`; each worker has its own. */
export const scene = {} as Scene;

/**
 * Before the tests of a file: an administrator's session, a person whose name and address are long
 * (as real ones are, and as a translated label can be), a conversation, a project and a group, all
 * with names that need more than one line in the sidebar. Removed after.
 */
export function provideScene() {
  let cleanup: Array<() => Promise<void>> = [];

  test.beforeAll(async ({ browser }) => {
    const run = uniqueRun();
    const { context, page } = await signInAdmin(browser);
    cleanup.push(() => context.close());
    const request = page.request;
    const people: Person[] = [];
    await createPeople(request, run, ['a-person-with-an-unusually-long-address-to-wrap'], people);
    const person = people[0] as Person;
    const { context: personContext } = await signInPerson(browser, person);
    const personState = await personContext.storageState();
    await personContext.close();

    const title = `Planning the quarterly review ${run}`;
    const made = await request.post('/api/threads', { data: { title } });
    expect(made.ok(), await made.text()).toBe(true);
    const thread = { id: ((await made.json()) as { thread: { id: string } }).thread.id, title };
    const projectName = `Quarterly review materials ${run}`;
    const project = { id: await createProject(request, projectName), name: projectName };
    const groupName = `Platform engineering group ${run}`;
    const group = await request.post('/api/admin/groups', {
      data: { name: groupName, description: 'Made for an accessibility test' },
    });
    expect(group.status(), await group.text()).toBe(201);
    const groupId = ((await group.json()) as { id: string }).id;
    const me = (await (await request.get('/api/me')).json()) as { user: { email: string } };
    const added = await request.post(`/api/admin/groups/${groupId}/members`, {
      data: { emails: [person.email, me.user.email], role: 'manager' },
    });
    expect(added.ok(), await added.text()).toBe(true);
    const found = await request.get(`/api/admin/users?search=${encodeURIComponent(person.email)}`);
    const personId = ((await found.json()) as { users: Array<{ id: string }> }).users[0]?.id ?? '';
    cleanup.push(async () => {
      await request.delete(`/api/admin/groups/${groupId}`);
      await request.delete(`/api/projects/${project.id}`);
      await request.delete(`/api/threads/${thread.id}`);
      await removePeople(request, people);
    });
    Object.assign(scene, {
      admin: { state: await context.storageState() },
      person,
      personId,
      personState,
      thread,
      project,
      groupName,
    });
  });

  test.afterAll(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => undefined);
    cleanup = [];
  });
}

/** A fresh browser context holding what a person's browser would: their session, theme and accent. */
export async function open(
  browser: Browser,
  state: StorageState | undefined,
  options: { theme?: Theme; accent?: string; size?: { width: number; height: number } } = {},
) {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
    storageState: state,
    viewport: options.size ?? DESKTOP,
    colorScheme: options.theme === 'dark' ? 'dark' : 'light',
  });
  await context.addInitScript(
    ({ theme, accent }) => {
      localStorage.setItem('oci.theme', theme);
      localStorage.setItem('oci.colorTheme', accent);
    },
    { theme: options.theme ?? 'light', accent: options.accent ?? 'neutral' },
  );
  const page = await context.newPage();
  return { page, context };
}

type Check = 'nonTextContrastCheck' | 'textSpacingCheck' | 'textResizeCheck' | 'targetSizeCheck';

/** Opens `url` as the audit does, runs one of its checks and returns what it found. */
export async function measure(page: Page, url: string, check: Check) {
  const { visit } = await load('run.mjs');
  const measured = await load('checks/measured.mjs');
  const { createEvidence } = await load('lib/evidence.mjs');
  const opened = await visit(page, url);
  expect(opened.path, `${url} opened`).toBe(url.split('?')[0]);
  const evidence = createEvidence();
  await measured[check](page, {
    evidence,
    route: url,
    context: { role: 'e2e', theme: 'light', accent: 'neutral', viewport: 1280, language: 'en' },
    AxeBuilder,
  });
  return (evidence.toJSON().findings as Finding[]).map((finding) => ({ ...finding, url }));
}

export const describe = (findings: Finding[]) =>
  findings
    .map((f) => `${f.rule} ${f.severity}: ${f.targets.join(' ; ')} (${f.message})`)
    .join('\n');
