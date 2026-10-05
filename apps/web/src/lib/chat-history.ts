import {
  CHAT_HISTORY_MAX_PAGE_SIZE,
  CHAT_HISTORY_PAGE_SIZE,
  type ChatHistoryPage,
  type ThreadSummary,
} from '@oci/shared';
import type { UIMessage } from 'ai';
import { api } from './api-client';

export interface ChatHistory {
  /**
   * The conversation's summary. Since v0.9.1 the server sends all of it;
   * only the first three fields are relied on for the conversation itself.
   */
  thread: Pick<ThreadSummary, 'id' | 'temporary' | 'expiresAt'> & Partial<ThreadSummary>;
  /** The conversation as it reads: one active reply per turn (since v0.11, one page of it). */
  messages: UIMessage[];
  /**
   * Every reply to the latest turn, oldest first, when it was retried; empty
   * otherwise. The active one is also the last entry of `messages`.
   */
  replies: UIMessage[];
  /**
   * Where `messages` sits in the conversation (v0.11). A server before v0.11
   * answers with the whole conversation and no page; it is then described as
   * a single page with nothing before or after it.
   */
  page: ChatHistoryPage;
  /** Whether the server answered in pages; false for a server before v0.11. */
  paged: boolean;
}

/**
 * A window of an older part of the conversation, shown above a gap that
 * separates it from the latest messages (v0.11): opening a conversation at a
 * search result far from its end loads the result's surroundings and the
 * latest messages, and the reader loads the messages between on demand.
 */
export interface HistoryIsland {
  messages: UIMessage[];
  olderCursor: string | null;
  newerCursor: string | null;
}

/**
 * What a conversation opens with: the latest page (`messages`, the live part
 * the chat session holds), older messages already joined to it (`before`,
 * from a search result's window that met the latest page), the cursor for
 * the page before those, and a search result's window when it did not meet
 * the latest page.
 */
export type InitialChatHistory = ChatHistory & {
  before: UIMessage[];
  olderCursor: string | null;
  island: HistoryIsland | null;
};

export interface HistoryRequest {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
}

const invalidMessages = (messages: unknown) =>
  !Array.isArray(messages) ||
  messages.some(
    (message: UIMessage) =>
      !message ||
      typeof message.id !== 'string' ||
      !['user', 'assistant', 'system'].includes(message.role) ||
      !Array.isArray(message.parts) ||
      message.parts.some((part) => !part || typeof part.type !== 'string'),
  );

const validCursor = (value: unknown) => value === null || typeof value === 'string';
const validPage = (page: unknown): page is ChatHistoryPage => {
  const candidate = page as Partial<ChatHistoryPage> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    validCursor(candidate.olderCursor) &&
    validCursor(candidate.newerCursor) &&
    typeof candidate.total === 'number'
  );
};

/**
 * A conversation's history: all of it without `request` (share dialogs and
 * anything else that needs the whole conversation), else one page. A server
 * before v0.11 ignores the paging parameters and sends everything, which is
 * reported with `paged: false`.
 */
export async function getChatHistory(
  threadId: string,
  signal?: AbortSignal,
  request?: HistoryRequest,
): Promise<ChatHistory> {
  const query = new URLSearchParams();
  if (request) {
    query.set('limit', String(request.limit ?? CHAT_HISTORY_PAGE_SIZE));
    for (const key of ['before', 'after', 'around'] as const) {
      const value = request[key];
      if (value) query.set(key, value);
    }
  }
  const suffix = request ? `?${query}` : '';
  const data = await api.get<
    Omit<ChatHistory, 'replies' | 'page' | 'paged'> & { replies?: UIMessage[]; page?: unknown }
  >(`/chat/${encodeURIComponent(threadId)}/messages${suffix}`, { signal });
  if (
    !data?.thread ||
    data.thread.id !== threadId ||
    typeof data.thread.temporary !== 'boolean' ||
    invalidMessages(data.messages) ||
    (data.replies !== undefined && invalidMessages(data.replies)) ||
    (data.page !== undefined && !validPage(data.page))
  )
    throw new Error('Invalid conversation response');
  const paged = data.page !== undefined;
  return {
    thread: data.thread,
    messages: data.messages,
    replies: data.replies ?? [],
    page: paged
      ? (data.page as ChatHistoryPage)
      : { olderCursor: null, newerCursor: null, total: data.messages.length },
    paged,
  };
}

