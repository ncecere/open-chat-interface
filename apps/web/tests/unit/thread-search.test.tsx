// @vitest-environment happy-dom
import {
  SEARCH_HIGHLIGHT_END as END,
  SEARCH_HIGHLIGHT_START as START,
  type ThreadSearchResult,
} from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAdmin, settle } from './admin-test-utils';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-client')>();
  return { ...actual, api: { get: mocks.get } };
});

const { HighlightedText } = await import('../../src/components/search/highlighted-text');
const { parseHighlights, stripHighlights } = await import('../../src/lib/search-highlight');
const { ThreadSearchResultList, ThreadSearchResults } = await import(
  '../../src/components/layout/thread-search-results'
);
const { validateChatThreadSearch } = await import('../../src/lib/chat-search-params');

function result(overrides: Partial<ThreadSearchResult> & { id?: string } = {}): ThreadSearchResult {
  const id = overrides.id ?? 'thread-1';
  return {
    thread: {
      id,
      title: 'Migration planning',
      pinned: false,
      archived: false,
      temporary: false,
      expiresAt: null,
      parentThreadId: null,
      branchedFromMessageId: null,
      lastMessageAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides.thread,
    },
    rank: 0.5,
    titleHighlight: `Migration ${START}planning${END}`,
    matches: [
      {
        messageId: `${id}-message`,
        role: 'assistant',
        snippet: `Start with the ${START}plan${END}.`,
      },
    ],
    ...overrides,
  };
}

describe('search highlight parsing', () => {
  it('splits marked text into plain and matched runs with stable offsets', () => {
    expect(parseHighlights(`a ${START}bc${END} d ${START}e${END}`)).toEqual([
      { start: 0, text: 'a ', highlighted: false },
      { start: 2, text: 'bc', highlighted: true },
      { start: 4, text: ' d ', highlighted: false },
      { start: 7, text: 'e', highlighted: true },
    ]);
  });

  it('tolerates unbalanced markers', () => {
    expect(parseHighlights(`x${END}y${START}z`)).toEqual([
      { start: 0, text: 'xy', highlighted: false },
      { start: 2, text: 'z', highlighted: true },
    ]);
    expect(parseHighlights('')).toEqual([]);
    expect(stripHighlights(`a${START}b${END}c`)).toBe('abc');
  });
});

describe('highlighted text rendering', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it('wraps matches in <mark>', async () => {
    await act(() => root.render(<HighlightedText text={`find ${START}this${END} word`} />));
    const marks = container.querySelectorAll('mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['this']);
    expect(container.textContent).toBe('find this word');
  });

  it('keeps HTML-like content as text', async () => {
    const hostile = `<img src=x onerror="alert(1)"> ${START}<b>bold</b>${END} <script>x()</script>`;
    await act(() => root.render(<HighlightedText text={hostile} />));
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(container.querySelector('mark')?.textContent).toBe('<b>bold</b>');
    expect(container.textContent).toBe(stripHighlights(hostile));
  });
});

describe('chat thread search params', () => {
  it('accepts a message id and ignores anything else', () => {
    expect(validateChatThreadSearch({ message: 'c1f0e7d2-1234-4abc-9def-001122334455' })).toEqual({
      message: 'c1f0e7d2-1234-4abc-9def-001122334455',
    });
    expect(validateChatThreadSearch({})).toEqual({});
    expect(validateChatThreadSearch({ message: 42 })).toEqual({});
    expect(validateChatThreadSearch({ message: '"><script>' })).toEqual({});
    expect(validateChatThreadSearch({ message: 'x'.repeat(200) })).toEqual({});
  });
});

describe('search results list', () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  beforeEach(() => {
    mocks.get.mockReset();
  });
  afterEach(async () => {
    if (root) await act(() => root?.unmount());
    container?.remove();
    root = undefined;
  });

  it('shows the title, snippets with marks and an archived badge, linking to the match', async () => {
    const archived = result({
      id: 'thread-2',
      thread: { ...result().thread, id: 'thread-2', title: 'Old notes', archived: true },
      titleHighlight: 'Old notes',
      matches: [
        { messageId: 'm-user', role: 'user', snippet: `my ${START}plan${END} <div>` },
        { messageId: 'm-reply', role: 'assistant', snippet: `the ${START}planning${END}` },
      ],
    });
    ({ root, container } = await renderAdmin(
      <ThreadSearchResultList results={[result(), archived]} activeThreadId="thread-1" />,
    ));

    const links = [
      ...container.querySelectorAll<HTMLAnchorElement>('ul[aria-label="Search results"] a'),
    ];
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe('/chat/thread-1?message=thread-1-message');
    expect(links[1]?.getAttribute('href')).toBe('/chat/thread-2?message=m-user');

    expect(links[0]?.querySelector('mark')?.textContent).toBe('planning');
    expect(links[0]?.textContent).not.toContain('Archived');
    expect(links[1]?.textContent).toContain('Archived');
    expect(links[1]?.textContent).toContain('You: my plan <div>');
    expect(links[1]?.textContent).toContain('Reply: the planning');
    expect(links[1]?.querySelector('div')).toBeNull();
  });

  it('links a title-only match to the conversation itself', async () => {
    ({ root, container } = await renderAdmin(
      <ThreadSearchResultList results={[result({ matches: [] })]} />,
    ));
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/chat/thread-1');
  });

  it('queries the search endpoint and announces how many matched', async () => {
    mocks.get.mockResolvedValue({ results: [result(), result({ id: 'thread-3' })] });
    ({ root, container } = await renderAdmin(<ThreadSearchResults query="  plan " />));
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    await settle();

    expect(mocks.get).toHaveBeenCalledWith(
      '/threads/search?q=plan&limit=20',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe('2 conversations found.');
    expect(container.querySelectorAll('ul[aria-label="Search results"] li')).toHaveLength(2);
  });

  it('says so when nothing matched', async () => {
    mocks.get.mockResolvedValue({ results: [] });
    ({ root, container } = await renderAdmin(<ThreadSearchResults query="zzz" />));
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    await settle();

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'No conversations matched.',
    );
    expect(container.textContent).toContain('No conversations matched.');
  });
});
