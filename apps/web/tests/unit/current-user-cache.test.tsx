// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCurrentUser } from '../../src/hooks/use-current-user';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function Probe() {
  const { data } = useCurrentUser();
  return <output>{data ? data.user.email : 'anonymous'}</output>;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  root = createRoot(container);
  client = new QueryClient();
  api.get.mockReset().mockResolvedValue({ user: { email: 'next@example.test' }, features: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
});

async function mount() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

it('fetches the account again instead of reusing a cached anonymous answer', async () => {
  // What signing out leaves behind: /me answered 401 a moment ago.
  client.setQueryData(['me'], null);
  await mount();
  expect(api.get).toHaveBeenCalledWith('/me');
  expect(container.textContent).toBe('next@example.test');
});

it('still reuses a recent signed-in answer', async () => {
  client.setQueryData(['me'], { user: { email: 'cached@example.test' }, features: {} });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  expect(api.get).not.toHaveBeenCalled();
  expect(container.textContent).toBe('cached@example.test');
});