/**
 * What a conversation opens with: its latest page, or, opened at a message
 * (conversation search), the page around that message and, when the two do
 * not meet, the latest page as well, with the message's window kept apart as
 * an island above a gap.
 */
export async function getInitialHistory(
  threadId: string,
  signal?: AbortSignal,
  target?: string,
): Promise<InitialChatHistory> {
  const single = (history: ChatHistory): InitialChatHistory => ({
    ...history,
    before: [],
    olderCursor: history.page.olderCursor,
    island: null,
  });
  if (!target) return single(await getChatHistory(threadId, signal, {}));
  const around = await getChatHistory(threadId, signal, { around: target });
  // The window reaches the end (or the server sent everything): one segment.
  if (!around.paged || around.page.newerCursor === null || around.page.targetFound === false)
    return single(around);
  const latest = await getChatHistory(threadId, signal, {});
  const joined = joinIsland(around.messages, around.page, latest.messages);
  return {
    ...latest,
    ...joined,
    olderCursor: joined.island ? latest.page.olderCursor : around.page.olderCursor,
  };
}

/**
 * An island and the segment after it, joined when they meet or overlap:
 * `island` is null and `before` holds the island's messages that precede the
 * segment's first one. Otherwise the island stays apart.
 */
export function joinIsland(
  islandMessages: UIMessage[],
  islandPage: Pick<ChatHistoryPage, 'olderCursor' | 'newerCursor'>,
  segment: UIMessage[],
): { island: HistoryIsland | null; before: UIMessage[] } {
  const first = segment[0]?.id;
  const meet = first === undefined ? -1 : islandMessages.findIndex((m) => m.id === first);
  if (meet >= 0) return { island: null, before: islandMessages.slice(0, meet) };
  if (islandPage.newerCursor === null && first !== undefined)
    // The island reaches the end, yet does not hold the segment's first message
    // (re-identified since): nothing lies between them.
    return {
      island: null,
      before: islandMessages.filter((m) => !segment.some((s) => s.id === m.id)),
    };
  return {
    island: {
      messages: islandMessages,
      olderCursor: islandPage.olderCursor,
      newerCursor: islandPage.newerCursor,
    },
    before: [],
  };
}

/**
 * How many messages a refresh of the latest page asks for: enough to reach
 * back past the first message the reader's live part of the conversation
 * holds, so the refreshed page can be joined to what is already loaded.
 */
export function refreshLimit(loaded: number): number {
  return Math.min(CHAT_HISTORY_MAX_PAGE_SIZE, Math.max(CHAT_HISTORY_PAGE_SIZE, loaded + 20));
}

/**
 * The live part of a conversation after a refresh: the refreshed latest page
 * from the first message `current` holds on (older pages are kept apart and
 * must not be repeated), or `current`'s start followed by the page when the
 * page does not reach back that far. Without a common message, the page.
 */
export function mergeLatest(current: UIMessage[], latest: UIMessage[]): UIMessage[] {
  const first = current[0]?.id;
  const from = first === undefined ? -1 : latest.findIndex((message) => message.id === first);
  if (from >= 0) return from === 0 ? latest : latest.slice(from);
  const start = latest[0]?.id;
  const join = start === undefined ? -1 : current.findIndex((message) => message.id === start);
  if (join > 0) return [...current.slice(0, join), ...latest];
  return latest;
}

/** Persists which reply to the latest turn is active. */
export async function activateReply(threadId: string, messageId: string) {
  await api.patch<{ activeMessageId: string }>(
    `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/active`,
    {},
  );
}
export function messageStatus(message: UIMessage): string | undefined {
  const metadata = message.metadata as { status?: unknown } | undefined;
  return typeof metadata?.status === 'string' ? metadata.status : undefined;
}
export function hasPendingReply(messages: UIMessage[]) {
  return messages.some(
    (message) => message.role === 'assistant' && messageStatus(message) === 'streaming',
  );
}
