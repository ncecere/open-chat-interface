// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import { nameTableFullscreen } from '../../src/components/chat/streamdown-control-names';
import {
  installStreamdownScrollRegions,
  uninstallStreamdownScrollRegions,
} from '../../src/components/chat/streamdown-overlay-focus';
import { PublicSharePage } from '../../src/routes/share/public-share';

/**
 * #293: the #271 fix named code blocks, tables and message controls by their
 * message's first 40 characters, so replies that open alike ("Here is the
 * short Python example you asked for…", then "Again." twice) still shared
 * every name: three "Code block 1 (Python) in “Here is the short Python
 * example you…”" regions and two "Edit message “Again.”". The real list,
 * rows, share page and lazily loaded Streamdown renderer.
 */
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // The renderer installs this once, when it loads; another test may have removed it.
  installStreamdownScrollRegions();
});
afterEach(async () => {
  await act(async () => root.unmount());
  uninstallStreamdownScrollRegions();
  document.body.innerHTML = '';
});

const REPLY =
  'Here is the short Python example you asked for, with a table.\n\n```python\nprint(1)\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |';
const message = (id: string, role: UIMessage['role'], text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
  metadata: { status: 'complete', createdAt: '2026-10-06T12:00:00.000Z' },
});
const CONVERSATION = [
  message('q1', 'user', 'Show me a short Python example with a table'),
  message('a1', 'assistant', REPLY),
  message('q2', 'user', 'Again.'),
  message('a2', 'assistant', REPLY),
  message('q3', 'user', 'Again.'),
  message('a3', 'assistant', REPLY),
];
const IN = (reply: number) => ` in “Here is the short Python example you…” (reply ${reply})`;

const names = (scope: ParentNode, selector: string) =>
  [...scope.querySelectorAll(selector)].map((element) => element.getAttribute('aria-label'));

const tablesNamed = (count: number) =>
  vi.waitFor(
    () =>
      expect(
        names(container, '[role="region"]').filter((name) => name?.startsWith('Table 1')),
      ).toHaveLength(count),
    { timeout: 5_000 },
  );

it('names the blocks and controls of messages that open alike by their place', async () => {
  await act(async () =>
    root.render(
      <MessageList
        messages={CONVERSATION}
        streaming={false}
        threadId="thread-1"
        onFork={async () => {}}
        onEdit={async () => {}}
      />,
    ),
  );
  await tablesNamed(3);

  expect(names(container, '[role="region"]')).toEqual([
    `Code block 1 (Python)${IN(1)}`,
    `Table 1${IN(1)}`,
    `Code block 1 (Python)${IN(2)}`,
    `Table 1${IN(2)}`,
    `Code block 1 (Python)${IN(3)}`,
    `Table 1${IN(3)}`,
  ]);
  const buttons = names(container, 'button[aria-label]');
  expect(buttons).toEqual(
    expect.arrayContaining([
      `Copy code block 1 (Python)${IN(2)}`,
      `Download code block 1 (Python)${IN(2)}`,
      `Copy table 1${IN(3)}`,
      `Download table 1${IN(3)}`,
      `View table 1 full screen${IN(3)}`,
      'Copy message “Here is the short Python example you…” (reply 1)',
      'Export as… “Here is the short Python example you…” (reply 2)',
      'Fork conversation at “Here is the short Python example you…” (reply 3)',
      'Copy message “Again.” (question 2)',
      'Fork conversation at “Again.” (question 3)',
      'Edit message “Again.” (question 2)',
      'Edit message “Again.” (question 3)',
      // A message that opens differently keeps the shorter name.
      'Edit message “Show me a short Python example with a…”',
    ]),
  );
  // No two buttons or regions in the conversation share a name.
  expect(new Set(buttons).size).toBe(buttons.length);
  const regions = names(container, '[role="region"]');
  expect(new Set(regions).size).toBe(regions.length);
});

it('names them apart on the share page too', async () => {
  api.get.mockImplementation(async (path: string) =>
    path.startsWith('/share-links/')
      ? {
          thread: { title: 'Shared', sharedAt: '2026-10-06T12:00:00.000Z' },
          messages: CONVERSATION.map(({ id, role, parts }) => ({ id, role, parts })),
          expiresAt: null,
          snapshot: false,
        }
      : {},
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <PublicSharePage slug="shared" />
      </QueryClientProvider>,
    ),
  );
  await tablesNamed(3);
  const regions = names(container, '[role="region"]');
  expect(regions).toContain(`Table 1${IN(2)}`);
  expect(new Set(regions).size).toBe(regions.length);
  const buttons = names(container, 'button[aria-label]');
  expect(buttons).toContain(`Copy code block 1 (Python)${IN(3)}`);
  expect(new Set(buttons).size).toBe(buttons.length);
});

it('names a table’s full-screen view for its place too', () => {
  const opener = document.createElement('button');
  opener.setAttribute('aria-label', `View table 1 full screen${IN(2)}`);
  const overlay = document.createElement('div');
  overlay.innerHTML =
    '<button title="Copy table"></button><button title="Exit fullscreen"></button>';
  nameTableFullscreen(overlay, opener);
  expect(overlay.getAttribute('aria-label')).toBe(`Table 1${IN(2)}, full screen`);
  expect(names(overlay, 'button')).toEqual([`Copy table 1${IN(2)}`, 'Exit full screen']);
});
