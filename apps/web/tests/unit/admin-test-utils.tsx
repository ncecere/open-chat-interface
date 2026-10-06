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
import type { ZodType } from 'zod';
import { AdminAccessProvider, type AdminRole } from '../../src/components/admin/admin-access';
import { ApiError } from '../../src/lib/api-client';

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

const FIXTURE_ROLES = ['admin', 'auditor', 'user', 'restricted'] as const;

/** One role's access summary as GET /admin/roles returns it. */
export function roleAccessFixture(
  role: (typeof FIXTURE_ROLES)[number],
  overrides: Record<string, unknown> = {},
) {
  return {
    role,
    userCount: role === 'user' ? 12 : 1,
    rateLimits: { maxConcurrentStreams: 2, chatRequestsPerMinute: 20, uploadRequestsPerMinute: 10 },
    rateLimitSources: {
      maxConcurrentStreams: 'default',
      chatRequestsPerMinute: 'environment',
      uploadRequestsPerMinute: 'database',
    },
    storage: null,
    budgets: [],
    models: { visible: 3, available: 4 },
    features: {
      attachments: role !== 'restricted',
      shareLinks: false,
      temporaryChat: role !== 'restricted',
      webSearch: false,
      branching: true,
      projects: role !== 'restricted',
      memory: false,
      accountDeletion: false,
    },
    // The built-in defaults: restricted cannot upload, share, go temporary or use projects.
    roleFeatures: {
      webSearch: true,
      attachments: role !== 'restricted',
      shareLinks: role !== 'restricted',
      temporaryChat: role !== 'restricted',
      branching: true,
      projects: role !== 'restricted',
      memory: role !== 'restricted',
      // Off for every role until an administrator allows it (v0.10).
      accountDeletion: false,
      reasoningEfforts: ['instant', 'low', 'medium', 'high'],
    },
    // Built-in default: read tools on for every role except restricted.
    tools: [
      {
        id: 'web_search',
        label: 'Web search',
        kind: 'read',
        source: 'builtin',
        allowed: role !== 'restricted',
      },
    ],
    fixedRules: role === 'auditor' ? ['Can view administration but cannot change it.'] : [],
    ...overrides,
  };
}

export function rolesFixture() {
  return { roles: FIXTURE_ROLES.map((role) => roleAccessFixture(role)) };
}

export function rateLimitsFixture() {
  return {
    roles: Object.fromEntries(
      FIXTURE_ROLES.map((role) => [
        role,
        { maxConcurrentStreams: 2, chatRequestsPerMinute: 20, uploadRequestsPerMinute: 10 },
      ]),
    ),
    authAttemptsPerMinute: 10,
    reserve: { costMicros: 50_000, tokens: 4_000 },
  };
}

export function configSourcesFixture() {
  return {
    retention: {
      trashRetentionDays: 'database',
      threadRetentionDays: 'default',
      exemptPinnedThreads: 'default',
      usageEventRetentionDays: 'environment',
      auditLogRetentionDays: 'default',
      memoryRetentionDays: 'default',
      displayTimezone: 'default',
    },
    rateLimits: {
      roles: Object.fromEntries(
        FIXTURE_ROLES.map((role) => [
          role,
          {
            maxConcurrentStreams: 'default',
            chatRequestsPerMinute: 'environment',
            uploadRequestsPerMinute: 'database',
          },
        ]),
      ),
      authAttemptsPerMinute: 'environment',
      reserve: { costMicros: 'default', tokens: 'database' },
    },
  };
}

/** Sets an input's value the way React observes a user typing. */
export async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** Sets a textarea's value the way React observes a user typing. */
export async function typeIntoTextarea(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/**
 * The error the API returns when `body` fails `schema`: the real schema's Zod
 * issues, through JSON, as middleware/error-handler.ts sends them.
 */
export function validationFailure(schema: ZodType, body: unknown): ApiError {
  const result = schema.safeParse(body);
  if (result.success) throw new Error('The body passed the schema');
  const details = JSON.parse(JSON.stringify(result.error.issues));
  return new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', details);
}

/** Each button's accessible name: its aria-label, else its text. */
export function buttonNames(scope: ParentNode = document): string[] {
  return [...scope.querySelectorAll('button')].map(
    (candidate) => candidate.getAttribute('aria-label') ?? candidate.textContent?.trim() ?? '',
  );
}
