import { type Attachment, REASONING_EFFORTS, type ReasoningEffort } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { Composer } from '~/components/chat/composer';
import { MessageList } from '~/components/chat/message-list';
import { UsageWarning } from '~/components/chat/usage-warning';
import { FullPageSpinner } from '~/components/ui/spinner';
import { useChatSession } from '~/hooks/use-chat-session';
import { useBranchMessage, useForkMessage } from '~/hooks/use-threads';
import { api } from '~/lib/api-client';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

const PENDING_KEY = 'oci.pendingPrompt';
const PENDING_ATTACHMENTS_KEY = 'oci.pendingAttachments';
const PENDING_EFFORT_KEY = 'oci.pendingEffort';
const PENDING_SEARCH_KEY = 'oci.pendingWebSearch';
const PENDING_BRANCH_KEY = 'oci.pendingBranchResponse';
const MODEL_STORAGE_KEY = 'oci.model';

interface PendingBranchResponse {
  threadId: string;
  messageId: string;
  modelSlug: string | null;
  effort: ReasoningEffort;
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
      !['instant', 'low', 'medium', 'high'].includes(value.effort ?? '')
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
  carriedAttachments,
  carriedEffort,
  carriedSearch,
  temporary,
}: {
  threadId: string;
  initialMessages: UIMessage[];
  carriedAttachments: Attachment[];
  carriedEffort?: ReasoningEffort;
  carriedSearch: boolean;
  temporary: boolean;
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
  const navigate = useNavigate();
  const branchMessage = useBranchMessage();
  const forkMessage = useForkMessage();
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentPending = useRef(false);
  const continuedBranch = useRef(false);
  const pendingModelAvailable = pendingBranch?.modelSlug
    ? session.models.some((model) => model.slug === pendingBranch.modelSlug)
    : false;

  // A prompt handed over from the landing page is sent once the thread mounts.
  useEffect(() => {
    if (sentPending.current) return;
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (!pending || !session.selectedModel) return;

    sentPending.current = true;
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_ATTACHMENTS_KEY);
    sessionStorage.removeItem(PENDING_EFFORT_KEY);
    sessionStorage.removeItem(PENDING_SEARCH_KEY);
    void session.send(pending);
  }, [session.selectedModel, session.send]);

  // The branch API has already stored the edited user turn. Regenerate from
  // that exact row so Save & submit cannot append a duplicate user message.
  useEffect(() => {
    if (
      continuedBranch.current ||
      !pendingBranch ||
      !session.selectedModel ||
      (pendingBranch.modelSlug &&
        pendingModelAvailable &&
        session.selectedModel.slug !== pendingBranch.modelSlug)
    ) {
      return;
    }

    continuedBranch.current = true;
    sessionStorage.removeItem(PENDING_BRANCH_KEY);
    void session.regenerate({ messageId: pendingBranch.messageId });
  }, [pendingBranch, pendingModelAvailable, session.regenerate, session.selectedModel]);

  async function forkAtMessage(messageId: string) {
    const result = await forkMessage.mutateAsync({ threadId, messageId });
    await navigate({ to: '/chat/$threadId', params: { threadId: result.thread.id } });
  }

  async function editAndBranch(messageId: string, text: string) {
    const result = await branchMessage.mutateAsync({ threadId, messageId, text });
    const modelSlug = result.message.modelSlug ?? session.selectedModel?.slug ?? null;
    const effort = result.message.effort ?? 'instant';

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
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [session.messages.length, session.streaming]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <MessageList
          messages={session.messages}
          streaming={session.streaming}
          searching={session.webSearch}
          onRetry={() => session.regenerate()}
          onFork={session.features?.branching ? forkAtMessage : undefined}
          onEdit={session.features?.branching ? editAndBranch : undefined}
        />

        {session.error && (
          <div className="mx-auto max-w-[42rem] px-4 pb-4">
            <p className="rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-foreground)]">
              {session.error.message || 'Something went wrong generating a response.'}
            </p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <UsageWarning />

      <Composer
        value={session.draft}
        onChange={session.setDraft}
        onSubmit={() => session.send()}
        onStop={() => session.stop()}
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

export function ChatThreadPage({ threadId }: { threadId: string }) {
  // Read once on mount so a re-render cannot lose the handover.
  const [carriedAttachments] = useState(peekPendingAttachments);
  const [carriedEffort] = useState(peekPendingEffort);
  const [carriedSearch] = useState(peekPendingSearch);
  const { setTemporary } = useTemporaryChat();

  const { data, isLoading } = useQuery({
    queryKey: ['thread', threadId, 'messages'],
    queryFn: () =>
      api.get<{
        thread: {
          id: string;
          temporary: boolean;
          expiresAt: string | null;
        };
        messages: UIMessage[];
      }>(`/chat/${threadId}/messages`),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  useEffect(() => {
    if (data) setTemporary(data.thread.temporary);
  }, [data, setTemporary]);

  if (isLoading || !data) return <FullPageSpinner />;

  // Remount when the thread changes so useChat starts from the right history.
  return (
    <ThreadConversation
      key={threadId}
      threadId={threadId}
      initialMessages={data.messages}
      carriedAttachments={carriedAttachments}
      carriedEffort={carriedEffort}
      carriedSearch={carriedSearch}
      temporary={data.thread.temporary}
    />
  );
}
