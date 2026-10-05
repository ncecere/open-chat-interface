// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryPages } from '../../src/hooks/use-history-pages';
import {
  getChatHistory,
  getInitialHistory,
  joinIsland,
  mergeLatest,
  refreshLimit,
} from '../../src/lib/chat-history';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', () => ({
  api: { get: mocks.get },
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message = 'error',
    ) {
      super(message);
    }
  },
}));

const thread = { id: 't', temporary: false, expiresAt: null };
const message = (n: number): UIMessage => ({
  id: `m${n}`,
  role: n % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: `message ${n}` }],
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => message(from + index));
const ids = (messages: UIMessage[]) => messages.map((m) => m.id);

/** A paged server over `count` messages with pages of `size`, as the API answers (v0.11). */
function pagedServer(count: number, size = 10) {
  const all = range(0, count);
  return (path: string) => {
    const url = new URL(path, 'http://local');
    const limit = size;
    const before = url.searchParams.get('before');
    const after = url.searchParams.get('after');
    const around = url.searchParams.get('around');
    let from: number;
    let to: number;
    let targetFound: boolean | undefined;
    if (before) {
      to = all.findIndex((m) => m.id === before);
      from = Math.max(0, to - limit);
    } else if (after) {
      from = all.findIndex((m) => m.id === after) + 1;
      to = Math.min(all.length, from + limit);
    } else if (around) {
      const index = all.findIndex((m) => m.id === around);
      targetFound = index >= 0;
      from = index >= 0 ? Math.max(0, index - Math.floor((limit - 1) / 2)) : all.length - limit;
      to = index >= 0 ? Math.min(all.length, from + limit) : all.length;
    } else {
      to = all.length;
      from = Math.max(0, to - limit);
    }
    const messages = all.slice(from, to);
    return Promise.resolve({
      thread,
      messages,
      replies: [],
      page: {
        olderCursor: from > 0 ? (messages[0]?.id ?? null) : null,
        newerCursor: to < all.length ? (messages.at(-1)?.id ?? null) : null,
        total: all.length,
        ...(targetFound === undefined ? {} : { targetFound }),
      },
    });
  };
}

beforeEach(() => {
  mocks.get.mockReset();
});

describe('conversation history in pages', () => {
  it('asks for a page only when asked, and describes an old server as one page', async () => {
    mocks.get.mockResolvedValue({ thread, messages: range(0, 3) });
    const whole = await getChatHistory('t');
    expect(mocks.get).toHaveBeenLastCalledWith('/chat/t/messages', { signal: undefined });
    expect(whole).toMatchObject({
      paged: false,
      page: { olderCursor: null, newerCursor: null, total: 3 },
      replies: [],
    });
    await getChatHistory('t', undefined, { before: 'm5', limit: 20 });
    expect(mocks.get).toHaveBeenLastCalledWith('/chat/t/messages?limit=20&before=m5', {
      signal: undefined,
    });
    await getChatHistory('t', undefined, {});
    expect(mocks.get).toHaveBeenLastCalledWith('/chat/t/messages?limit=100', {
      signal: undefined,
    });
  });

  it('rejects a malformed page', async () => {
    mocks.get.mockResolvedValue({ thread, messages: [], page: { olderCursor: 3 } });
    await expect(getChatHistory('t', undefined, {})).rejects.toThrow('Invalid conversation');
  });

  it('opens at the latest page, or around a search result with the gap kept apart', async () => {
    mocks.get.mockImplementation(pagedServer(100, 10));
    const latest = await getInitialHistory('t');
    expect(ids(latest.messages)).toEqual(ids(range(90, 100)));
    expect(latest).toMatchObject({ island: null, before: [], olderCursor: 'm90' });

    const far = await getInitialHistory('t', undefined, 'm20');
    expect(ids(far.island!.messages)).toEqual(ids(range(16, 26)));
    expect(far.island).toMatchObject({ olderCursor: 'm16', newerCursor: 'm25' });
    expect(ids(far.messages)).toEqual(ids(range(90, 100)));
    expect(far.olderCursor).toBe('m90');

    // Near the end the window meets the latest page: one segment.
    const near = await getInitialHistory('t', undefined, 'm86');
    expect(near.island).toBeNull();
    expect(ids(near.before)).toEqual(ids(range(82, 90)));
    expect(near.olderCursor).toBe('m82');
  });

  it('joins a refreshed latest page to the live messages without repeating older ones', () => {
    const current = range(50, 60);
    // Reaches back past the live part: only from its first message on.
    expect(ids(mergeLatest(current, range(45, 62)))).toEqual(ids(range(50, 62)));
    // Starts inside it: keeps the live part's start.
    expect(ids(mergeLatest(current, range(55, 62)))).toEqual(ids(range(50, 62)));
    // Nothing in common (a conversation that was empty when opened).
    expect(ids(mergeLatest([message(999)], range(0, 2)))).toEqual(['m0', 'm1']);
    expect(refreshLimit(10)).toBe(100);
    expect(refreshLimit(150)).toBe(170);
    expect(refreshLimit(10_000)).toBe(500);
  });

  it('joins an island to the rest when they meet', () => {
    expect(
      joinIsland(range(10, 20), { olderCursor: 'm10', newerCursor: 'm19' }, [message(15)]),
    ).toEqual({ island: null, before: range(10, 15) });
    expect(
      joinIsland(range(10, 20), { olderCursor: 'm10', newerCursor: 'm19' }, [message(30)]).island,
    ).toEqual({ messages: range(10, 20), olderCursor: 'm10', newerCursor: 'm19' });
  });
});

