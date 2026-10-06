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
 * Edit → Save & submit on a question sent with a file (#296). The edit box
 * showed only the text and the branch was made without the file, so the new
 * answer was made up. The edit box now shows the question's files as chips,
 * each removable, and the branch request names the files the edit keeps. The
 * real conversation page, message list, edit box, chat session, query cache
 * and branch request run against a stubbed network; only the catalog, the
 * account, the composer and the router are stand-ins.
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

const file = (id: string, filename: string) => ({
  type: 'data-attachment',
  data: { id, filename, mimeType: 'text/plain', url: `/api/attachments/${id}/content` },
});
const question = {
  id: 'question',
  role: 'user',
  metadata: { modelSlug: 'alpha' },
  parts: [
    { type: 'text', text: 'What is the lab mascot called?' },
    file('notes', 'walk6-gw-notes.txt'),
    file('agenda', 'walk6-agenda.txt'),
  ],
} as unknown as UIMessage;
const reply: UIMessage = {
  id: 'reply',
  role: 'assistant',
  metadata: { modelSlug: 'alpha' },
  parts: [{ type: 'text', text: 'OSPREY-ZETA.' }],
};
let branchBodies: { messageId: string; text: string; attachmentIds?: string[] }[];
let container: HTMLDivElement;
let root: Root;

// A conversation with replies opens once the Markdown renderer is ready (#311).
beforeAll(() => preloadMarkdownRenderer().then(() => undefined), 30_000);
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  sessionStorage.clear();
  mocks.navigate.mockReset();
  branchBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      const method = init?.method?.toUpperCase() ?? 'GET';
      if (path === '/api/chat/source/messages')
        return Response.json({
          thread: { id: 'source', temporary: false, expiresAt: null, projectId: null },
          messages: [question, reply],
          replies: [],
          page: { olderCursor: null, newerCursor: null, total: 2 },
        });
      if (path === '/api/threads/source/branches' && method === 'POST') {
        branchBodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          thread: { id: 'branch' },
          message: { id: 'question-copy', modelSlug: 'alpha', effort: null },
        });
      }
      if (path.startsWith('/api/threads') && method === 'GET')
        return Response.json({ threads: [], nextCursor: null });
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

function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(
    (entry) =>
      entry.getAttribute('aria-label')?.startsWith(label) || entry.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
const chips = () =>
  [...container.querySelectorAll('ul[aria-label="Attached files"] li')].map(
    (chip) => chip.textContent,
  );

async function remove(filename: string) {
  const removing = button(`Remove ${filename}`);
  removing.focus();
  await act(async () => removing.click());
  // Focus moves once the chip has gone (a mutation observer).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('shows the question’s files in the edit box and keeps them in the branch', async () => {
  await act(async () => button('Edit message').click());
  expect(chips()).toEqual(['walk6-gw-notes.txt', 'walk6-agenda.txt']);
  await act(async () => button('Save & submit').click());
  expect(branchBodies).toEqual([
    {
      messageId: 'question',
      text: 'What is the lab mascot called?',
      attachmentIds: ['notes', 'agenda'],
    },
  ]);
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/chat/$threadId',
    params: { threadId: 'branch' },
  });
});

it('leaves out a file removed in the edit box, and says so', async () => {
  await act(async () => button('Edit message').click());
  await remove('walk6-gw-notes.txt');
  expect(chips()).toEqual(['walk6-agenda.txt']);
  expect(container.textContent).toContain('Removed files are left out of the edited message.');
  // Focus moves to the remaining chip's ×, not the page.
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove walk6-agenda.txt');
  await act(async () => button('Save & submit').click());
  expect(branchBodies[0]?.attachmentIds).toEqual(['agenda']);
});

it('moves focus to the text box when the last file is removed', async () => {
  await act(async () => button('Edit message').click());
  await remove('walk6-gw-notes.txt');
  await remove('walk6-agenda.txt');
  expect(chips()).toEqual([]);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit message text');
  await act(async () => button('Save & submit').click());
  expect(branchBodies[0]?.attachmentIds).toEqual([]);
});
