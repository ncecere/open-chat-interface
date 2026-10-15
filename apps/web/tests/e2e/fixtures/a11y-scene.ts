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
  url?: string;
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
    // Three sign-ins (each hashes a password) and the accounts, made behind the lock the specs
    // share, while the other workers do their own set-up: more than a test's 30 seconds.
    test.setTimeout(120_000);
    const run = uniqueRun();
    const { context, page } = await signInAdmin(browser);
    cleanup.push(() => context.close());
    const request = page.request;
    const people: Person[] = [];
    // Two fresh accounts, so what the sidebar lists is what this scene made and nothing another
    // spec left on the seeded administrator's account: one whose name and address are long, as real
    // ones are (and as a translated label can be), and one made an administrator.
    await createPeople(
      request,
      run,
      ['a-person-with-an-unusually-long-address-to-wrap', 'scene-admin'],
      people,
    );
    const [person, admin] = people as [Person, Person];
    const promoted = await request.patch(`/api/admin/users/${admin.id}`, {
      data: { role: 'admin' },
    });
    expect(promoted.ok(), await promoted.text()).toBe(true);
    cleanup.push(() => removePeople(request, people));

    const { context: personContext } = await signInPerson(browser, person);
    const personState = await personContext.storageState();
    await personContext.close();
    const { context: adminContext, page: adminPage } = await signInPerson(browser, admin);
    const adminState = await adminContext.storageState();
    cleanup.push(() => adminContext.close());
    const own = adminPage.request;

    const made = await own.post('/api/threads', { data: { title: 'Quarterly planning' } });
    expect(made.ok(), await made.text()).toBe(true);
    // Names that fit two lines of the sidebar under the text spacing: a longer one is cut there by
    // design, with the full text in the heading of its page (see the reachability test).
    const thread = {
      id: ((await made.json()) as { thread: { id: string } }).thread.id,
      title: 'Quarterly planning',
    };
    const project = { id: await createProject(own, 'Review materials'), name: 'Review materials' };
    const groupName = `Platform group ${run}`;
    const group = await request.post('/api/admin/groups', {
      data: { name: groupName, description: 'Made for an accessibility test' },
    });
    expect(group.status(), await group.text()).toBe(201);
    const groupId = ((await group.json()) as { id: string }).id;
    cleanup.push(async () => {
      await request.delete(`/api/admin/groups/${groupId}`);
    });
    const added = await request.post(`/api/admin/groups/${groupId}/members`, {
      data: { emails: [person.email, admin.email], role: 'manager' },
    });
    expect(added.ok(), await added.text()).toBe(true);

    Object.assign(scene, {
      admin: { state: adminState },
      person,
      personId: person.id,
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

/**
 * The model picker under the message box (components/chat, a file this change does not touch) cuts
 * its label with an ellipsis; it is a finding of the audit that is listed, not fixed, with the chat.
 */
export const outsideChat = (finding: Finding) =>
  !(
    /^\/(chat\/.*)?$/.test(finding.url ?? '') &&
    finding.targets.length === 1 &&
    finding.targets[0] === 'span.min-w-0.truncate'
  );

export const describe = (findings: Finding[]) =>
  findings
    .map((f) => `${f.url ?? ''} ${f.rule} ${f.severity}: ${f.targets.join(' ; ')} (${f.message})`)
    .join('\n');
