// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { denseActivity, formatActivityDay } from '../../src/lib/activity-series';
import { AdminOverviewPage } from '../../src/routes/admin/overview';
import { cleanup, renderAdmin } from './admin-test-utils';

/**
 * Overview › Messages per day (#348): its label said "the last 3 days" over an
 * axis that ran six, the days with no messages were left out (so the line
 * crossed them and the busy days sat evenly apart), and the axis dates were
 * ISO. Real page, real chart; only the API answer is a stand-in.
 */
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const day = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

function serve(activity: { day: string; messages: number }[]) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/setup-status')
      return { requiredComplete: 0, requiredTotal: 0, checks: [] };
    if (path === '/admin/health') return { status: 'ok', checks: [] };
    return {
      users: { total: 7, admins: 1 },
      threads: { total: 3, last24h: 1, previous24h: 0 },
      messages: { total: 12, last24h: 4, previous24h: 0 },
      storage: { totalBytes: 0, fileCount: 0 },
      activity,
      providers: { configured: 1 },
      models: { total: 1, enabled: 1 },
      system: { version: '0.5.0', database: 'ok', redis: 'ok' },
    };
  });
}

const chart = () => document.querySelector('svg[role="img"][aria-label^="Messages per day"]')!;

it('labels the days the axis shows, draws the quiet ones at zero and writes dates for a reader', async () => {
  // As a server that lists only the days with messages answers: three days
  // over a six-day span.
  serve([
    { day: day(5), messages: 20 },
    { day: day(1), messages: 79 },
    { day: day(0), messages: 3 },
  ]);
  ({ root } = await renderAdmin(<AdminOverviewPage />));

  const svg = chart();
  expect(svg.getAttribute('aria-label')).toBe(
    `Messages per day over the last 6 days, ${formatActivityDay(day(5))} to ${formatActivityDay(day(0))}, peaking at 79`,
  );
  // Six points, evenly spaced days; the four with no messages sit on the baseline.
  const points = svg
    .querySelector('polyline')!
    .getAttribute('points')!
    .split(' ')
    .map((pair) => pair.split(',').map(Number) as [number, number]);
  expect(points.map(([x]) => x)).toEqual([0, 20, 40, 60, 80, 100]);
  expect(points.map(([, y]) => y === 30)).toEqual([false, true, true, true, false, false]);

  // The ends of the axis, as dates ("Oct 1"), not 2026-10-01.
  const section = svg.closest('section')!;
  const ends = [...section.querySelectorAll('p span')].map((span) => span.textContent);
  expect(ends).toEqual([formatActivityDay(day(5)), formatActivityDay(day(0))]);
  expect(section.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(section.textContent).toContain('UTC');
});

it('draws every day the API sends, and says how many', async () => {
  serve(Array.from({ length: 14 }, (_, index) => ({ day: day(13 - index), messages: index % 3 })));
  ({ root } = await renderAdmin(<AdminOverviewPage />));
  expect(chart().getAttribute('aria-label')).toMatch(/^Messages per day over the last 14 days, /);
});

it('fills the days between the first and last, and leaves a malformed series alone', () => {
  expect(
    denseActivity([
      { day: '2026-10-01', messages: 4 },
      { day: '2026-10-04', messages: 2 },
    ]),
  ).toEqual([
    { day: '2026-10-01', messages: 4 },
    { day: '2026-10-02', messages: 0 },
    { day: '2026-10-03', messages: 0 },
    { day: '2026-10-04', messages: 2 },
  ]);
  expect(denseActivity([])).toEqual([]);
  expect(denseActivity([{ day: 'yesterday', messages: 1 }])).toEqual([
    { day: 'yesterday', messages: 1 },
  ]);
});

it('writes a UTC day as that date in any time zone, with the year only when it is not this one', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const now = new Date('2026-10-06T12:00:00Z');
    // Read as a local date, 2026-10-01 would be September 30 here.
    expect(formatActivityDay('2026-10-01', now)).toMatch(/Oct(ober)? 1\b|1 Oct/);
    expect(formatActivityDay('2026-10-01', now)).not.toContain('2026');
    expect(formatActivityDay('2025-12-31', now)).toContain('2025');
    expect(formatActivityDay('nonsense', now)).toBe('nonsense');
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
