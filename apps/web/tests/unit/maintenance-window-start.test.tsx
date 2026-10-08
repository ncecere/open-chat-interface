// @vitest-environment happy-dom
import type { ActiveBroadcast, ReadOnlyStatus } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BroadcastBanner } from '../../src/components/layout/broadcast-banner';
import { ReadOnlyBanner } from '../../src/components/layout/read-only-banner';
import { setReadOnlyStatus } from '../../src/lib/read-only';

/**
 * A scheduled maintenance window starting while a page is open (#160). Its
 * announcement stayed beside the read-only banner until a reload (the list
 * of announcements is refreshed every five minutes), the banner came up to
 * a poll (30 s) late, and the banner's unnamed local time read as a
 * different time from the announcement's UTC one. Real timers, the real API
 * client and query cache; the network answers as the API does, by the clock.
 */
const OFF: ReadOnlyStatus = {
  active: false,
  source: null,
  reason: null,
  until: null,
  window: null,
};

let startsAt: number;
let endsAt: number;
beforeEach(() => {
  setReadOnlyStatus(OFF);
  startsAt = Date.now() + 400;
  endsAt = startsAt + 60 * 60_000;
  const window = {
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
  };
  const announcement: ActiveBroadcast = {
    id: 'b1',
    title: 'Scheduled maintenance',
    body: 'From Monday, 5 October 2026 at 23:54 UTC until Monday, 5 October 2026 at 23:56 UTC, this service will be read-only.',
    level: 'warning',
    dismissable: true,
    endsAt: window.startsAt,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      const started = Date.now() >= startsAt;
      // evaluateReadOnly and activeBroadcastsFor, by the clock.
      if (path === '/api/maintenance')
        return Response.json(
          started
            ? { active: true, source: 'schedule', reason: null, until: window.endsAt, window }
            : { ...OFF, window },
        );
      if (path === '/api/me/broadcasts')
        return Response.json({ broadcasts: started ? [] : [announcement] });
      return new Response(null, { status: 404 });
    }),
  );
});

let root: Root;
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  setReadOnlyStatus(OFF);
});

const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

it('hands over from the announcement to the read-only banner at the start', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ReadOnlyBanner />
        <BroadcastBanner />
      </QueryClientProvider>,
    ),
  );
  await pause(50);
  expect(container.textContent).toContain('Scheduled maintenance');
  expect(container.textContent).not.toContain('Read-only for maintenance');

  // Just past the start, and its one-second margin for the server.
  await pause(startsAt - Date.now() + 1_300);
  expect(container.textContent).not.toContain('Scheduled maintenance');
  const banner = container.querySelector('[role="status"]')?.textContent ?? '';
  expect(banner).toContain('Read-only for maintenance until about');

  // The end, in the reader's zone, with the zone named.
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(new Date(endsAt))
    .find((part) => part.type === 'timeZoneName')!.value;
  expect(banner).toMatch(
    new RegExp(`until about [^:]*\\d{1,2}:\\d{2}[^:]*${zone.replace(/[+]/g, '\\+')}:`),
  );
}, 10_000);
