import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AdminAccessProvider, type AdminRole } from '../../src/components/admin/admin-access';

type TestRouter = ReturnType<typeof createRouter>;

/**
 * Renders admin UI inside a fresh query client that never retries.
 *
 * Pages use router links and URL-backed tabs, so the UI is mounted as the root
 * of a throwaway memory router whose catch-all route accepts any navigation.
 */
export async function renderAdmin(
  ui: ReactNode,
  { path = '/', role = 'admin' }: { path?: string; role?: AdminRole } = {},
): Promise<{ root: Root; container: HTMLElement; router: TestRouter }> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => <AdminAccessProvider role={role}>{ui}</AdminAccessProvider>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  }) as unknown as TestRouter;
  await act(async () => {
    await router.load();
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return { root, container, router };
}

/** Lets pending promises, query updates and React commits finish. */
export async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** Dialogs portal to the body, so every lookup searches the whole document. */
export function button(name: string): HTMLButtonElement {
  const match = findButton(name);
  if (!match) throw new Error(`No button named "${name}"`);
  return match;
}

export function findButton(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name,
  );
}

export async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

export function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

export function alerts(scope: ParentNode = document): string[] {
  return [...scope.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? '');
}

export async function pressEscape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await settle();
}

export async function cleanup(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
}
