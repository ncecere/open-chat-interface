import type { ConversationCompaction } from '@oci/shared';
import type { UIMessage } from 'ai';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shownReply } from '~/components/artifacts/declined-artifacts';
import { capacityWaitOf } from '~/components/chat/capacity-wait';
import { CompactionDivider } from '~/components/chat/compaction-divider';
import { reasoningOf, textOf } from '~/components/chat/message-content';
import { MessageRow } from '~/components/chat/message-row';
import type { ReplySwitch } from '~/components/chat/reply-switcher';
import { replySearchOf, SearchLoading } from '~/components/chat/search-grounding';
import { type AnswerApproval, toolLimitOf, toolStepsOf } from '~/components/chat/tool-steps';
import type { HistoryControls } from '~/hooks/use-history-pages';
import { useWindowedRows } from '~/hooks/use-windowed-rows';

interface MessageListProps {
  messages: UIMessage[];
  /** The saved conversation, for exporting replies as files. */
  threadId?: string;
  streaming: boolean;
  onRetry: () => void;
  searching?: boolean;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onFork?: (messageId: string) => Promise<void>;
  /** Switching between the latest turn's replies; shown on the last reply only. */
  replySwitch?: ReplySwitch;
  /** Answers an approval on the latest reply. */
  onAnswerApproval?: AnswerApproval;
  /** When earlier messages were summarised: shown above the first kept message. */
  compaction?: ConversationCompaction | null;
  /** Stops the reply being written; offered while it waits for its model. */
  onStop?: () => void;
  /**
   * The conversation's scroller. With it, a very long transcript renders only
   * the rows near the view (v0.11); without it every row is rendered.
   */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Earlier pages of the conversation and the gap before an island (v0.11). */
  history?: HistoryControls;
  /** A message that must be rendered: the one opened from conversation search. */
  anchorId?: string;
}

type Item =
  | { kind: 'message'; message: UIMessage; index: number; key: string }
  | { kind: 'gap'; key: string };

const GAP_KEY = 'history-gap';
const estimates = new WeakMap<UIMessage, number>();

/**
 * A height for a row not rendered yet, from its text: lines of prose, code
 * blocks and diagrams. Only spacers use it, until the row is measured.
 */
