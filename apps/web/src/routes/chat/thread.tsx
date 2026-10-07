import { type Attachment, REASONING_EFFORTS, type ReasoningEffort } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { UIMessage } from 'ai';
import { ArrowDown, Clock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ThreadArtifactsProvider } from '~/components/artifacts/artifacts-provider';
import { CompactionFailureNotice } from '~/components/chat/compaction-failure-notice';
import { Composer } from '~/components/chat/composer';
import { ConversationLoadError } from '~/components/chat/conversation-load-error';
import { MessageList } from '~/components/chat/message-list';
import { FullPageSpinner } from '~/components/ui/spinner';
import { type ChatScrollTarget, useChatScroll } from '~/hooks/use-chat-scroll';
import { useChatSession } from '~/hooks/use-chat-session';
import { useCompaction } from '~/hooks/use-compaction';
import { useHistoryPages } from '~/hooks/use-history-pages';
import { useOpenConversation } from '~/hooks/use-open-conversation';
import { useReplySwitcher } from '~/hooks/use-reply-switcher';
import { useBranchMessage, useForkMessage } from '~/hooks/use-threads';
import { useRemoveUnusedConversation } from '~/hooks/use-unused-conversation';
import { ApiError, chatErrorText } from '~/lib/api-client';
import { getInitialHistory, type HistoryIsland } from '~/lib/chat-history';
import { usePageTitle } from '~/lib/document-title';
import { conversationChoice } from '~/lib/starting-model';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

const PENDING_KEY = 'oci.pendingPrompt';
const PENDING_THREAD_KEY = 'oci.pendingThreadId';
const PENDING_ATTACHMENTS_KEY = 'oci.pendingAttachments';
const PENDING_EFFORT_KEY = 'oci.pendingEffort';
const PENDING_SEARCH_KEY = 'oci.pendingWebSearch';
const PENDING_FOCUS_KEY = 'oci.pendingComposerFocus';
const PENDING_BRANCH_KEY = 'oci.pendingBranchResponse';
/** The model picked on the home page for this new conversation (v0.10). */
const PENDING_MODEL_KEY = 'oci.pendingModel';

interface PendingBranchResponse {
  threadId: string;
  messageId: string;
  modelSlug: string | null;
  /** Absent when the branched message recorded none; the default level applies. */
  effort?: ReasoningEffort;
}

function peekPendingBranch(threadId: string): PendingBranchResponse | null {
  const raw = sessionStorage.getItem(PENDING_BRANCH_KEY);
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<PendingBranchResponse>;
    if (
      value.threadId !== threadId ||
      typeof value.messageId !== 'string' ||
      (value.modelSlug !== null && typeof value.modelSlug !== 'string') ||
      (value.effort !== undefined && !REASONING_EFFORTS.includes(value.effort))
    ) {
      return null;
    }
    return value as PendingBranchResponse;
  } catch {
    return null;
  }
}

function peekPendingEffort(): ReasoningEffort | undefined {
  const value = sessionStorage.getItem(PENDING_EFFORT_KEY);
  return REASONING_EFFORTS.find((effort) => effort === value);
}

function peekPendingModel(): string | null {
  return sessionStorage.getItem(PENDING_MODEL_KEY) || null;
}

function peekPendingSearch(): boolean {
  return sessionStorage.getItem(PENDING_SEARCH_KEY) === 'true';
}

/** Reads uploads handed over by the landing page without mutating during render. */
function peekPendingAttachments(): Attachment[] {
  const raw = sessionStorage.getItem(PENDING_ATTACHMENTS_KEY);
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (value): value is Attachment =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Partial<Attachment>).id === 'string' &&
        typeof (value as Partial<Attachment>).filename === 'string' &&
        typeof (value as Partial<Attachment>).mimeType === 'string' &&
        typeof (value as Partial<Attachment>).url === 'string',
    );
  } catch {
    return [];
  }
}

