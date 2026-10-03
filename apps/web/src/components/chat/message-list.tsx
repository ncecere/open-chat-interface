import type { ConversationCompaction } from '@oci/shared';
import type { UIMessage } from 'ai';
import { memo, useState } from 'react';
import { CompactionDivider } from '~/components/chat/compaction-divider';
import { reasoningOf, textOf } from '~/components/chat/message-content';
import { MessageRow } from '~/components/chat/message-row';
import type { ReplySwitch } from '~/components/chat/reply-switcher';
import { SearchLoading } from '~/components/chat/search-grounding';
import { type AnswerApproval, toolLimitOf, toolStepsOf } from '~/components/chat/tool-steps';

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
}: MessageListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const last = messages.at(-1);
  const lastIsAssistant = last?.role === 'assistant';
  const switchable = Boolean(replySwitch) && lastIsAssistant;
  const lastText = lastIsAssistant ? textOf(last) : '';
  const lastReasoning = lastIsAssistant ? reasoningOf(last) : '';
  // A tool step is visible progress too, for example "Searching the web…".
  const hasVisibleContent = Boolean(
    lastText ||
      lastReasoning ||
      (lastIsAssistant && (toolStepsOf(last).length > 0 || toolLimitOf(last))),
  );
  const waitingLabel = lastReasoning ? 'Thinking' : 'Generating response';

  // Room at the top for the top bar's floating controls, which the column runs under.
  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-4 pb-8 pt-[4.5rem]">
      {messages.flatMap((message, index) => [
        ...(compaction?.firstKeptMessageId === message.id
          ? [<CompactionDivider key={`compaction-${compaction.id}`} compaction={compaction} />]
          : []),
        <MessageRow
          // Switching replies swaps the last message. Keying that row by its
          // prompt keeps it mounted, so focus stays on the switcher.
          key={
            switchable && index === messages.length - 1
              ? `replies-of-${messages[index - 1]?.id}`
              : message.id
          }
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
          onFork={onFork}
          onEdit={onEdit}
        />,
      ])}

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
