// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { preloadMarkdownRenderer } from '../../src/components/chat/markdown';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ChatThreadPage } from '../../src/routes/chat/thread';

/**
 * A file that is gone is drawn as gone (#359). It was an ordinary chip with a
 * link that answered 404. The server marks such a file `available: false` in
 * the conversation it sends; the real conversation page, message list, chip
 * and edit box draw it with its name struck through and "No longer
 * available", and not as a link. Only the catalog, the account, the composer
 * and the router are stand-ins, and the network is stubbed.
 */
const model = {
  slug: 'alpha',
  name: 'alpha',
  isDefault: true,
  reasoningMode: 'none',
  supportedEfforts: [],
  capabilities: [],
} as unknown as CatalogModel;
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
  Link: () => null,
}));
vi.mock('../../src/hooks/use-models', () => ({
  useModels: () => ({ data: [model], isPending: false }),
}));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: { features: { branching: true }, chat: {} } }),
}));
vi.mock('../../src/hooks/use-open-conversation', () => ({ useOpenConversation: () => undefined }));
vi.mock('../../src/components/chat/composer', () => ({ Composer: () => null }));
vi.mock('../../src/components/chat/compaction-failure-notice', () => ({
  CompactionFailureNotice: () => null,
}));

const file = (id: string, filename: string, available?: boolean) => ({
  type: 'data-attachment',
  data: {
    id,
    filename,
    mimeType: 'application/pdf',
    url: `/api/attachments/${id}/content`,
    ...(available === undefined ? {} : { available }),
  },
});
const question = {
  id: 'question',
  role: 'user',
  metadata: { modelSlug: 'alpha' },
  parts: [
    { type: 'text', text: 'What is the exact flood mitigation cost?' },
    file('grant', 'walk9-grant.pdf', false),
    file('hours', 'walk9-hours.csv'),
  ],
} as unknown as UIMessage;
const reply: UIMessage = {
  id: 'reply',
  role: 'assistant',
  metadata: { modelSlug: 'alpha' },
  parts: [{ type: 'text', text: '$650.' }],
};
let container: HTMLDivElement;
let root: Root;

// A conversation with replies opens once the Markdown renderer is ready (#311).
beforeAll(() => preloadMarkdownRenderer().then(() => undefined), 30_000);
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  sessionStorage.clear();
  mocks.navigate.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/api/chat/source/messages')
        return Response.json({
          thread: { id: 'source', temporary: false, expiresAt: null, projectId: null },
          messages: [question, reply],
          replies: [],
          page: { olderCursor: null, newerCursor: null, total: 2 },
        });
      if (path.startsWith('/api/threads')) return Response.json({ threads: [], nextCursor: null });
      return Response.json({ error: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TemporaryChatProvider>
          <ChatThreadPage threadId="source" />
        </TemporaryChatProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const removed = () => container.querySelector<HTMLElement>('[data-attachment-state="removed"]');

it('draws a file that is gone as removed, with its name and "No longer available", not as a link', () => {
  const chip = removed();
  expect(chip).not.toBeNull();
  expect(chip?.textContent).toContain('walk9-grant.pdf');
  expect(chip?.textContent).toContain('No longer available');
  expect(chip?.title).toBe('walk9-grant.pdf: no longer available');
  // Nothing to open: not a link, and no request for it.
  expect(chip?.closest('a')).toBeNull();
  expect(chip?.querySelector('a, img')).toBeNull();
  const name = [...chip!.querySelectorAll('span')].find(
    (entry) => entry.textContent === 'walk9-grant.pdf',
  );
  expect(name?.className).toContain('line-through');
});

it('leaves a file that is still there as a link, and the page does not call the other one removed', () => {
  const links = [...container.querySelectorAll('a[href^="/api/attachments/"]')];
  expect(links.map((link) => [link.getAttribute('href'), link.textContent])).toEqual([
    ['/api/attachments/hours/content', 'walk9-hours.csv'],
  ]);
  expect(container.querySelectorAll('[data-attachment-state="removed"]')).toHaveLength(1);
});

it('says in the edit box which file is gone, and lets it be removed', async () => {
  const edit = container.querySelector<HTMLButtonElement>('button[aria-label^="Edit message"]');
  await act(async () => edit!.click());
  const items = [...container.querySelectorAll('ul[aria-label="Attached files"] li')].map(
    (item) => item.textContent,
  );
  expect(items).toEqual(['walk9-grant.pdf(no longer available)', 'walk9-hours.csv']);
  expect(container.querySelector('button[aria-label="Remove walk9-grant.pdf"]')).not.toBeNull();
});
