// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentChips } from '../../src/components/chat/attachment-chips';
import { useAttachments } from '../../src/hooks/use-attachments';

/**
 * A failed upload, then New Chat (#208), through the app's real router and
 * the real attachment hook and chips. The browser's own "Failed to fetch"
 * was shown as the reason, and New Chat on the new-chat page kept the failed
 * files, because the router does not remount a route for a navigation to
 * where it already is. Only the shell and the rest of the page are stand-ins.
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

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/api/me') return Response.json({ user: { id: 'u1', role: 'user' } });
      // As Chrome does when the server is out of reach or the file unreadable.
      if (path === '/api/attachments') throw new TypeError('Failed to fetch');
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

const reasons = () =>
  [...container.querySelectorAll('[role="alert"] li')].map((item) => item.textContent);
const chips = () => container.querySelectorAll('[aria-label^="Remove "]').length;

async function failUploads() {
  await act(async () =>
    page.upload!([
      new File(['notes'], 'walk3-notes.txt', { type: 'text/plain' }),
      new File(['plan'], 'walk3-plan.txt', { type: 'text/plain' }),
    ]),
  );
}

it('says in words why an upload got no answer', async () => {
  await failUploads();
  expect(reasons()).toEqual([
    'walk3-notes.txt was not uploaded: the server could not be reached, or the file could not be read. Try again.',
    'walk3-plan.txt was not uploaded: the server could not be reached, or the file could not be read. Try again.',
  ]);
});

it('starts New Chat with an empty composer, from the new-chat page itself', async () => {
  await failUploads();
  expect(chips()).toBe(2);
  await act(async () => {
    await router.navigate({ to: '/' });
  });
  expect(router.state.location.href).toBe('/');
  expect(chips()).toBe(0);
  expect(reasons()).toEqual([]);
});

it('starts afresh when New Chat moves between a project and the general list', async () => {
  await act(async () => {
    await router.navigate({ to: '/', search: { project: 'p1' } });
  });
  await failUploads();
  expect(chips()).toBe(2);
  await act(async () => {
    await router.navigate({ to: '/' });
  });
  expect(container.querySelector('main')?.dataset.project).toBe('');
  expect(chips()).toBe(0);
});
