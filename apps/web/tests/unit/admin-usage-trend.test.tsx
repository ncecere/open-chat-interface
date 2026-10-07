// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { AdminUsagePage, fillDays, money } from '../../src/routes/admin/usage';
import { cleanup, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

it('draws every day of the range, with empty days as zero', () => {
  const filled = fillDays([{ day: '2026-10-05', value: 42 }], 30, '2026-10-05');
  expect(filled).toHaveLength(30);
  expect(filled[0]).toEqual({ day: '2026-09-06', value: 0 });
  expect(filled.at(-1)).toEqual({ day: '2026-10-05', value: 42 });
  expect(filled.filter((point) => point.value > 0)).toHaveLength(1);
});

let root: Root | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith('/admin/usage/overview')) {
      return {
        range: { days: 30, timezone: 'UTC', exact: true },
        totals: { messages: 42, tokens: 0, costMicros: 0, activeUsers: 1 },
        activity: {
          threadsCreated: 1,
          messagesSent: 27,
          attachmentsUploaded: 0,
          sharesCreated: 0,
          searchesRun: 0,
          branchesCreated: 0,
          temporaryThreads: 0,
          erroredResponses: 0,
          cancelledResponses: 0,
        },
        daily: [{ day: '2026-10-05', messages: 42, activeUsers: 1 }],
      };
    }
    if (path.startsWith('/admin/usage/spend')) {
      const row = { labId: null, messages: 1, tokens: 10, costMicros: 0, errors: 0 };
      return {
        range: { days: 30, timezone: 'UTC', exact: true },
        totals: { messages: 1, tokens: 10, costMicros: 0, activeUsers: 1 },
        daily: [],
        models: {
          entries: [
            { ...row, modelSlug: 'gpt-4-1-mini', displayName: 'GPT-4.1 mini', enabled: true },
            { ...row, modelSlug: 'old-model', displayName: 'Old model', enabled: false },
            { ...row, modelSlug: 'removed-model', displayName: null, enabled: null },
            {
              ...row,
              messages: 0,
              tokens: 247_300,
              modelSlug: 'embedding:text-embedding-3-small',
              displayName: 'text-embedding-3-small',
              kind: 'embeddings',
              enabled: null,
            },
          ],
          totalCount: 4,
        },
        consumers: {
          entries: [
            {
              deleted: true,
              userId: null,
              name: 'Deleted accounts',
              email: null,
              messages: 1,
              costMicros: 0,
            },
          ],
          totalCount: 1,
        },
        idleModels: { entries: [], totalCount: 0 },
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  vi.useRealTimers();
  if (root) await cleanup(root);
  root = undefined;
});

it('says what the chart shows in words, for anyone who cannot hover', async () => {
  ({ root } = await renderAdmin(<AdminUsagePage />, { path: '/admin/usage?range=30' }));
  const chart = document.querySelector('[role="img"]');
  expect(chart?.getAttribute('aria-label')).toBe(
    'Daily replies, 2026-09-06 to 2026-10-05: busiest 2026-10-05 · 42 replies; 1 of 30 days had any.',
  );
  expect(chart?.children).toHaveLength(30);
  // Both ends of the axis, not the same date twice.
  expect(document.body.textContent).toContain('2026-09-06');
  const numbers = document.querySelector('details');
  expect(numbers?.querySelector('summary')?.textContent).toBe('Show the numbers');
  expect(numbers?.textContent).toContain('42 replies');
  // Replies, not "messages": it can exceed Messages sent.
  expect(document.body.textContent).toContain('Replies generated per day');
});

it('says why Messages sent and the usage figures differ: deleted conversations (#262)', async () => {
  ({ root } = await renderAdmin(<AdminUsagePage />, { path: '/admin/usage?range=30' }));
  const overview = document.body.textContent ?? '';
  // The caption blamed regenerations; most of the gap is what was deleted since.
  expect(overview).toContain(
    'Conversations, messages sent and attachments count what is still stored: anything deleted since is not counted.',
  );
  expect(overview).toContain('replies in conversations deleted since still count');
  expect(overview).not.toContain('regenerations included, so this can exceed');
  await cleanup(root!);

  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AdminUsagePage />
    </ThemeProvider>,
    { path: '/admin/usage?tab=spend&range=30' },
  ));
  expect(document.body.textContent).toContain(
    'Messages counts each reply generated, regenerations included, as usage budgets do.',
  );
  expect(document.body.textContent).toContain(
    'Overview’s Messages sent, which counts only messages still stored.',
  );
});

it('labels a disabled model and one outside the chat catalog for what they are', async () => {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <AdminUsagePage />
    </ThemeProvider>,
    { path: '/admin/usage?tab=spend&range=30' },
  ));
  const rows = [...document.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
  expect(rows.find((row) => row.includes('Old model'))).toContain('disabled');
  expect(rows.find((row) => row.includes('removed-model'))).toContain('not in catalog');
  // Embedding usage was labelled "removed", then "not in catalog" under its
  // internal key with "0 messages"; it is an embeddings model, counting tokens (#263).
  const embeddings = rows.find((row) => row.includes('text-embedding-3-small'));
  expect(embeddings).toContain('embeddings');
  expect(embeddings).not.toMatch(/embedding:|catalog/);
  expect(embeddings).toContain('247.3k');
  expect(embeddings).toContain('None: embeddings count tokens only');
  // One message is "1 message" (#263).
  expect(document.body.textContent).toContain('1 message');
  expect(document.body.textContent).not.toContain('1 messages');
  expect(rows.find((row) => row.includes('GPT-4.1 mini'))).not.toMatch(/disabled|catalog|removed/);
});

it('shows every spend figure in cents, and a sliver of a cent as <$0.01 (#88)', () => {
  expect(money(0)).toBe('$0.00');
  // $0.0008 on the card and $0.0000 for an embeddings row, before.
  expect(money(800)).toBe('<$0.01');
  expect(money(30)).toBe('<$0.01');
  expect(money(4_999)).toBe('<$0.01');
  expect(money(5_000)).toBe('$0.01');
  expect(money(1_234_567_890)).toBe('$1,234.57');
});