describe('useHistoryPages', () => {
  let container: HTMLDivElement;
  let root: Root;
  let pages: ReturnType<typeof useHistoryPages>;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
  });
  function Probe(props: Parameters<typeof useHistoryPages>[0]) {
    pages = useHistoryPages(props);
    return null;
  }
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  it('loads earlier pages before the live part until the start, announcing each', async () => {
    mocks.get.mockImplementation(pagedServer(25, 10));
    const live = range(15, 25);
    await act(() =>
      root.render(
        <Probe
          threadId="t"
          live={live}
          initial={{ before: [], olderCursor: 'm15', island: null }}
        />,
      ),
    );
    expect(pages.controls).toMatchObject({ hasOlder: true, gapAfter: null });
    await act(() => pages.controls.loadOlder());
    await settle();
    expect(ids(pages.older)).toEqual(ids(range(5, 15)));
    expect(pages.controls.announcement).toBe('Loaded 10 messages earlier in the conversation.');
    await act(() => pages.controls.loadOlder());
    await settle();
    expect(ids(pages.older)).toEqual(ids(range(0, 15)));
    expect(pages.controls.hasOlder).toBe(false);
    expect(pages.controls.announcement).toContain('This is the start of the conversation.');
  });

  it('takes what precedes the loaded messages from an old server’s whole conversation', async () => {
    mocks.get.mockResolvedValue({ thread, messages: range(0, 25) });
    await act(() =>
      root.render(
        <Probe
          threadId="t"
          live={range(15, 25)}
          initial={{ before: [], olderCursor: 'm15', island: null }}
        />,
      ),
    );
    await act(() => pages.controls.loadOlder());
    await settle();
    expect(ids(pages.older)).toEqual(ids(range(0, 15)));
    expect(pages.controls.hasOlder).toBe(false);
  });

  it('fills the gap below an island from either side and joins them', async () => {
    mocks.get.mockImplementation(pagedServer(60, 10));
    await act(() =>
      root.render(
        <Probe
          threadId="t"
          live={range(50, 60)}
          initial={{
            before: [],
            olderCursor: 'm50',
            island: { messages: range(10, 20), olderCursor: 'm10', newerCursor: 'm19' },
          }}
        />,
      ),
    );
    expect(pages.controls.gapAfter).toBe(10);
    await act(() => pages.controls.loadGap('down'));
    await settle();
    expect(pages.controls.gapAfter).toBe(20);
    await act(() => pages.controls.loadGap('up'));
    await settle();
    expect(ids(pages.older)).toEqual(ids(range(10, 30).concat(range(40, 50))));
    expect(pages.controls.gapAfter).toBe(20);
    // Adjacent but not yet known to be: one more load finds the island's end.
    await act(() => pages.controls.loadGap('up'));
    await settle();
    expect(pages.controls.gapAfter).toBe(20);
    await act(() => pages.controls.loadGap('up'));
    await settle();
    // Met: one segment, and the top continues from the island's start.
    expect(pages.controls.gapAfter).toBeNull();
    expect(ids(pages.older)).toEqual(ids(range(10, 50)));
    expect(pages.controls.hasOlder).toBe(true);
  });

  it('opens at a message that is not loaded, and reports a failed load', async () => {
    mocks.get.mockImplementation(pagedServer(60, 10));
    await act(() =>
      root.render(
        <Probe
          threadId="t"
          live={range(50, 60)}
          initial={{ before: [], olderCursor: 'm50', island: null }}
        />,
      ),
    );
    await act(() => pages.openAt('m5'));
    await settle();
    expect(ids(pages.older)).toEqual(ids(range(1, 11)));
    expect(pages.controls.gapAfter).toBe(10);

    mocks.get.mockRejectedValueOnce(new Error('offline'));
    await act(() => pages.controls.loadOlder());
    await settle();
    expect(pages.controls.error).toBe('Could not load more messages. Try again.');
    expect(ids(pages.older)).toEqual(ids(range(1, 11)));
  });
});