function estimateMessage(message: UIMessage): number {
  const known = estimates.get(message);
  if (known !== undefined) return known;
  const text = textOf(message);
  const fences = (text.match(/^```/gm)?.length ?? 0) / 2;
  const lines = text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 90)), 0);
  const height =
    message.role === 'user'
      ? 96 + Math.min(lines, 20) * 24
      : 88 + lines * 26 + fences * 48 + (text.includes('```mermaid') ? 260 : 0);
  estimates.set(message, height);
  return height;
}

/** Transcript composition only; editing drafts and presentation belong to rows. */
export const MessageList = memo(function MessageList({
  messages,
  threadId,
  streaming,
  onRetry,
  onEdit,
  onFork,
  replySwitch,
  onAnswerApproval,
  compaction = null,
  searching = false,
  onStop,
  scrollRef,
  history,
  anchorId,
}: MessageListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const last = messages.at(-1);
  const lastIsAssistant = last?.role === 'assistant';
  const switchable = Boolean(replySwitch) && lastIsAssistant;
  const lastText = lastIsAssistant ? textOf(last) : '';
  const lastReasoning = lastIsAssistant ? reasoningOf(last) : '';
  // A tool step is visible progress too, for example "Searching the web…".
  // So is waiting for the model, which shows the turn's place.
  const hasVisibleContent = Boolean(
    lastText ||
      lastReasoning ||
      (lastIsAssistant &&
        // A declined artifact attempt is not progress anyone sees (#201).
        (toolStepsOf(shownReply(last)).length > 0 ||
          toolLimitOf(last) ||
          capacityWaitOf(last)?.state === 'waiting')),
  );
  const waitingLabel = lastReasoning ? 'Thinking' : 'Generating response';
  // Once the search's step is in the reply's block, the wait is for the model.
  const searched = lastIsAssistant && replySearchOf(last).presearch !== null;

  const gapAfter = history?.gapAfter ?? null;
  const items = useMemo<Item[]>(() => {
    const list: Item[] = messages.map((message, index) => ({
      kind: 'message',
      message,
      index,
      // Switching replies swaps the last message. Keying that row by its
      // prompt keeps it mounted, so focus stays on the switcher.
      key:
        switchable && index === messages.length - 1
          ? `replies-of-${messages[index - 1]?.id}`
          : message.id,
    }));
    if (gapAfter !== null) list.splice(gapAfter, 0, { kind: 'gap', key: GAP_KEY });
    return list;
  }, [messages, switchable, gapAfter]);
  const keys = useMemo(() => items.map((item) => item.key), [items]);
  const estimate = useCallback(
    (index: number) => {
      const item = items[index];
      return item?.kind === 'message' ? estimateMessage(item.message) : 120;
    },
    [items],
  );

  // The row holding keyboard focus stays rendered, so focus is never dropped.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rows = rowsRef.current;
    if (!rows) return;
    const focusIn = (event: FocusEvent) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row-key]');
      setFocusedKey(row?.dataset.rowKey ?? null);
    };
    const focusOut = (event: FocusEvent) => {
      if (!rows.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
    };
    rows.addEventListener('focusin', focusIn);
    rows.addEventListener('focusout', focusOut);
    return () => {
      rows.removeEventListener('focusin', focusIn);
      rows.removeEventListener('focusout', focusOut);
    };
  }, []);
  // The gap, too: its button is how the keyboard fills it.
  const forced = useMemo(
    () => [anchorId, focusedKey, gapAfter === null ? null : GAP_KEY],
    [anchorId, focusedKey, gapAfter],
  );
  const { plan, measure, windowed } = useWindowedRows({
    keys,
    estimate,
    scrollRef,
    rowsRef,
    forced,
  });

  const renderItem = (item: Item) => {
    if (item.kind === 'gap')
      return history ? <HistoryGap history={history} scrollRef={scrollRef} /> : null;
    const { message, index } = item;
    return (
      <>
        {compaction?.firstKeptMessageId === message.id && (
          <div className="mb-6">
            <CompactionDivider key={`compaction-${compaction.id}`} compaction={compaction} />
          </div>
        )}
        <MessageRow
          message={message}
          threadId={threadId}
          // Only the active assistant streams; user actions stay disabled
          // throughout generation. Historical assistants need no token updates.
          streaming={streaming && (message.role === 'user' || index === messages.length - 1)}
          editing={editingId === message.id}
          onEditingChange={setEditingId}
          onRetry={index === messages.length - 1 ? onRetry : undefined}
          replySwitch={switchable && index === messages.length - 1 ? replySwitch : undefined}
          onAnswerApproval={index === messages.length - 1 ? onAnswerApproval : undefined}
          onStop={index === messages.length - 1 ? onStop : undefined}
          onFork={onFork}
          onEdit={onEdit}
        />
      </>
    );
  };

  // The shell keeps the top bar's floating controls clear of the scroller (#166).
  // Each row carries the space below it, so a row's measured height includes it.
  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col px-4 pb-2 pt-4">
      {history && <EarlierMessages history={history} scrollRef={scrollRef} />}
      <div
        ref={rowsRef}
        data-message-rows=""
        data-windowed={windowed ? '' : undefined}
        aria-busy={history?.loading ? true : undefined}
      >
        {plan.map((entry) => {
          if (entry.type === 'spacer')
            return (
              <div
                key={entry.key}
                aria-hidden="true"
                data-row-spacer=""
                style={{ height: entry.height }}
              />
            );
          const item = items[entry.index]!;
          return (
            <div key={item.key} data-row-key={item.key} ref={measure} className="pb-6">
              {renderItem(item)}
            </div>
          );
        })}
      </div>

      {/* An empty assistant row is not visible progress. Keep feedback until
          text or reasoning arrives, including providers with hidden reasoning. */}
      {streaming && !hasVisibleContent && (
        <div className="pb-6">
          {searching && !searched ? (
            <SearchLoading />
          ) : (
            <div role="status" className="flex gap-1.5 py-2" aria-label={waitingLabel}>
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="size-1.5 animate-bounce rounded-full bg-[var(--text-muted)]"
                  style={{ animationDelay: `${dot * 0.15}s` }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** Calls `onVisible` while `element` is within a view's height of the scroller's view. */
function useNearView(
  element: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null> | undefined,
  onVisible: (entry: IntersectionObserverEntry) => void,
  active: boolean,
) {
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const target = element.current;
    const root = scrollRef?.current;
    if (!active || !target || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) callback.current(entry);
      },
      { root, rootMargin: '100% 0px 100% 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, scrollRef, active]);
}

/**
 * Above the first message shown, while there are earlier ones: a button
 * (for keyboard and screen-reader users), which also loads by itself as the
 * reader scrolls near it. Loads are announced politely.
 */
function EarlierMessages({
  history,
  scrollRef,
}: {
  history: HistoryControls;
  scrollRef?: RefObject<HTMLElement | null>;
}) {
  const { hasOlder, loading, error, loadOlder, announcement } = history;
  const button = useRef<HTMLButtonElement>(null);
  const start = useRef<HTMLParagraphElement>(null);
  const [loadedAny, setLoadedAny] = useState(false);
  const load = useCallback(() => {
    setLoadedAny(true);
    loadOlder();
  }, [loadOlder]);
  // Re-observed after each load, so a control still in view loads again.
  useNearView(button, scrollRef, load, hasOlder && loading === null && !error);
  // The button goes at the start of the conversation: keep focus nearby.
  const hadFocus = useRef(false);
  useEffect(() => {
    if (!hasOlder && hadFocus.current) start.current?.focus();
  }, [hasOlder]);

  if (!hasOlder && !loadedAny && !announcement) return null;
  return (
    <div className="flex flex-col items-center gap-2 pb-6 text-sm text-[var(--text-muted)]">
      {hasOlder ? (
        <button
          ref={button}
          type="button"
          onClick={load}
          onFocus={() => {
            hadFocus.current = true;
          }}
          onBlur={() => {
            hadFocus.current = false;
          }}
          aria-disabled={loading === 'older' ? true : undefined}
          className="rounded-full border border-[var(--border-subtle)] px-3 py-1.5 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {loading === 'older' ? 'Loading earlier messages…' : 'Load earlier messages'}
        </button>
      ) : (
        <p ref={start} tabIndex={-1} className="outline-none">
          This is the start of the conversation.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

/**
 * Between a search result's window and the rest of the conversation: the
 * messages not loaded yet. Loads by itself from whichever side the reader
 * approaches; the button continues after the window.
 */
function HistoryGap({
  history,
  scrollRef,
}: {
  history: HistoryControls;
  scrollRef?: RefObject<HTMLElement | null>;
}) {
  const { loading, loadGap } = history;
  const element = useRef<HTMLDivElement>(null);
  useNearView(
    element,
    scrollRef,
    (entry) => {
      const root = entry.rootBounds;
      const box = entry.boundingClientRect;
      // Above the middle of the view: the reader came from below.
      const fromBelow = root ? box.top + box.height / 2 < root.top + root.height / 2 : false;
      loadGap(fromBelow ? 'up' : 'down');
    },
    loading === null,
  );
  return (
    <div
      ref={element}
      data-history-gap=""
      className="flex items-center gap-3 py-2 text-sm text-[var(--text-muted)]"
    >
      <span className="sr-only">Some messages here are not loaded yet.</span>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
      <button
        type="button"
        onClick={() => loadGap('down')}
        aria-disabled={loading === 'gap' ? true : undefined}
        className="rounded-full border border-[var(--border-subtle)] px-3 py-1.5 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        {loading === 'gap' ? 'Loading messages…' : 'Load more messages'}
      </button>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  );
}
