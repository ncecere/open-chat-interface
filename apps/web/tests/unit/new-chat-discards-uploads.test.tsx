// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentChips } from '../../src/components/chat/attachment-chips';
import { useAttachments } from '../../src/hooks/use-attachments';

/**
 * Files uploaded and then abandoned with New Chat (#297), through the app's
 * real router and the real attachment hook and chips. The composer emptied,
 * but the files stayed stored, counted against the person's storage and
 * listed as if sent; only files removed with their × were discarded. Only
 * the shell and the rest of the page are stand-ins.
 */
vi.mock('../../src/components/layout/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-shell>{children}</div>,
}));
vi.mock('../../src/components/onboarding/onboarding-gate', () => ({
  OnboardingGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const page = vi.hoisted(() => ({ upload: null as null | ((files: File[]) => Promise<void>) }));
vi.mock('../../src/routes/chat/home', () => ({
  ChatHomePage: ({ projectId }: { projectId?: string }) => {
    const attachments = useAttachments();
    page.upload = attachments.upload;
    return (
      <main data-project={projectId ?? ''}>
        <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
      </main>
    );
  },
}));

let container: HTMLDivElement;
let root: Root;
let router: typeof import('../../src/router')['router'];
let runtime: typeof import('@tanstack/react-router');
let discarded: string[];

beforeEach(async () => {
  vi.resetModules();
  discarded = [];
  let uploaded = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      const method = init?.method ?? 'GET';
      if (path === '/api/me') return Response.json({ user: { id: 'u1', role: 'user' } });
      if (path === '/api/attachments' && method === 'POST') {
        const file = (init!.body as FormData).get('files') as File;
        uploaded += 1;
        return Response.json(
          {
            attachments: [
              {
                id: `file-${uploaded}`,
                filename: file.name,
                mimeType: 'text/plain',
                sizeBytes: file.size,
                url: `/api/attachments/file-${uploaded}/content`,
                thumbnailUrl: null,
                createdAt: '2026-10-06T00:00:00.000Z',
              },
            ],
          },
          { status: 201 },
        );
      }
      if (path.startsWith('/api/attachments/') && method === 'DELETE') {
        discarded.push(path);
        return Response.json({ removed: true });
      }
      return new Response(null, { status: 404 });
    }),
  );
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime = await import('@tanstack/react-router');
  router = (await import('../../src/router')).router;
  router.update({
    history: runtime.createMemoryHistory({ initialEntries: ['/'] }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  await act(async () => {
    await router.load();
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { RouterProvider } = runtime;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const chips = () =>
  [...container.querySelectorAll('[aria-label^="Remove "]')].map((button) =>
    button.getAttribute('aria-label'),
  );

async function attach() {
  await act(async () =>
    page.upload!([
      new File(['notes'], 'walk6-notes.txt', { type: 'text/plain' }),
      new File(['plan'], 'walk6-plan.txt', { type: 'text/plain' }),
    ]),
  );
  expect(chips()).toEqual(['Remove walk6-notes.txt', 'Remove walk6-plan.txt']);
}

it('discards the uploads New Chat leaves behind, as their × does', async () => {
  await attach();
  await act(async () => {
    await router.navigate({ to: '/' });
  });
  expect(chips()).toEqual([]);
  expect(discarded.sort()).toEqual([
    '/api/attachments/file-1/unsent',
    '/api/attachments/file-2/unsent',
  ]);
});

it('discards a file removed with its ×, and only that one', async () => {
  await attach();
  const remove = container.querySelector<HTMLButtonElement>(
    '[aria-label="Remove walk6-notes.txt"]',
  )!;
  await act(async () => remove.click());
  expect(chips()).toEqual(['Remove walk6-plan.txt']);
  expect(discarded).toEqual(['/api/attachments/file-1/unsent']);
});

it('discards them when New Chat moves to a project', async () => {
  await attach();
  await act(async () => {
    await router.navigate({ to: '/', search: { project: 'p1' } });
  });
  expect(discarded.sort()).toEqual([
    '/api/attachments/file-1/unsent',
    '/api/attachments/file-2/unsent',
  ]);
});
