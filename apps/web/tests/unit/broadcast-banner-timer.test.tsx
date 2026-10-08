// @vitest-environment happy-dom
import type { ActiveBroadcast } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BroadcastBanner } from '../../src/components/layout/broadcast-banner';

/**
 * An announcement that ends while the page is open leaves with the end (#160). The timer
 * that hides it can fire a millisecond or so before Date.now() reaches the end time, and it
 * was set once for that time: with the clock still short of it the announcement stayed, and
 * nothing set another timer, so it stayed until the five-minute refresh (it sat beside the
 * read-only banner of a maintenance window that had started).
 */
let root: Root;
let container: HTMLDivElement;
let endsAt: number;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  endsAt = Date.now() + 400;
  const announcement: ActiveBroadcast = {
    id: 'b1',
    title: 'Scheduled maintenance',
    body: 'This service will be read-only.',
    level: 'warning',
    dismissable: true,
    endsAt: new Date(endsAt).toISOString(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      return path === '/api/me/broadcasts'
        ? Response.json({ broadcasts: [announcement] })
        : new Response(null, { status: 404 });
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('hides an announcement when its timer fires before the clock reaches its end', async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <BroadcastBanner />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain('Scheduled maintenance'));

  // The timer is armed; from here the clock reads a millisecond short of the end when it fires.
  vi.spyOn(Date, 'now').mockReturnValue(endsAt - 1);
  await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
  expect(container.textContent).not.toContain('Scheduled maintenance');
});
