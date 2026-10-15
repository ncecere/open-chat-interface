import { expect, test } from '@playwright/test';
import {
  DESKTOP,
  describe,
  type Finding,
  measure,
  NARROW,
  open,
  outsideChat,
  provideScene,
  scene,
} from './fixtures/a11y-scene';
import { createProject } from './fixtures/sharing';

/**
 * Regression tests for the text defects `pnpm a11y:audit` found (#401,
 * docs/accessibility/findings.md): D2 and D3, text cut off or overlapping under the 1.4.12 text
 * spacing, and D4, text at 200% (1.4.4). Each runs the audit's own check on the real page. They
 * need a seeded instance and the web app built; the viewports are set here, so the mobile project
 * leaves this file out (playwright.config.ts).
 */

provideScene();

test.describe('D2 and D3: nothing is lost or overlaps under the 1.4.12 text spacing', () => {
  const adminRoutes = () => [
    '/',
    `/chat/${scene.thread.id}`,
    '/projects',
    `/projects/${scene.project.id}`,
    '/admin/audit',
    '/admin/groups',
    '/admin/users',
    `/admin/users/${scene.personId}`,
    '/admin/backups',
    '/admin/models',
    '/admin/health',
  ];
  const personRoutes = [
    '/settings',
    '/settings/customization',
    '/settings/groups',
    '/settings/history',
    '/settings/memory',
    '/settings/models',
    '/settings/sharing',
    '/settings/attachments',
    '/settings/connectors',
  ];

  for (const [label, size] of [
    ['1280 px', DESKTOP],
    ['320 px', NARROW],
  ] as const) {
    test(`pages of the administrator at ${label}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { page, context } = await open(browser, scene.admin.state, { size });
      try {
        const found: Finding[] = [];
        for (const url of adminRoutes())
          found.push(...(await measure(page, url, 'textSpacingCheck')));
        const failing = found.filter(outsideChat);
        expect(failing.length, describe(failing)).toBe(0);
      } finally {
        await context.close();
      }
    });

    test(`Settings of a person with a long name and address at ${label}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { page, context } = await open(browser, scene.personState, { size });
      try {
        const found: Finding[] = [];
        for (const url of personRoutes)
          found.push(...(await measure(page, url, 'textSpacingCheck')));
        expect(found.length, describe(found)).toBe(0);
      } finally {
        await context.close();
      }
    });
  }

  test('the name and the address in the Settings header are shown in full, and stay in their column', async ({
    browser,
  }) => {
    const { page, context } = await open(browser, scene.personState);
    try {
      await page.goto('/settings');
      const email = page.getByText(scene.person.email, { exact: true }).first();
      await expect(email).toBeVisible();
      const box = await email.evaluate((node) => ({
        clipped: node.scrollWidth > node.clientWidth + 1,
        right: node.getBoundingClientRect().right,
        column: node.closest('section')?.getBoundingClientRect().right ?? 0,
      }));
      expect(box.clipped).toBe(false);
      // Not wider than its column, so it cannot run under the page beside it.
      expect(box.right).toBeLessThanOrEqual(box.column + 1);
    } finally {
      await context.close();
    }
  });
});

test.describe('D2: a name cut short in a list is whole where it is the heading', () => {
  test('a conversation, a project and a group with names longer than two lines', async ({
    browser,
  }) => {
    const { page, context } = await open(browser, scene.admin.state);
    const request = page.request;
    const run = Math.random().toString(36).slice(2, 8);
    const text = `Annual capacity planning and disaster recovery rehearsal for the platform ${run}`;
    const made = await request.post('/api/threads', { data: { title: text } });
    expect(made.ok(), await made.text()).toBe(true);
    const threadId = ((await made.json()) as { thread: { id: string } }).thread.id;
    const projectId = await createProject(request, text);
    const group = await request.post('/api/admin/groups', { data: { name: text } });
    expect(group.status(), await group.text()).toBe(201);
    const groupId = ((await group.json()) as { id: string }).id;
    try {
      // A conversation's title is its page's heading for a screen reader and the title of the
      // tab (components/chat, not changed here); the project and the group show theirs in full.
      await page.goto(`/chat/${threadId}`);
      await expect(page.getByRole('heading', { level: 1, name: text })).toHaveCount(1);
      await expect(page).toHaveTitle(new RegExp(run));
      for (const url of [`/projects/${projectId}`, `/admin/groups/${groupId}`]) {
        await page.goto(url);
        const heading = page.getByRole('heading', { level: 1 }).filter({ hasText: text });
        await expect(heading, `${url} names it in full`).toBeVisible();
        const clipped = await heading.evaluate(
          (node) =>
            node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
        );
        expect(clipped, `${url}: the heading is not cut`).toBe(false);
      }
      // In the sidebar and the lists it takes two lines and ends there; the title attribute holds all of it.
      await page.goto('/');
      const row = page.locator(`a[href="/chat/${threadId}"]`);
      await expect(row).toHaveAttribute('title', text);
    } finally {
      await request.delete(`/api/admin/groups/${groupId}`);
      await request.delete(`/api/projects/${projectId}`);
      await request.delete(`/api/threads/${threadId}`);
      await context.close();
    }
  });
});

test.describe('D4: text at 200% (1.4.4)', () => {
  test('the administrator’s pages', async ({ browser }) => {
    test.setTimeout(180_000);
    const { page, context } = await open(browser, scene.admin.state);
    try {
      const found: Finding[] = [];
      for (const url of [
        '/',
        `/chat/${scene.thread.id}`,
        '/admin',
        '/admin/audit',
        '/admin/usage',
        '/admin/branding',
        '/admin/models',
        `/admin/users/${scene.personId}`,
      ]) {
        found.push(...(await measure(page, url, 'textResizeCheck')));
      }
      const failing = found.filter(outsideChat);
      expect(failing.length, describe(failing)).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('Settings', async ({ browser }) => {
    test.setTimeout(120_000);
    const { page, context } = await open(browser, scene.personState);
    try {
      const found: Finding[] = [];
      for (const url of ['/settings', '/settings/customization']) {
        found.push(...(await measure(page, url, 'textResizeCheck')));
      }
      expect(found.length, describe(found)).toBe(0);
    } finally {
      await context.close();
    }
  });
});
