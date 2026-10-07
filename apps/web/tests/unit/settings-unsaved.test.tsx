// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsLayout } from '../../src/components/settings/settings-layout';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { SettingsCustomizationPage } from '../../src/routes/settings/customization';
import { SettingsMemoryPage } from '../../src/routes/settings/memory';
import { SettingsModelsPage } from '../../src/routes/settings/models';
import { cleanup, click, settle, typeInto, typeIntoTextarea } from './admin-test-utils';

// A person's own settings ask before an edit not saved is left behind, as
// administration does (#45, #300): a default model chosen and not saved
// looked applied, and leaving dropped it without a word (#314).

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const model = (slug: string, displayName: string, isDefault = false) =>
  ({
    id: slug,
    slug,
    displayName,
    description: null,
    providerId: 'p',
    providerKind: 'openai-compatible',
    providerLabel: 'Provider',
    upstreamModelId: slug,
    capabilities: [],
    labId: null,
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    isDefault,
    sortOrder: 0,
  }) as unknown as CatalogModel;

let root: Root | undefined;
let confirm: ReturnType<typeof vi.fn<(message?: string) => boolean>>;
beforeEach(() => {
  localStorage.clear();
  confirm = vi.fn<(message?: string) => boolean>(() => false);
  Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true });
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'u1', name: 'Jo Weber', email: 'j.weber@example.edu', role: 'user' },
        preferences: {
          displayName: null,
          occupation: null,
          traits: [],
          additionalContext: null,
          defaultModelSlug: null,
          defaultEffort: null,
        },
        features: {},
        chat: { defaultEffort: 'instant', instanceDefaultEffort: 'instant', defaultProblems: [] },
      };
    if (path === '/models')
      return { models: [model('mini', 'GPT-4.1 mini', true), model('haiku', 'Claude Haiku')] };
    if (path === '/memory')
      return {
        enabled: true,
        available: true,
        entries: [],
        limits: { maxEntries: 200, maxChars: 500 },
      };
    return { allowances: [] };
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  localStorage.clear();
});

/** The real settings layout around `page`, at `path`, in a memory router. */
async function renderSettings(path: string, page: ComponentType) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const rootRoute = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsLayout,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
      settings.addChildren([
        createRoute({
          getParentRoute: () => settings,
          path: path.slice('/settings'.length) || '/',
          component: page,
        }),
        createRoute({ getParentRoute: () => settings, path: '$', component: () => null }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    await router.load();
  });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return router;
}

/** Tries to leave for `to`; a blocked navigation never settles, so it is not awaited. */
async function leave(router: Awaited<ReturnType<typeof renderSettings>>, to: string) {
  await act(async () => {
    void router.navigate({ to: to as never });
  });
  await settle();
}

it('Models › Defaults: a default chosen and not saved asks before Back to Chat (#314)', async () => {
  const router = await renderSettings('/settings/models', SettingsModelsPage);
  await click(document.getElementById('default-model')!);
  const haiku = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent === 'Claude Haiku',
  );
  await click(haiku!);
  // Shown as not saved, not only asked about on leaving.
  expect(document.body.textContent).toContain('Not saved yet');

  await leave(router, '/');
  expect(confirm).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe('/settings/models');
});

it('Customization: an answer typed and not saved asks before another tab (#314)', async () => {
  const router = await renderSettings('/settings/customization', SettingsCustomizationPage);
  await typeInto(document.getElementById('occupation') as HTMLInputElement, 'Registrar');
  expect(document.body.textContent).toContain('Not saved yet');

  await leave(router, '/settings/memory');
  expect(confirm).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe('/settings/customization');
});

it('Customization: nothing changed leaves without asking', async () => {
  const router = await renderSettings('/settings/customization', SettingsCustomizationPage);
  await leave(router, '/settings/memory');
  expect(confirm).not.toHaveBeenCalled();
  expect(router.state.location.pathname).toBe('/settings/memory');
});

it('Memory: a memory typed and not added asks before leaving (#314)', async () => {
  const router = await renderSettings('/settings/memory', SettingsMemoryPage);
  await typeIntoTextarea(
    document.getElementById('memory-new') as HTMLTextAreaElement,
    'I teach chemistry.',
  );
  await leave(router, '/');
  expect(confirm).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe('/settings/memory');
});
