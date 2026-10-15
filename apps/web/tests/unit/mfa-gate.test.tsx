// @vitest-environment happy-dom
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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MfaBanner } from '../../src/components/layout/mfa-banner';
import { MfaGate } from '../../src/components/mfa/mfa-gate';
import { api } from '../../src/lib/api-client';
import { noteMfaRequiredResponse } from '../../src/lib/mfa-required';
import { settle } from './admin-test-utils';

/**
 * The server refuses a limited session everywhere but enrolment and sign-out
 * (403 MFA_ENROLMENT_REQUIRED, #399). The gate puts such a person on the setup
 * page, whether `/api/me` already says so or a request found out. Real
 * api-client, query client and gate; only the network is faked, as
 * policy-required-gate.test.tsx does for the acceptable use policy.
 */
const refusal = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'MFA_ENROLMENT_REQUIRED',
        message: 'Set up two-step verification to continue.',
        details: { reason: 'enrol', deadline: '2026-10-01T00:00:00.000Z' },
      },
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );

function mfa(overrides: Record<string, unknown> = {}) {
  return {
    eligible: true,
    enrolled: false,
    methods: [],
    recoveryCodesLeft: null,
    required: false,
    deadline: null,
    limited: false,
    ...overrides,
  };
}

let meMfa: Record<string, unknown> | undefined;
let meReads = 0;
let root: Root | undefined;
let router: ReturnType<typeof createRouter> | undefined;

beforeEach(() => {
  meMfa = mfa();
  meReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/me') {
        meReads += 1;
        return Response.json({
          user: { id: 'u1', name: 'Pat', email: 'pat@example.test', role: 'user' },
          preferences: {},
          features: {},
          ...(meMfa ? { mfa: meMfa } : {}),
        });
      }
      return refusal();
    }),
  );
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  router = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function open(ui: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => ui });
  router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  }) as unknown as ReturnType<typeof createRouter>;
  await act(async () => {
    await router?.load();
  });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container;
}

const gate = (
  <MfaGate>
    <p>The application</p>
  </MfaGate>
);

it('shows the application to a person who is not limited', async () => {
  const container = await open(gate);
  expect(container.textContent).toContain('The application');
  expect(router?.state.location.pathname).toBe('/');
});

it('shows the application when the API predates two-step verification', async () => {
  meMfa = undefined;
  const container = await open(gate);
  expect(container.textContent).toContain('The application');
});

it('sends a limited person to the setup page, and renders none of the application', async () => {
  meMfa = mfa({ required: true, limited: true, deadline: '2026-10-01T00:00:00.000Z' });
  const container = await open(gate);
  expect(container.textContent).not.toContain('The application');
  expect(router?.state.location.pathname).toBe('/auth/mfa-setup');
});

it('looks again, and moves a person whose request was refused, to the setup page', async () => {
  const container = await open(gate);
  expect(container.textContent).toContain('The application');
  expect(meReads).toBe(1);

  // A role is required with no grace while the tab is open; the person sends something.
  meMfa = mfa({ required: true, limited: true });
  await expect(api.post('/threads', {})).rejects.toMatchObject({
    status: 403,
    code: 'MFA_ENROLMENT_REQUIRED',
  });
  await settle();

  expect(meReads).toBe(2);
  expect(container.textContent).not.toContain('The application');
  expect(router?.state.location.pathname).toBe('/auth/mfa-setup');
});

it('does the same for an upload or a chat answer, which do not use the api client', async () => {
  const container = await open(gate);
  meMfa = mfa({ required: true, limited: true });

  const response = refusal();
  await noteMfaRequiredResponse(response);
  await settle();

  expect(container.textContent).not.toContain('The application');
  // The body is still there for the caller to read.
  expect(response.bodyUsed).toBe(false);
});

it('leaves any other 403 alone', async () => {
  const container = await open(gate);
  await noteMfaRequiredResponse(
    new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'No.' } }), {
      status: 403,
    }),
  );
  await expect(api.post('/threads', {})).rejects.toMatchObject({ status: 403 });
  await settle();
  // Only the refusals that are this one look at /api/me again.
  expect(meReads).toBeGreaterThanOrEqual(1);
  expect(container.textContent).toContain('The application');
});

const banner = <MfaBanner />;

it('says by when to set up two-step verification, before the deadline', async () => {
  meMfa = mfa({ required: true, deadline: '2030-03-15T12:00:00.000Z' });
  const container = await open(banner);
  const status = container.querySelector('[role="status"]');
  expect(status?.textContent).toContain('Set up two-step verification by');
  expect(status?.textContent).toMatch(/March 1[45], 2030/);
  expect(status?.querySelector('a')?.textContent).toBe('Set up now');
});

it('shows no banner when nothing is required, when it is set up, or when limited', async () => {
  for (const state of [
    mfa(),
    mfa({
      required: true,
      enrolled: true,
      methods: ['totp'],
      deadline: '2030-03-15T12:00:00.000Z',
    }),
    mfa({ required: true, limited: true, deadline: '2020-03-15T12:00:00.000Z' }),
    mfa({ eligible: false }),
  ]) {
    meMfa = state;
    const container = await open(banner);
    expect(container.textContent).toBe('');
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
  }
});
