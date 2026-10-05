import type { UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '~/lib/api-client';
import {
  getChatHistory,
  type HistoryIsland,
  type InitialChatHistory,
  joinIsland,
} from '~/lib/chat-history';

interface PagesState {
  /** Older messages joined to the live part, oldest first. */
  before: UIMessage[];
  /** The page before `before` (or the live part); null at the conversation's start. */
  olderCursor: string | null;
  /** A search result's window, apart from the rest by a gap; see HistoryIsland. */
  island: HistoryIsland | null;
}

export type HistoryLoad = 'older' | 'gap' | 'target';

/** What MessageList needs to offer earlier messages and the gap. */
export interface HistoryControls {
  /** More messages before the first one shown. */
  hasOlder: boolean;
  /** Messages are missing after the first `gapAfter` messages (an island), else null. */
  gapAfter: number | null;
  loading: HistoryLoad | null;
  error: string | null;
  /** Loads the page before the first message shown. */
  loadOlder: () => void;
  /**
   * Loads into the gap: `down` continues the island (the reader is above the
   * gap), `up` extends the messages below it (the reader is below).
   */
  loadGap: (direction: 'down' | 'up') => void;
  /** Polite announcement of the last load, for screen readers. */
  announcement: string;
}

const plural = (count: number) => `${count} ${count === 1 ? 'message' : 'messages'}`;

/**
 * The older part of a conversation, a page at a time (v0.11, item 21).
 *
 * The chat session holds only the live part (the latest page and everything
 * since); older pages are kept here, so neither the SDK's state nor the
 * transcript's send detection sees them. A conversation opened at a search
 * result far from its end has an island: the result's window, shown above a
 * gap that the reader fills from either side. When the island and the rest
 * meet, they are joined and the gap goes.
 *
 * A server before v0.11 answers a paging request with the whole
 * conversation; the messages before the loaded ones are then taken from it
 * and there is nothing more to load.
 */
export function useHistoryPages(options: {
  threadId: string;
  initial: Pick<InitialChatHistory, 'before' | 'olderCursor' | 'island'>;
  /** The chat session's messages: the live part. */
  live: UIMessage[];
}) {
  const { threadId } = options;
  const [state, setState] = useState<PagesState>(() => ({
    before: options.initial.before,
    olderCursor: options.initial.olderCursor,
    island: options.initial.island,
  }));
  const [loading, setLoading] = useState<HistoryLoad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const busy = useRef(false);
  const latest = useRef({ state, live: options.live });
  latest.current = { state, live: options.live };
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  /** Runs one load at a time; a failed load leaves everything as it was. */
  const run = useCallback(
    async (kind: HistoryLoad, work: (signal: AbortSignal) => Promise<string | null>) => {
      if (busy.current) return;
      busy.current = true;
      const controller = new AbortController();
      abort.current = controller;
      setLoading(kind);
      setError(null);
      try {
        const message = await work(controller.signal);
        if (message !== null) setAnnouncement(message);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(
          failure instanceof ApiError && failure.status === 422
            ? 'These messages changed. Reload the conversation to see them.'
            : 'Could not load more messages. Try again.',
        );
      } finally {
        busy.current = false;
        if (!controller.signal.aborted) setLoading(null);
      }
    },
    [],
  );

  /** The first message below the gap (or of everything when there is no island). */
  const segmentStart = useCallback(() => {
    const { state: current, live } = latest.current;
    return current.before[0] ?? live[0];
  }, []);

  /** A server before v0.11 sent everything: keep what precedes the loaded messages. */
  const fromWholeConversation = useCallback(
    (all: UIMessage[]) => {
      const first = segmentStart()?.id;
      const index = first === undefined ? -1 : all.findIndex((message) => message.id === first);
      const before = index >= 0 ? all.slice(0, index) : latest.current.state.before;
      setState({ before, olderCursor: null, island: null });
      return before.length;
    },
    [segmentStart],
  );

  const loadOlder = useCallback(() => {
    void run('older', async (signal) => {
      const { island, olderCursor } = latest.current.state;
      const cursor = island ? island.olderCursor : olderCursor;
      if (!cursor) return null;
      const page = await getChatHistory(threadId, signal, { before: cursor });
      if (signal.aborted) return null;
      if (!page.paged) {
        const count = fromWholeConversation(page.messages);
        return `Loaded ${plural(count)}. This is the start of the conversation.`;
      }
      setState((current) =>
        current.island
          ? {
              ...current,
              island: {
                ...current.island,
                messages: [...page.messages, ...current.island.messages],
                olderCursor: page.page.olderCursor,
              },
            }
          : {
              ...current,
              before: [...page.messages, ...current.before],
              olderCursor: page.page.olderCursor,
            },
      );
      return `Loaded ${plural(page.messages.length)} earlier in the conversation.${
        page.page.olderCursor ? '' : ' This is the start of the conversation.'
      }`;
    });
  }, [run, threadId, fromWholeConversation]);

  const loadGap = useCallback(
    (direction: 'down' | 'up') => {
      void run('gap', async (signal) => {
        const { island } = latest.current.state;
        if (!island) return null;
        const start = segmentStart();
        if (direction === 'down' && island.newerCursor) {
          const page = await getChatHistory(threadId, signal, { after: island.newerCursor });
          if (signal.aborted) return null;
          if (!page.paged) return `Loaded ${plural(fromWholeConversation(page.messages))}.`;
          const joined = joinIsland(
            [...island.messages, ...page.messages],
            { olderCursor: island.olderCursor, newerCursor: page.page.newerCursor },
            start ? [start] : [],
          );
          setState((current) =>
            current.island === island
              ? joined.island
                ? { ...current, island: joined.island }
                : { ...current, island: null, before: [...joined.before, ...current.before] }
              : current,
          );
          return `Loaded ${plural(page.messages.length)}.`;
        }
        if (!start) return null;
        const page = await getChatHistory(threadId, signal, { before: start.id });
        if (signal.aborted) return null;
        if (!page.paged) return `Loaded ${plural(fromWholeConversation(page.messages))}.`;
        const last = island.messages.at(-1)?.id;
        const meet = page.messages.findIndex((message) => message.id === last);
        setState((current) => {
          if (current.island !== island) return current;
          if (meet >= 0 || page.page.olderCursor === null)
            return {
              ...current,
              island: null,
              before: [
                ...island.messages,
                ...(meet >= 0
                  ? page.messages.slice(meet + 1)
                  : page.messages.filter((m) => !island.messages.some((i) => i.id === m.id))),
                ...current.before,
              ],
              olderCursor: island.olderCursor,
            };
          return { ...current, before: [...page.messages, ...current.before] };
        });
        return `Loaded ${plural(page.messages.length)}.`;
      });
    },
    [run, threadId, fromWholeConversation, segmentStart],
  );

  /**
   * Opens at a message that is not loaded (conversation search on the open
   * conversation): loads its window as the island, or joins it to the rest
   * when it reaches them. A message not in the conversation changes nothing.
   */
  const openAt = useCallback(
    (messageId: string) => {
      void run('target', async (signal) => {
        const page = await getChatHistory(threadId, signal, { around: messageId });
        if (signal.aborted) return null;
        if (!page.paged) {
          fromWholeConversation(page.messages);
          return null;
        }
        if (page.page.targetFound === false) return null;
        const start = segmentStart();
        const joined = joinIsland(page.messages, page.page, start ? [start] : []);
        setState((current) =>
          joined.island
            ? { ...current, island: joined.island }
            : {
                island: null,
                before: [...joined.before, ...current.before],
                olderCursor: page.page.olderCursor,
              },
        );
        return null;
      });
    },
    [run, threadId, fromWholeConversation, segmentStart],
  );

  const { before, island, olderCursor } = state;
  const older = useMemo(
    () => (island ? [...island.messages, ...before] : before),
    [island, before],
  );
  const hasOlder = Boolean(island ? island.olderCursor : olderCursor);
  const gapAfter = island ? island.messages.length : null;
  const controls = useMemo<HistoryControls>(
    () => ({ hasOlder, gapAfter, loading, error, loadOlder, loadGap, announcement }),
    [hasOlder, gapAfter, loading, error, loadOlder, loadGap, announcement],
  );
  return { older, controls, openAt };
}
