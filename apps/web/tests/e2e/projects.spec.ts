import { expect, type Page, test } from '@playwright/test';

/**
 * Projects: create one from the sidebar, start a new chat inside it, and find
 * that conversation under the project, in the sidebar's project tree (v0.9.1)
 * and on the project page.
 *
 * Self-contained so it runs on any seeded instance (CI has no model provider):
 * sign-in is real, while the model catalog, project, thread and chat APIs are
 * served by an in-page stand-in that keeps their state for the test. The
 * server side is covered by apps/api/src/__tests__/live/projects.live.test.ts.
 */

const MODEL = {
  id: 'model-projects',
  slug: 'projects-model',
  displayName: 'Projects model',
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test',
  upstreamModelId: 'projects-model',
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

interface Recorded {
  threadCreates: unknown[];
}

/** Starting state for the stand-in; times are minutes before the page loads. */
interface Seed {
  projects: Array<{ id: string; name: string }>;
  threads: Array<{
    id: string;
    title: string;
    projectId: string | null;
    minutesAgo: number;
    pinned?: boolean;
  }>;
}

async function installApi(page: Page, seed: Seed = { projects: [], threads: [] }) {
  await page.addInitScript(
    ({ model, seed }) => {
      const now = () => new Date().toISOString();
      // Kept across reloads in the same tab, as the server would keep it.
      const saved = sessionStorage.getItem('projects-e2e-state');
      const initial = saved
        ? JSON.parse(saved)
        : {
            projects: seed.projects.map((project) => ({
              ...project,
              instructions: '',
              createdAt: now(),
              updatedAt: now(),
            })),
            threads: seed.threads.map(({ minutesAgo, ...thread }) => {
              const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
              return {
                pinned: false,
                archived: false,
                temporary: false,
                expiresAt: null,
                parentThreadId: null,
                branchedFromMessageId: null,
                lastMessageAt: at,
                createdAt: at,
                updatedAt: at,
                ...thread,
              };
            }),
          };
      const projects: Array<Record<string, unknown>> = initial.projects;
      const threads: Array<Record<string, unknown>> = initial.threads;
      const save = () =>
        sessionStorage.setItem('projects-e2e-state', JSON.stringify({ projects, threads }));
      const messages: Record<string, unknown[]> = Object.fromEntries(
        threads.map((thread) => [thread.id, []]),
      );
      const recorded = { threadCreates: [] as unknown[] };
      Object.assign(window, { __projectsE2E: recorded });
      const newestFirst = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt));

      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const summary = (project: Record<string, unknown>) => ({
        ...project,
        fileCount: 0,
        threadCount: threads.filter((thread) => thread.projectId === project.id).length,
      });
      // GET /api/projects/sidebar: newest five unpinned, every one counted.
      const sidebarEntry = (project: Record<string, unknown>) => ({
        id: project.id,
        name: project.name,
        threadCount: threads.filter((thread) => thread.projectId === project.id).length,
        recentThreads: threads
          .filter((thread) => thread.projectId === project.id && !thread.pinned)
          .sort(newestFirst)
          .slice(0, 5),
      });
      const original = window.fetch.bind(window);

      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = url.pathname;
        const body = () => JSON.parse(String(init?.body ?? '{}'));

        if (path === '/api/models') return json({ models: [model] });
        if (path === '/api/me' && method === 'GET') {
          // Real session; the role's projects switch is pinned on for the test.
          const response = await original(input, init);
          if (!response.ok) return response;
          const me = await response.json();
          return json({ ...me, features: { ...me.features, projects: true } });
        }

        if (path === '/api/projects' && method === 'GET') {
          return json({ projects: projects.map(summary) });
        }
        if (path === '/api/projects/sidebar' && method === 'GET') {
          return json({ projects: projects.map(sidebarEntry) });
        }
        if (path === '/api/projects' && method === 'POST') {
          const input = body();
          const project = {
            id: `project-e2e-${projects.length + 1}`,
            name: String(input.name).trim(),
            instructions: input.instructions ?? '',
            createdAt: now(),
            updatedAt: now(),
          };
          projects.push(project);
          save();
          return json({ project: summary(project) }, 201);
        }
        const projectPath = path.match(/^\/api\/projects\/([^/]+)(\/files)?$/);
        if (projectPath && method === 'GET') {
          const project = projects.find((candidate) => candidate.id === projectPath[1]);
          if (!project) {
            return json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
          }
          return projectPath[2] ? json({ files: [] }) : json({ project: summary(project) });
        }

        if (path === '/api/threads' && method === 'GET') {
          const projectId = url.searchParams.get('projectId');
          const sidebar = url.searchParams.get('view') === 'sidebar';
          return json({
            threads: threads
              .filter((thread) => !projectId || thread.projectId === projectId)
              .filter((thread) => !sidebar || !thread.projectId || thread.pinned)
              .sort(
                (a, b) =>
                  Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || newestFirst(a, b),
              ),
          });
        }
        const threadPath = path.match(/^\/api\/threads\/([^/]+)$/);
        if (threadPath && method === 'PATCH') {
          const thread = threads.find((candidate) => candidate.id === threadPath[1]);
          if (!thread) return json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
          Object.assign(thread, body(), { updatedAt: now() });
          save();
          return json({ thread });
        }
        if (path === '/api/threads' && method === 'POST') {
          const input = body();
          recorded.threadCreates.push(input);
          const thread = {
            id: `thread-e2e-${threads.length + 1}`,
            title: 'New Chat',
            pinned: false,
            archived: false,
            temporary: Boolean(input.temporary),
            expiresAt: null,
            parentThreadId: null,
            branchedFromMessageId: null,
            projectId: input.projectId ?? null,
            lastMessageAt: null,
            createdAt: now(),
            updatedAt: now(),
          };
          threads.unshift(thread);
          messages[thread.id] = [];
          save();
          return json({ thread }, 201);
        }

        const history = path.match(/^\/api\/chat\/([^/]+)\/messages$/);
        if (history && method === 'GET' && history[1] && history[1] in messages) {
          return json({
            thread: threads.find((candidate) => candidate.id === history[1]),
            messages: messages[history[1]],
          });
        }
        if (path === '/api/chat' && method === 'POST') {
          const request = body();
          const prompt = request.messages?.[0];
          const text = prompt?.parts?.[0]?.text ?? '';
          const thread = threads.find((candidate) => candidate.id === request.threadId);
          if (thread)
            Object.assign(thread, { title: text, updatedAt: now(), lastMessageAt: now() });
          save();
          const assistantId = `assistant-${request.threadId}`;
          messages[request.threadId]?.push(
            { ...prompt, metadata: { status: 'complete', createdAt: now() } },
            {
              id: assistantId,
              role: 'assistant',
              parts: [{ type: 'text', text: 'Here is an outline.' }],
              metadata: { status: 'complete', createdAt: now() },
            },
          );
          const encoder = new TextEncoder();
          const event = (data: unknown) =>
            encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(event({ type: 'start', messageId: assistantId }));
              controller.enqueue(event({ type: 'text-start', id: 'text' }));
              controller.enqueue(
                event({ type: 'text-delta', id: 'text', delta: 'Here is an outline.' }),
              );
              controller.enqueue(event({ type: 'text-end', id: 'text' }));
              controller.enqueue(event({ type: 'finish' }));
              controller.enqueue(event('[DONE]'));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'x-vercel-ai-ui-message-stream': 'v1',
            },
          });
        }
        return original(input, init);
      };
    },
    { model: MODEL, seed },
  );
}

