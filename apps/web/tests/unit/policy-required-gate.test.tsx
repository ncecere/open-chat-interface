// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OnboardingGate } from '../../src/components/onboarding/onboarding-gate';
import { api } from '../../src/lib/api-client';
import { notePolicyRequiredResponse } from '../../src/lib/policy-required';
import { settle } from './admin-test-utils';

/**
 * The API refuses a write until the published acceptable use policy is
 * accepted (#367). A tab that was open when a new version came out still holds
 * the gate's old answer ("nothing to accept"), so the refusal itself must put
 * the acceptance page in front of the application. Real api-client, real
 * QueryClient and gate; only the network is faked.
 */
const refusal = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'POLICY_ACCEPTANCE_REQUIRED',
        message: 'You must accept the acceptable use policy (version 2) before you can do this.',
        details: { policy: { id: 'policy-2', version: 2, title: 'Acceptable use' } },
      },
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );

let pendingPolicy: null | Record<string, unknown> = null;
let onboardingReads = 0;
let root: Root | undefined;

beforeEach(() => {
  pendingPolicy = null;
  onboardingReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/me/onboarding') {
        onboardingReads += 1;
        return Response.json({ pendingPolicy, needsIntroduction: false });
      }
      return refusal();
    }),
  );
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function open() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <OnboardingGate>
          <p>The application</p>
        </OnboardingGate>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container;
}

it('shows the acceptance page when a request is refused for want of an acceptance', async () => {
  const container = await open();
  expect(container.textContent).toContain('The application');
  expect(onboardingReads).toBe(1);

  // A new version is published while the tab is open; the person sends something.
  pendingPolicy = {
    id: 'policy-2',
    version: 2,
    title: 'Acceptable use',
    body: 'Be kind.',
    isUpdate: true,
  };
  await expect(api.post('/threads', {})).rejects.toMatchObject({
    status: 403,
    code: 'POLICY_ACCEPTANCE_REQUIRED',
  });
  await settle();

  expect(onboardingReads).toBe(2);
  expect(container.textContent).not.toContain('The application');
  expect(container.textContent).toContain('Acceptable use');
  expect(container.textContent).toContain('I accept');
});

it('does the same for an upload or a chat answer, which do not use the api client', async () => {
  const container = await open();
  pendingPolicy = { id: 'policy-2', version: 2, title: 'Acceptable use', body: 'Be kind.' };

  const response = refusal();
  await notePolicyRequiredResponse(response);
  await settle();

  expect(container.textContent).toContain('I accept');
  // The body is still there for the caller to read.
  expect(response.bodyUsed).toBe(false);
});

it('leaves any other 403 alone', async () => {
  const container = await open();
  await notePolicyRequiredResponse(
    new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'No.' } }), {
      status: 403,
    }),
  );
  await settle();
  expect(onboardingReads).toBe(1);
  expect(container.textContent).toContain('The application');
});
