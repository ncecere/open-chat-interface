import { useQuery } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { useEffect, useRef } from 'react';
import { Composer } from '~/components/chat/composer';
import { MessageList } from '~/components/chat/message-list';
import { FullPageSpinner } from '~/components/ui/spinner';
import { useChatSession } from '~/hooks/use-chat-session';
import { api } from '~/lib/api-client';

const PENDING_KEY = 'oci.pendingPrompt';

function ThreadConversation({
  threadId,
  initialMessages,
}: {
  threadId: string;
  initialMessages: UIMessage[];
}) {
  const session = useChatSession({ threadId, initialMessages });
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentPending = useRef(false);

  // A prompt handed over from the landing page is sent once the thread mounts.
  useEffect(() => {
    if (sentPending.current) return;
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (!pending || !session.selectedModel) return;

    sentPending.current = true;
    sessionStorage.removeItem(PENDING_KEY);
    void session.send(pending);
  }, [session.selectedModel, session.send]);

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
          onRetry={() => session.regenerate()}
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
      />
    </div>
  );
}

export function ChatThreadPage({ threadId }: { threadId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['thread', threadId, 'messages'],
    queryFn: () => api.get<{ messages: UIMessage[] }>(`/chat/${threadId}/messages`),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  if (isLoading || !data) return <FullPageSpinner />;

  // Remount when the thread changes so useChat starts from the right history.
  return <ThreadConversation key={threadId} threadId={threadId} initialMessages={data.messages} />;
}
