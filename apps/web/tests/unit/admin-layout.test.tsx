// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminLayout } from '../../src/components/admin/admin-layout';
import { button, click, dialog, pressEscape, settle } from './admin-test-utils';

let root: Root | undefined;

async function renderLayout(path: string, role: 'admin' | 'auditor' = 'admin') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const rootRoute = createRootRoute();
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'admin',
    beforeLoad: () => ({ session: { user: { id: 'viewer', role } } }),
    component: AdminLayout,
  });
  const page = (title: string) => () => <h1>{title}</h1>;
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      adminRoute.addChildren([
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/admin',
          component: page('Overview'),
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/admin/users',
          component: page('Users'),
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/admin/users/$userId',
          component: page('User detail'),
        }),
        createRoute({
          getParentRoute: () => adminRoute,
          path: '/admin/invites',
          component: page('Invitations'),
        }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    await router.load();
  });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return { router, container };
}

function desktopNav(container: HTMLElement): HTMLElement {
  const nav = container.querySelector<HTMLElement>('aside nav[aria-label="Administration"]');
  if (!nav) throw new Error('No desktop navigation');
  return nav;
}

function link(scope: ParentNode, name: string): HTMLAnchorElement {
  const match = [...scope.querySelectorAll('a')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No link named "${name}"`);
  return match;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});

describe('admin layout navigation', () => {
  it('marks the owning page current on nested paths, and not Overview', async () => {
    const { container } = await renderLayout('/admin/users/user-42');
    const nav = desktopNav(container);
    expect(link(nav, 'Users').getAttribute('aria-current')).toBe('page');
    expect(link(nav, 'Overview').getAttribute('aria-current')).toBeNull();
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(link(container, 'Back to chat').getAttribute('href')).toBe('/');
    expect(container.textContent).toContain('Administration');
  });

  it('keeps the skip link and a focusable main scroll region', async () => {
    const { container } = await renderLayout('/admin');
    expect(link(container, 'Skip to main content').getAttribute('href')).toBe('#main-content');
    const main = container.querySelector('main #main-content');
    expect(main?.getAttribute('tabindex')).toBe('0');
    expect(link(desktopNav(container), 'Overview').getAttribute('aria-current')).toBe('page');
  });

  it('opens the mobile drawer, navigates from it, and closes', async () => {
    const { router, container } = await renderLayout('/admin');
    expect(dialog()).toBeNull();
    // The narrow top bar names the current page.
    expect(container.querySelector('header')?.textContent).toContain('Overview');

    await click(button('Open admin navigation'));
    const drawer = dialog();
    expect(drawer).not.toBeNull();
    expect(drawer?.querySelector('nav[aria-label="Administration"]')).not.toBeNull();

    await click(link(drawer as HTMLElement, 'Invitations'));
    expect(router.state.location.pathname).toBe('/admin/invites');
    expect(dialog()).toBeNull();
    expect(container.querySelector('header')?.textContent).toContain('People');
    expect(container.querySelector('header')?.textContent).toContain('Invitations');

    await click(button('Open admin navigation'));
    expect(dialog()).not.toBeNull();
    await pressEscape();
    expect(dialog()).toBeNull();
  });
});

describe('read-only access', () => {
  const banner = 'Read-only access — you can view administration but not change it.';

  it('announces read-only access to an auditor', async () => {
    const { container } = await renderLayout('/admin/users', 'auditor');
    const status = [...container.querySelectorAll('[role="status"]')].find((node) =>
      node.textContent?.includes(banner),
    );
    expect(status).toBeDefined();
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('shows no banner to an administrator', async () => {
    const { container } = await renderLayout('/admin/users');
    expect(container.textContent).not.toContain(banner);
  });
});
