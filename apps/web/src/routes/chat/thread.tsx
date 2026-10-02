import { type Attachment, REASONING_EFFORTS, type ReasoningEffort } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { UIMessage } from 'ai';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from '~/components/chat/composer';
import { ConversationLoadError } from '~/components/chat/conversation-load-error';
import { MessageList } from '~/components/chat/message-list';
import { FullPageSpinner } from '~/components/ui/spinner';
import { type ChatScrollTarget, useChatScroll } from '~/hooks/use-chat-scroll';
import { useChatSession } from '~/hooks/use-chat-session';
import { useReplySwitcher } from '~/hooks/use-reply-switcher';
import { useBranchMessage, useForkMessage } from '~/hooks/use-threads';
import { ApiError, chatErrorText } from '~/lib/api-client';
import { getChatHistory } from '~/lib/chat-history';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

const PENDING_KEY = 'oci.pendingPrompt';
const PENDING_THREAD_KEY = 'oci.pendingThreadId';
const PENDING_ATTACHMENTS_KEY = 'oci.pendingAttachments';
const PENDING_EFFORT_KEY = 'oci.pendingEffort';
const PENDING_SEARCH_KEY = 'oci.pendingWebSearch';
const PENDING_BRANCH_KEY = 'oci.pendingBranchResponse';
const MODEL_STORAGE_KEY = 'oci.model';

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
  carriedAttachments,
  carriedEffort,
  carriedSearch,
  temporary,
  target,
}: {
  threadId: string;
  initialMessages: UIMessage[];
  /** Every reply to the latest turn when it was retried; otherwise empty. */
  initialReplies: UIMessage[];
  carriedAttachments: Attachment[];
  carriedEffort?: ReasoningEffort;
  carriedSearch: boolean;
  temporary: boolean;
  target?: ChatScrollTarget;
}) {
  const pendingBranch = peekPendingBranch(threadId);
  const session = useChatSession({
    threadId,
    initialMessages,
    carriedAttachments,
    initialModelSlug: pendingBranch?.modelSlug,
    initialEffort: pendingBranch?.effort ?? carriedEffort,
    initialWebSearch: carriedSearch,
    temporary,
  });
  const { send, stop, regenerate, selectedModel } = session;
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

  const forkAtMessage = useCallback(
    async (messageId: string) => {
      const result = await forkMessage({ threadId, messageId });
      await navigate({ to: '/chat/$threadId', params: { threadId: result.thread.id } });
    },
    [forkMessage, threadId, navigate],
  );

  const editAndBranch = useCallback(
    async (messageId: string, text: string) => {
      const result = await branchMessage({ threadId, messageId, text });
      const modelSlug = result.message.modelSlug ?? selectedModelSlug ?? null;
      // Without a recorded level the new thread starts at the instance default.
      const effort = result.message.effort ?? undefined;

      if (modelSlug) localStorage.setItem(MODEL_STORAGE_KEY, modelSlug);
      sessionStorage.setItem(
        PENDING_BRANCH_KEY,
        JSON.stringify({
          threadId: result.thread.id,
          messageId: result.message.id,
          modelSlug,
          effort,
        }),
      );
      await navigate({ to: '/chat/$threadId', params: { threadId: result.thread.id } });
    },
    [branchMessage, threadId, selectedModelSlug, navigate],
  );

  const scroll = useChatScroll(session.messages, session.streaming, target);

  if (session.recovery.unavailable)
    return (
      <ConversationLoadError
        unavailable
        retry={session.recovery.recover}
        retrying={session.recovery.refreshing}
      />
    );

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroll.scrollRef}
          onScroll={scroll.onScroll}
          data-conversation-scroller
          className="flex-1 overflow-y-auto"
        >
          <div ref={scroll.contentRef}>
            <MessageList
              messages={session.messages}
              streaming={session.streaming}
              // With tool calling the model decides whether to search, and its
              // search shows as a tool step instead.
              searching={
                session.webSearch && !session.selectedModel?.capabilities.includes('tool_calling')
              }
              onAnswerApproval={session.answerApproval}
              onRetry={retry}
              onFork={session.features?.branching ? forkAtMessage : undefined}
              onEdit={session.features?.branching ? editAndBranch : undefined}
              replySwitch={replies.switcher}
            />

            {(session.error ||
              session.recovery.error ||
              session.recovery.remotePending ||
              replies.error) && (
              <div className="mx-auto max-w-[42rem] space-y-2 px-4 pb-4">
                {(session.recovery.error || session.error || replies.error) && (
                  <p
                    role="alert"
                    className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-foreground)]"
                  >
                    {session.recovery.error ||
                      (session.error && chatErrorText(session.error)) ||
                      replies.error ||
                      'Something went wrong generating a response.'}
                  </p>
                )}
                {session.recovery.remotePending && (
                  <p role="status" className="text-sm text-[var(--text-muted)]">
                    A reply is pending on the server. You can stop it or wait for saved messages.
                  </p>
                )}
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

      <Composer
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
        attachmentsAvailable={session.features?.attachments ?? false}
        attachments={session.attachments.items}
        onAttachFiles={session.attachments.upload}
        onRemoveAttachment={session.attachments.remove}
      />
    </div>
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
  // Read once on mount so a re-render cannot lose the handover.
  const [carriedAttachments] = useState(() =>
    sessionStorage.getItem(PENDING_THREAD_KEY) === threadId ? peekPendingAttachments() : [],
  );
  const [carriedEffort] = useState(() =>
    sessionStorage.getItem(PENDING_THREAD_KEY) === threadId ? peekPendingEffort() : undefined,
  );
  const [carriedSearch] = useState(
    () => sessionStorage.getItem(PENDING_THREAD_KEY) === threadId && peekPendingSearch(),
  );
  const { setTemporary } = useTemporaryChat();

  const { data, isLoading, isError, error, isFetching, fetchStatus, refetch } = useQuery({
    queryKey: ['thread', threadId, 'messages'],
    queryFn: ({ signal }) => getChatHistory(threadId, signal),
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
      carriedAttachments={carriedAttachments}
      carriedEffort={carriedEffort}
      carriedSearch={carriedSearch}
      temporary={data.thread.temporary}
      target={target}
    />
  );
}