async function signIn(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

async function openSidebar(page: Page) {
  const open = page.getByRole('button', { name: 'Open sidebar' });
  if (await open.isVisible()) await open.click();
}

test('a new chat started from a project page belongs to that project', async ({ page }) => {
  await installApi(page);
  await signIn(page);
  await openSidebar(page);

  // Create a project from the sidebar.
  await page.getByRole('button', { name: 'New project' }).click();
  const create = page.getByRole('dialog', { name: 'New project' });
  await expect(create).toBeVisible();
  await expect(create.getByLabel('Project name')).toBeFocused();
  await create.getByLabel('Project name').fill('Dissertation');
  await create.getByLabel('Instructions (optional)').fill('Use British spelling.');
  await create.getByRole('button', { name: 'Create project' }).click();

  await expect(page).toHaveURL(/\/projects\/project-e2e-1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Dissertation' })).toBeVisible();
  // The page opens on Conversations; the instructions have their own tab.
  await expect(page.getByText('No conversations yet.')).toBeVisible();
  await page.getByRole('tab', { name: 'Instructions' }).click();
  await expect(page).toHaveURL(/\/projects\/project-e2e-1\?tab=instructions$/);
  await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(
    'Use British spelling.',
  );

  // Start a chat inside it.
  await page.getByRole('link', { name: 'New chat in project' }).click();
  await expect(page).toHaveURL(/\/\?project=project-e2e-1$/);
  await expect(page.getByText('New chat in').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dissertation' }).first()).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill('Outline chapter one');
  await input.press('Enter');

  await expect(page).toHaveURL(/\/chat\/thread-e2e-1$/);
  await expect(page.getByText('Here is an outline.')).toBeVisible();
  const recorded = await page.evaluate(
    () => (window as unknown as { __projectsE2E: Recorded }).__projectsE2E.threadCreates,
  );
  expect(recorded).toEqual([{ temporary: false, projectId: 'project-e2e-1' }]);

  // The open conversation's project opens by itself in the sidebar, with the
  // conversation under it and highlighted; it is not in the general list.
  await openSidebar(page);
  const toggle = page.getByRole('button', { name: 'Conversations in Dissertation' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const tree = page.getByRole('list', { name: 'Conversations in Dissertation' });
  await expect(tree.getByRole('link', { name: 'Outline chapter one' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: 'Outline chapter one' })).toHaveCount(1);

  // The project page lists it too, reached from the sidebar.
  await page
    .getByRole('list', { name: 'Projects' })
    .getByRole('link', { name: 'Dissertation', exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/project-e2e-1$/);
  const conversations = page.getByRole('list', { name: 'Project conversations' });
  await expect(conversations.getByRole('link', { name: /Outline chapter one/ })).toHaveAttribute(
    'href',
    '/chat/thread-e2e-1',
  );
});

const RESEARCH: Seed = {
  projects: [{ id: 'project-research', name: 'Research' }],
  threads: [
    { id: 'unfiled-1', title: 'Grocery list', projectId: null, minutesAgo: 1 },
    ...[1, 2, 3, 4, 5, 6].map((index) => ({
      id: `research-${index}`,
      title: `Research note ${index}`,
      projectId: 'project-research',
      minutesAgo: index * 10,
    })),
    {
      id: 'research-pinned',
      title: 'Research pinned',
      projectId: 'project-research',
      minutesAgo: 500,
      pinned: true,
    },
  ],
};

test('project conversations live under their project in the sidebar', async ({
  page,
  isMobile,
}) => {
  await installApi(page, RESEARCH);
  await signIn(page);
  await openSidebar(page);
  const drawer = page.getByRole('dialog', { name: 'Conversation sidebar' });
  if (isMobile) await expect(drawer).toBeVisible();

  // A plain heading; each project is its own disclosure, collapsed at first.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Conversations in Research' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Research note 1' })).toHaveCount(0);

  // The general list has only unfiled conversations; pinned ones stay in
  // Pinned with their project named.
  await expect(page.getByRole('link', { name: 'Grocery list' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /^Research pinned\s*, in project Research$/ }),
  ).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const tree = page.getByRole('list', { name: 'Conversations in Research' });
  await expect(tree.getByRole('link')).toHaveText([
    'Research note 1',
    'Research note 2',
    'Research note 3',
    'Research note 4',
    'Research note 5',
  ]);
  await expect(page.getByRole('link', { name: 'Research pinned' })).toHaveCount(1);

  // Remembered in this browser.
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  await openSidebar(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Unpinning moves a conversation from Pinned to the top of its project.
  const pinnedRow = page.getByRole('link', { name: /^Research pinned\s*, in project Research$/ });
  await pinnedRow.locator('xpath=..').getByRole('button', { name: 'Unpin thread' }).focus();
  await page.keyboard.press('Enter');
  await expect(tree.getByRole('link').first()).toHaveText('Research pinned');
  await expect(tree.getByRole('link')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Pinned' })).toHaveCount(0);

  // Show all opens the project's conversations; a phone's drawer closes.
  const showAll = page.getByRole('link', { name: 'Show all (7) conversations in Research' });
  await expect(showAll).toBeVisible();
  await showAll.click();
  await expect(page).toHaveURL(/\/projects\/project-research(\?tab=conversations)?$/);
  await expect(
    page.getByRole('list', { name: 'Project conversations' }).getByRole('link'),
  ).toHaveCount(7);
  if (isMobile) await expect(drawer).toBeHidden();

  // An older conversation opened from there is shown under its project.
  await page
    .getByRole('list', { name: 'Project conversations' })
    .getByRole('link', { name: /Research note 6/ })
    .click();
  await expect(page).toHaveURL(/\/chat\/research-6$/);
  await openSidebar(page);
  await expect(tree.getByRole('link')).toHaveCount(6);
  await expect(tree.getByRole('link', { name: 'Research note 6' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Tapping a conversation in the tree opens it; a phone's drawer closes.
  await tree.getByRole('link', { name: 'Research note 2' }).click();
  await expect(page).toHaveURL(/\/chat\/research-2$/);
  if (isMobile) await expect(drawer).toBeHidden();
});