function ThreadConversation({
  threadId,
  initialMessages,
  initialReplies,
  initialBefore,
  initialOlderCursor,
  initialIsland,
  loadedTarget,
  carriedAttachments,
  carriedModel,
  carriedEffort,
  carriedSearch,
  carriedFocus,
  temporary,
  projectId,
  target,
}: {
  threadId: string;
  /** The conversation's project, if any, for the composer's Project files control. */
  projectId: string | null;
  initialMessages: UIMessage[];
  /** Every reply to the latest turn when it was retried; otherwise empty. */
  initialReplies: UIMessage[];
  /** Older messages already loaded with the latest page, oldest first (v0.11). */
  initialBefore: UIMessage[];
  /** The page before the loaded messages; null at the conversation's start. */
  initialOlderCursor: string | null;
  /** A search result's window apart from the latest messages, if any. */
  initialIsland: HistoryIsland | null;
  /** The message the history was loaded around, if any. */
  loadedTarget?: string;
  carriedAttachments: Attachment[];
  /** The model picked on the home page for this conversation. */
  carriedModel: string | null;
  carriedEffort?: ReasoningEffort;
  carriedSearch: boolean;
  /** The person was typing on the home page: keep the cursor in the composer. */
  carriedFocus: boolean;
  temporary: boolean;
  target?: ChatScrollTarget;
}) {
  const pendingBranch = peekPendingBranch(threadId);
  // An explicit choice in this conversation comes first: a branch's or the home
  // page's, else what it last used. Without one, the person's default applies.
  const [recorded] = useState(() => conversationChoice(initialMessages));
  const session = useChatSession({
    threadId,
    initialMessages,
    carriedAttachments,
    initialModelSlug: pendingBranch?.modelSlug ?? carriedModel ?? recorded.modelSlug,
    initialEffort: pendingBranch?.effort ?? carriedEffort ?? recorded.effort,
    initialWebSearch: carriedSearch,
    temporary,
  });
  const { send, stop, regenerate, selectedModel } = session;
  // Its first message refused and nothing saved: not left in the history as
  // an empty "New Chat" once the person leaves (#234).
  useRemoveUnusedConversation(threadId, session.refused && session.messages.length === 0);
  const selectedModelSlug = selectedModel?.slug;
  const navigate = useNavigate();
  const { mutateAsync: branchMessage } = useBranchMessage();
  const { mutateAsync: forkMessage } = useForkMessage();
  const sentPending = useRef(false);
  const continuedBranch = useRef(false);
  const pendingModelAvailable = pendingBranch?.modelSlug
    ? session.models.some((model) => model.slug === pendingBranch.modelSlug)
    : false;

  // A prompt handed over from the landing page is sent once the thread mounts.
  useEffect(() => {
    if (sentPending.current || session.streaming || session.recovery.unavailable) return;
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (sessionStorage.getItem(PENDING_THREAD_KEY) !== threadId || !pending || !selectedModel)
      return;

    sentPending.current = true;
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_ATTACHMENTS_KEY);
    sessionStorage.removeItem(PENDING_EFFORT_KEY);
    sessionStorage.removeItem(PENDING_MODEL_KEY);
    sessionStorage.removeItem(PENDING_SEARCH_KEY);
    sessionStorage.removeItem(PENDING_THREAD_KEY);
    void send(pending);
  }, [threadId, selectedModel, send, session.streaming, session.recovery.unavailable]);

  // The branch API has already stored the edited user turn. Regenerate from
  // that exact row so Save & submit cannot append a duplicate user message.
  useEffect(() => {
    if (
      continuedBranch.current ||
      session.streaming ||
      session.recovery.unavailable ||
      !pendingBranch ||
      !selectedModel ||
      (pendingBranch.modelSlug &&
        pendingModelAvailable &&
        selectedModel.slug !== pendingBranch.modelSlug)
    ) {
      return;
    }

    continuedBranch.current = true;
    sessionStorage.removeItem(PENDING_BRANCH_KEY);
    void regenerate({ messageId: pendingBranch.messageId });
  }, [
    pendingBranch,
    pendingModelAvailable,
    regenerate,
    selectedModel,
    session.streaming,
    session.recovery.unavailable,
  ]);

  const replies = useReplySwitcher({
    threadId,
    initialMessages,
    initialReplies,
    messages: session.messages,
    setMessages: session.setMessages,
    streaming: session.streaming,
  });
  const { remember: rememberReply, settled: replySettled } = replies;
  // A switch being saved must land before a reply is generated from context.
  const retry = useCallback(async () => {
    await replySettled();
    rememberReply();
    await regenerate();
  }, [regenerate, rememberReply, replySettled]);
  const submit = useCallback(async () => {
    await replySettled();
    await send();
  }, [send, replySettled]);

  /** The new conversation answers its last question once it opens. */
  const answerInBranch = useCallback(
    (
      branchId: string,
      message: { id: string; modelSlug: string | null; effort: ReasoningEffort | null },
    ) => {
      sessionStorage.setItem(
        PENDING_BRANCH_KEY,
        JSON.stringify({
          threadId: branchId,
          messageId: message.id,
          modelSlug: message.modelSlug ?? selectedModelSlug ?? null,
          // Without a recorded level the new thread starts at the instance default.
          effort: message.effort ?? undefined,
        } satisfies PendingBranchResponse),
      );
    },
    [selectedModelSlug],
  );

  const forkAtMessage = useCallback(
    async (messageId: string) => {
      const result = await forkMessage({ threadId, messageId });
      // A fork made at a question would end unanswered, with no Retry: it is
      // answered, as an edit is (#213).
      if (result.message?.role === 'user') answerInBranch(result.thread.id, result.message);
      await navigate({ to: '/chat/$threadId', params: { threadId: result.thread.id } });
    },
    [forkMessage, threadId, navigate, answerInBranch],
  );

  const editAndBranch = useCallback(
    async (messageId: string, text: string) => {
      const result = await branchMessage({ threadId, messageId, text });
      answerInBranch(result.thread.id, result.message);
      await navigate({ to: '/chat/$threadId', params: { threadId: result.thread.id } });
    },
    [branchMessage, threadId, navigate, answerInBranch],
  );

  // Earlier pages, kept apart from the chat session's live part (v0.11).
  const history = useHistoryPages({
    threadId,
    initial: { before: initialBefore, olderCursor: initialOlderCursor, island: initialIsland },
    live: session.messages,
  });
  const { older, openAt } = history;
  const transcript = useMemo(
    () => (older.length ? [...older, ...session.messages] : session.messages),
    [older, session.messages],
  );
  const targetId = target?.messageId;
  const targetLoaded = !targetId || transcript.some((message) => message.id === targetId);
  // A search result on the open conversation that is not loaded: load around it, once.
  const requestedTarget = useRef(
    loadedTarget && target ? `${target.messageId} ${target.key}` : null,
  );
  useEffect(() => {
    if (!target || targetLoaded) return;
    const key = `${target.messageId} ${target.key}`;
    if (requestedTarget.current === key) return;
    requestedTarget.current = key;
    openAt(target.messageId);
  }, [target, targetLoaded, openAt]);

  const scroll = useChatScroll(session.messages, session.streaming, target, targetLoaded);

  // A reply may have summarised earlier messages to fit the model; read the
  // summary in use again whenever one finishes.
  const compaction = useCompaction(threadId);
  const { refetch: refetchCompaction } = compaction;
  const wasStreaming = useRef(session.streaming);
  useEffect(() => {
    if (wasStreaming.current && !session.streaming) void refetchCompaction();
    wasStreaming.current = session.streaming;
  }, [refetchCompaction, session.streaming]);

  const conversationTitle = useOpenConversation(threadId)?.thread.title;
  const pageName = temporary ? 'Temporary chat' : conversationTitle || 'Conversation';
  // Unavailable: the page says so, and its heading names the tab (#197).
  usePageTitle(session.recovery.unavailable ? null : pageName);

  if (session.recovery.unavailable)
    return (
      <ConversationLoadError
        unavailable
        retry={session.recovery.recover}
        retrying={session.recovery.refreshing}
      />
    );

  // The fallback for a reply this page cannot follow: only once replay has
  // ended (or never started) and the server still has it pending. While the
  // replay is connected, the reply itself is on screen (#90).
  const waitingOnServer =
    session.recovery.remotePending &&
    !session.recovery.resuming &&
    session.status !== 'streaming' &&
    session.status !== 'submitted';

  return (
    <ThreadArtifactsProvider
      threadId={threadId}
      messages={transcript}
      streaming={session.streaming}
      canEdit={session.features?.artifacts ?? false}
    >
      {/* The conversation's name, for the tab and as the page's heading (#110). */}
      <h1 className="sr-only">{pageName}</h1>
      <div className="flex h-full flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scroll.scrollRef}
            onScroll={scroll.onScroll}
            data-conversation-scroller
            // The containing block for anything positioned inside messages (such as
            // screen-reader-only text), so nothing escapes the scroller and scrolls the page.
            className="relative flex-1 overflow-y-auto"
          >
            <div ref={scroll.contentRef}>
              <MessageList
                messages={transcript}
                threadId={threadId}
                scrollRef={scroll.scrollRef}
                history={history.controls}
                anchorId={targetId}
                streaming={session.streaming}
                // With tool calling the model decides whether to search, and its
                // search shows as a tool step instead.
                searching={
                  session.webSearch && !session.selectedModel?.capabilities.includes('tool_calling')
                }
                onAnswerApproval={session.answerApproval}
                onStop={stop}
                onRetry={retry}
                onFork={session.features?.branching ? forkAtMessage : undefined}
                onEdit={session.features?.branching ? editAndBranch : undefined}
                replySwitch={replies.switcher}
                compaction={compaction.data}
              />
              <CompactionFailureNotice threadId={threadId} />

              {(session.error || session.recovery.error || waitingOnServer || replies.error) && (
                <div className="mx-auto max-w-[42rem] space-y-2 px-4 pb-4">
                  {(session.recovery.error || session.error || replies.error) && (
                    <p
                      role="alert"
                      className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
                    >
                      {session.recovery.error ||
                        (session.error && chatErrorText(session.error)) ||
                        replies.error ||
                        'Something went wrong generating a response.'}
                    </p>
                  )}
                  {waitingOnServer && (
                    <p role="status" className="text-sm text-[var(--text-muted)]">
                      {/* Just after Stop, the server is still saving the stopped
                          reply: say that, not that one is pending (#154). */}
                      {session.recovery.stopping
                        ? 'Stopping the reply\u2026'
                        : 'A reply is pending on the server. You can stop it or wait for saved messages.'}
                    </p>
                  )}
                  {/* Nothing was saved from a refused message: no saved
                      messages to reload, unless a reply is pending (#234). */}
                  {!session.recovery.stopping && (!session.refused || waitingOnServer) && (
                    <button
                      type="button"
                      className="text-sm underline"
                      disabled={
                        session.recovery.refreshing ||
                        session.recovery.resuming ||
                        session.status === 'streaming' ||
                        session.status === 'submitted'
                      }
                      onClick={session.recovery.recover}
                    >
                      Reload saved messages
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* Room below a just-sent question so it can sit at the top of the view. */}
            <div ref={scroll.spacerRef} aria-hidden="true" />
          </div>
          {scroll.detached && (
            <button
              type="button"
              onClick={scroll.jumpToLatest}
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-sm text-[var(--text-secondary)] shadow-sm transition-colors hover:text-[var(--text-primary)]"
            >
              <ArrowDown className="size-4" aria-hidden="true" />
              Jump to latest
            </button>
          )}
        </div>

        {/* Kept on screen for the whole conversation: once the first message
            was sent, the home page's "Temporary chat" heading was gone and
            only the highlighted clock said so. */}
        {temporary && (
          <p className="flex items-center justify-center gap-1.5 px-4 pb-1.5 text-[var(--text-muted)] text-xs">
            <Clock className="size-3.5 text-[var(--accent-bright)]" aria-hidden="true" />
            Temporary chat: kept out of history and deleted 24 hours after it started.
          </p>
        )}
        <Composer
          autoFocus={carriedFocus}
          value={session.draft}
          onChange={session.setDraft}
          onSubmit={submit}
          onStop={stop}
          streaming={session.streaming}
          models={session.models}
          selectedModel={session.selectedModel}
          onSelectModel={session.selectModel}
          effort={session.effort}
          onEffortChange={session.setEffort}
          webSearch={session.webSearch}
          onWebSearchChange={session.setWebSearch}
          webSearchAvailable={session.features?.webSearch ?? false}
          attachmentsAvailable={session.features ? session.features.attachments : true}
          loading={session.optionsLoading}
          attachments={session.attachments.items}
          onAttachFiles={session.attachments.upload}
          onRemoveAttachment={session.attachments.remove}
          projectId={projectId}
          excludedProjectFileIds={session.excludedProjectFileIds}
          onExcludedProjectFilesChange={session.setExcludedProjectFileIds}
        />
      </div>
    </ThreadArtifactsProvider>
  );
}

export function ChatThreadPage({
  threadId,
  target,
}: {
  threadId: string;
  /** A message to open at, from conversation search; otherwise the end. */
  target?: ChatScrollTarget;
}) {
  // Query, recovery, and handover state all belong to this conversation.
  return <ThreadLoader key={threadId} threadId={threadId} target={target} />;
}

function ThreadLoader({ threadId, target }: { threadId: string; target?: ChatScrollTarget }) {
  // The message the conversation opens at; later search results load on demand.
  const [initialTarget] = useState(() => target?.messageId);
  // Read once on mount so a re-render cannot lose the handover.
  const [carriedAttachments] = useState(() =>
    sessionStorage.getItem(PENDING_THREAD_KEY) === threadId ? peekPendingAttachments() : [],
  );
  const [carriedModel] = useState(() =>
    sessionStorage.getItem(PENDING_THREAD_KEY) === threadId ? peekPendingModel() : null,
  );
  const [carriedEffort] = useState(() =>
    sessionStorage.getItem(PENDING_THREAD_KEY) === threadId ? peekPendingEffort() : undefined,
  );
  const [carriedSearch] = useState(
    () => sessionStorage.getItem(PENDING_THREAD_KEY) === threadId && peekPendingSearch(),
  );
  const [carriedFocus] = useState(() => {
    const carried =
      sessionStorage.getItem(PENDING_THREAD_KEY) === threadId &&
      sessionStorage.getItem(PENDING_FOCUS_KEY) === 'true';
    sessionStorage.removeItem(PENDING_FOCUS_KEY);
    return carried;
  });
  const { setTemporary } = useTemporaryChat();

  const { data, isLoading, isError, error, isFetching, fetchStatus, refetch } = useQuery({
    queryKey: ['thread', threadId, 'messages'],
    queryFn: ({ signal }) => getInitialHistory(threadId, signal, initialTarget),
    retry: (failures, failure) =>
      !(failure instanceof ApiError && failure.status >= 400 && failure.status < 500) &&
      failures < 2,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  useEffect(() => {
    if (data && !isError) setTemporary(data.thread.temporary);
  }, [data, isError, setTemporary]);

  if (isError || error || fetchStatus === 'paused' || (!isLoading && !data)) {
    return (
      <ConversationLoadError
        unavailable={error instanceof ApiError && [401, 403, 404].includes(error.status)}
        retry={() => {
          void refetch();
        }}
        retrying={isFetching}
      />
    );
  }
  if (isLoading || !data)
    return (
      <div role="status" aria-label="Loading conversation" className="h-full">
        <FullPageSpinner />
      </div>
    );

  // Remount when the thread changes so useChat starts from the right history.
  return (
    <ThreadConversation
      key={threadId}
      threadId={threadId}
      initialMessages={data.messages}
      initialReplies={data.replies}
      initialBefore={data.before ?? []}
      initialOlderCursor={data.olderCursor ?? null}
      initialIsland={data.island ?? null}
      loadedTarget={initialTarget}
      carriedAttachments={carriedAttachments}
      carriedModel={carriedModel}
      carriedEffort={carriedEffort}
      carriedSearch={carriedSearch}
      carriedFocus={carriedFocus}
      temporary={data.thread.temporary}
      projectId={data.thread.projectId ?? null}
      target={target}
    />
  );
}
