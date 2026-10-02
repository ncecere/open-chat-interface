import { expect, type Page, test } from '@playwright/test';

/**
 * Projects: create one from the sidebar, start a new chat inside it, and find
 * that conversation under the project.
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

async function installApi(page: Page) {
  await page.addInitScript(
    ({ model }) => {
      const now = () => new Date().toISOString();
      const projects: Array<Record<string, unknown>> = [];
      const threads: Array<Record<string, unknown>> = [];
      const messages: Record<string, unknown[]> = {};
      const recorded = { threadCreates: [] as unknown[] };
      Object.assign(window, { __projectsE2E: recorded });

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
          return json({
            threads: threads.filter((thread) => !projectId || thread.projectId === projectId),
          });
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
          return json({ thread }, 201);
        }

        const history = path.match(/^\/api\/chat\/([^/]+)\/messages$/);
        if (history && method === 'GET' && history[1] && history[1] in messages) {
          return json({
            thread: { id: history[1], temporary: false, expiresAt: null },
            messages: messages[history[1]],
          });
        }
        if (path === '/api/chat' && method === 'POST') {
          const request = body();
          const prompt = request.messages?.[0];
          const text = prompt?.parts?.[0]?.text ?? '';
          const thread = threads.find((candidate) => candidate.id === request.threadId);
          if (thread) thread.title = text;
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
    { model: MODEL },
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
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Use British spelling.',
  );
  await expect(page.getByText('No conversations yet.')).toBeVisible();

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

  // The conversation is listed under the project, reached from the sidebar.
  await openSidebar(page);
  await page
    .getByRole('list', { name: 'Projects' })
    .getByRole('link', { name: 'Dissertation' })
    .click();
  await expect(page).toHaveURL(/\/projects\/project-e2e-1$/);
  const conversations = page.getByRole('list', { name: 'Project conversations' });
  await expect(conversations.getByRole('link', { name: /Outline chapter one/ })).toHaveAttribute(
    'href',
    '/chat/thread-e2e-1',
  );
});
