import type { UIMessage } from 'ai';
import { memo, useState } from 'react';
import { reasoningOf, textOf } from '~/components/chat/message-content';
import { MessageRow } from '~/components/chat/message-row';
import { SearchLoading } from '~/components/chat/search-grounding';

interface MessageListProps {
  messages: UIMessage[];
  streaming: boolean;
  onRetry: () => void;
  searching?: boolean;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onFork?: (messageId: string) => Promise<void>;
}

/** Transcript composition only; editing drafts and presentation belong to rows. */
export const MessageList = memo(function MessageList({
  messages,
  streaming,
  onRetry,
  onEdit,
  onFork,
  searching = false,
}: MessageListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const last = messages.at(-1);
  const lastIsAssistant = last?.role === 'assistant';
  const lastText = lastIsAssistant ? textOf(last) : '';
  const lastReasoning = lastIsAssistant ? reasoningOf(last) : '';
  const hasVisibleContent = Boolean(lastText || lastReasoning);
  const waitingLabel = lastReasoning ? 'Thinking' : 'Generating response';

  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-4 py-8">
      {messages.map((message, index) => (
        <MessageRow
          key={message.id}
          message={message}
          // Only the active assistant streams; user actions stay disabled
          // throughout generation. Historical assistants need no token updates.
          streaming={streaming && (message.role === 'user' || index === messages.length - 1)}
          editing={editingId === message.id}
          onEditingChange={setEditingId}
          onRetry={index === messages.length - 1 ? onRetry : undefined}
          onFork={onFork}
          onEdit={onEdit}
        />
      ))}

      {/* An empty assistant row is not visible progress. Keep feedback until
          text or reasoning arrives, including providers with hidden reasoning. */}
      {streaming &&
        !hasVisibleContent &&
        (searching ? (
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
        ))}
    </div>
  );
});
