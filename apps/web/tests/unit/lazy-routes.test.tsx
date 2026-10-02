// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api: { get: session.get },
}));
vi.mock('../../src/components/layout/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/components/onboarding/onboarding-gate', () => ({
  OnboardingGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../src/routes/chat/home', () => ({ ChatHomePage: () => <h1>Chat home</h1> }));
vi.mock('../../src/routes/chat/thread', () => ({
  ChatThreadPage: ({ threadId }: { threadId: string }) => <h1>Chat thread {threadId}</h1>,
}));
vi.mock('../../src/routes/auth/login', () => ({ LoginPage: () => <h1>Log in</h1> }));
vi.mock('../../src/routes/auth/signup', () => ({ SignupPage: () => <h1>Sign up</h1> }));
vi.mock('../../src/routes/auth/password-reset', () => ({
  ForgotPasswordPage: () => null,
  ResetPasswordPage: () => null,
}));
vi.mock('../../src/routes/auth/accept-invite', () => ({ AcceptInvitePage: () => null }));
vi.mock('../../src/routes/share/public-share', () => ({ PublicSharePage: () => null }));

// Every lazy entry point has an import-factory spy, not a render spy. This also
// detects accidental eager imports, even when their components are never shown.
const lazyModules = [
  ['components/admin/admin-layout', ['AdminLayout']],
  ['components/settings/settings-layout', ['SettingsLayout']],
  ['routes/admin/overview', ['AdminOverviewPage']],
  ['routes/admin/users', ['AdminUsersPage']],
  ['routes/admin/user-detail', ['AdminUserDetailPage']],
  ['routes/admin/reports', ['AdminReportsPage']],
  ['routes/admin/health', ['AdminHealthPage']],
  ['routes/admin/models', ['AdminModelsPage']],
  ['routes/admin/roles', ['AdminRolesPage']],
  [
    'routes/admin/settings',
    ['AdminGeneralSettingsPage', 'AdminAuthenticationSettingsPage', 'AdminEmailSettingsPage'],
  ],
  ['routes/admin/invites', ['AdminInvitesPage']],
  ['routes/admin/branding', ['AdminBrandingPage']],
  ['routes/admin/quotas', ['AdminQuotasPage']],
  ['routes/admin/search', ['AdminSearchPage']],
  ['routes/admin/connectors', ['AdminConnectorsPage']],
  ['routes/admin/storage', ['AdminStoragePage']],
  ['routes/admin/retention', ['AdminRetentionPage']],
  ['routes/admin/policies', ['AdminPoliciesPage']],
  ['routes/admin/broadcasts', ['AdminBroadcastsPage']],
  ['routes/admin/usage', ['AdminUsagePage']],
  ['routes/admin/audit', ['AdminAuditPage']],
  ['routes/settings/account', ['SettingsAccountPage']],
  ['routes/settings/customization', ['SettingsCustomizationPage']],
  ['routes/settings/history', ['SettingsHistoryPage']],
  ['routes/settings/models', ['SettingsModelsPage']],
  ['routes/settings/connectors', ['SettingsConnectorsPage']],
  ['routes/settings/attachments', ['SettingsAttachmentsPage']],
  ['routes/settings/simple-tabs', ['SettingsShortcutsPage', 'SettingsContactPage']],
] as const;
type ModulePath = (typeof lazyModules)[number][0];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let runtime: typeof import('@tanstack/react-router');
let router: typeof import('../../src/router')['router'];
const imported = vi.fn<(path: ModulePath) => void>();
const gates = new Map<
  ModulePath,
  { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
>();

function holdModule(path: ModulePath) {
  const gate = { started: deferred(), release: deferred() };
  gates.set(path, gate);
  return gate;
}

async function prepare(path: string) {
  // Fresh lazyRouteComponent closures AND fresh module mock factories per test:
  // a previously loaded route cannot make a lazy-import assertion pass falsely.
  runtime = await import('@tanstack/react-router');
  router = (await import('../../src/router')).router;
  router.update({
    history: runtime.createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
}

async function mount() {
  const { RouterProvider } = runtime;
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
}

async function renderRoute(path: string) {
  await prepare(path);
  await act(async () => {
    await router.load();
  });
  await mount();
}

function control(text: string, selector: string): HTMLElement {
  const element = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
    (candidate) => candidate.textContent === text,
  );
  expect(element, `Expected ${selector} named ${text}`).toBeDefined();
  return element!;
}

function expectSafeError(secret: string) {
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not load this page',
  );
  expect(container.textContent).not.toContain(secret);
  expect(control('Reload page', 'button')).toBeDefined();
  expect(control('Back to chat', 'a').getAttribute('href')).toBe('/');
  expect(container.querySelector('[data-page]')).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
}

beforeEach(() => {
  vi.resetModules();
  imported.mockClear();
  gates.clear();
  session.get.mockReset().mockResolvedValue({ user: { id: 'test-user', role: 'admin' } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    }),
  );
  for (const [path, names] of lazyModules) {
    vi.doMock(`../../src/${path}`, async () => {
      imported(path);
      const gate = gates.get(path);
      if (gate) {
        gate.started.resolve();
        await gate.release.promise;
      }
      return Object.fromEntries(
        names.map((name) => [
          name,
          function MockLazyRoute() {
            const { userId } = runtime.useParams({ strict: false });
            if (name.endsWith('Layout')) {
              const { Outlet } = runtime;
              return (
                <section data-layout={name}>
                  <Outlet />
                </section>
              );
            }
            if (name === 'AdminUserDetailPage') {
              return <h1 data-page={name}>User {userId}</h1>;
            }
            return <h1 data-page={name}>{name}</h1>;
          },
        ]),
      );
    });
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  // Release any outstanding import even if an assertion failed.
  for (const gate of gates.values()) gate.release.resolve();
  await act(async () => {
    root.unmount();
  });
  container.remove();
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real router lazy admin and settings routes', () => {
  it('does not import admin/settings layouts or pages during ordinary chat navigation', async () => {
    await renderRoute('/');
    expect(container.textContent).toContain('Chat home');
    expect(imported).not.toHaveBeenCalled();

    await act(async () => {
      await router.navigate({ to: '/chat/$threadId', params: { threadId: 'thread-42' } });
    });
    expect(container.textContent).toContain('Chat thread thread-42');
    expect(imported).not.toHaveBeenCalled();
    expect(session.get).toHaveBeenCalledWith('/me');
  });

  it.each([
    [
      '/admin',
      'components/admin/admin-layout',
      'routes/admin/overview',
      'AdminOverviewPage',
      'AdminLayout',
    ],
    [
      '/admin/users',
      'components/admin/admin-layout',
      'routes/admin/users',
      'AdminUsersPage',
      'AdminLayout',
    ],
    [
      '/settings',
      'components/settings/settings-layout',
      'routes/settings/account',
      'SettingsAccountPage',
      'SettingsLayout',
    ],
    [
      '/settings/contact',
      'components/settings/settings-layout',
      'routes/settings/simple-tabs',
      'SettingsContactPage',
      'SettingsLayout',
    ],
  ] as const)(
    'loads the direct link %s through its lazy layout and page',
    async (path, layout, page, name, layoutName) => {
      await renderRoute(path);
      expect(router.state.location.pathname).toBe(path);
      expect(
        container.querySelector(`[data-layout="${layoutName}"] [data-page="${name}"]`),
      ).not.toBeNull();
      expect(imported.mock.calls.map(([module]) => module).sort()).toEqual([layout, page].sort());
    },
  );

  it('preserves dynamic user-detail parameters across the lazy boundary', async () => {
    await renderRoute('/admin/users/user-42');
    expect(container.querySelector('[data-page="AdminUserDetailPage"]')?.textContent).toBe(
      'User user-42',
    );
    expect(imported).toHaveBeenCalledWith('routes/admin/user-detail');
    expect(imported).toHaveBeenCalledWith('components/admin/admin-layout');
  });

  it.each([
    ['/admin/settings/general', 'AdminGeneralSettingsPage'],
    ['/admin/settings/authentication', 'AdminAuthenticationSettingsPage'],
    ['/admin/settings/email', 'AdminEmailSettingsPage'],
  ] as const)('serves the instance settings page %s from one lazy module', async (path, name) => {
    await renderRoute(path);
    expect(router.state.location.pathname).toBe(path);
    expect(container.querySelector(`[data-page="${name}"]`)).not.toBeNull();
    expect(imported.mock.calls.map(([module]) => module).sort()).toEqual(
      ['components/admin/admin-layout', 'routes/admin/settings'].sort(),
    );
  });

  it('redirects the old /admin/settings address to the General page', async () => {
    await renderRoute('/admin/settings');
    expect(router.state.location.pathname).toBe('/admin/settings/general');
    expect(container.querySelector('[data-page="AdminGeneralSettingsPage"]')).not.toBeNull();
  });

  it('opens Roles & access through its own lazy module', async () => {
    await renderRoute('/admin/roles?role=restricted');
    expect(router.state.location.pathname).toBe('/admin/roles');
    expect(router.state.location.search).toEqual({ role: 'restricted' });
    expect(container.querySelector('[data-page="AdminRolesPage"]')).not.toBeNull();
    expect(imported.mock.calls.map(([module]) => module).sort()).toEqual(
      ['components/admin/admin-layout', 'routes/admin/roles'].sort(),
    );
  });

  it.each([
    ['/admin/providers', '/admin/models', '', 'AdminModelsPage', 'routes/admin/models'],
    [
      '/admin/sso',
      '/admin/settings/authentication',
      'single-sign-on',
      'AdminAuthenticationSettingsPage',
      'routes/admin/settings',
    ],
    ['/admin/rate-limits', '/admin/roles', '', 'AdminRolesPage', 'routes/admin/roles'],
    ['/admin/storage-limits', '/admin/roles', '', 'AdminRolesPage', 'routes/admin/roles'],
    ['/admin/maintenance', '/admin/health', '', 'AdminHealthPage', 'routes/admin/health'],
  ] as const)(
    'redirects the merged page %s to %s and loads only the destination',
    async (from, to, hash, name, module) => {
      await renderRoute(from);
      expect(router.state.location.pathname).toBe(to);
      expect(router.state.location.hash).toBe(hash);
      expect(container.querySelector(`[data-page="${name}"]`)).not.toBeNull();
      expect(imported.mock.calls.map(([entry]) => entry).sort()).toEqual(
        ['components/admin/admin-layout', module].sort(),
      );
    },
  );

  it('lets a read-only auditor into administration', async () => {
    session.get.mockResolvedValue({ user: { id: 'auditor', role: 'auditor' } });
    await renderRoute('/admin/users');
    expect(router.state.location.pathname).toBe('/admin/users');
    expect(
      container.querySelector('[data-layout="AdminLayout"] [data-page="AdminUsersPage"]'),
    ).not.toBeNull();
  });

  it('redirects a non-admin to chat without rendering the admin layout or page', async () => {
    session.get.mockResolvedValue({ user: { id: 'member', role: 'user' } });
    await renderRoute('/admin/users/user-42');
    expect(router.state.location.pathname).toBe('/');
    expect(container.textContent).toContain('Chat home');
    expect(container.querySelector('[data-layout], [data-page]')).toBeNull();
  });

  it.each(['/admin/users/user-42', '/settings/history'])(
    'redirects an anonymous visit to %s to login',
    async (path) => {
      const { ApiError } = await import('../../src/lib/api-client');
      session.get.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'No session'));
      await renderRoute(path);
      expect(router.state.location.pathname).toBe('/auth/login');
      expect(container.textContent).toContain('Log in');
      expect(container.querySelector('[data-layout], [data-page]')).toBeNull();
    },
  );

  it.each([
    ['/admin', 'routes/admin/overview', 'AdminOverviewPage'],
    ['/settings', 'components/settings/settings-layout', 'SettingsAccountPage'],
  ] as const)(
    'announces loading at %s until a pending module is released',
    async (path, module, name) => {
      const gate = holdModule(module);
      await prepare(path);
      vi.useFakeTimers();
      await mount();
      await act(async () => {
        await gate.started.promise;
        await vi.runOnlyPendingTimersAsync();
      });
      expect(imported).toHaveBeenCalledWith(module);
      const status = container.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(`${status?.getAttribute('aria-label')} ${status?.textContent}`).toContain(
        'Loading page',
      );
      expect(container.querySelector('[data-page]')).toBeNull();

      await act(async () => {
        gate.release.resolve();
        await router.load();
      });
      expect(container.querySelector(`[data-page="${name}"]`)).not.toBeNull();
      expect(container.querySelector('[role="status"]')).toBeNull();
    },
  );

  it('shows a safe recoverable error for a rejected lazy module', async () => {
    const secret = 'private-asset-token-123';
    const gate = holdModule('routes/admin/overview');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await prepare('/admin');
    await mount();
    await act(async () => {
      await gate.started.promise;
      gate.release.reject(new Error(secret));
      await router.load();
    });
    expect(imported).toHaveBeenCalledWith('routes/admin/overview');
    expectSafeError(secret);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    await act(async () => {
      control('Reload page', 'button').click();
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(['/admin', '/settings'])(
    'does not expose a session-lookup failure at %s',
    async (path) => {
      const secret = 'database-password-super-secret';
      session.get.mockRejectedValue(new Error(secret));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await renderRoute(path);
      expect(router.state.location.pathname).toBe(path);
      expectSafeError(secret);
    },
  );
});
