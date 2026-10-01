import type { UIMessage } from 'ai';
import { type Dispatch, memo, type SetStateAction } from 'react';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { MessageActions } from '~/components/chat/message-actions';
import { MessageAttachments } from '~/components/chat/message-attachments';
import {
  contextLimitedOf,
  metadataOf,
  reasoningOf,
  textOf,
} from '~/components/chat/message-content';
import { MessageEditor } from '~/components/chat/message-editor';
import { ReasoningPanel } from '~/components/chat/message-reasoning';
import {
  SearchGroundingDetails,
  SearchSourcesPanel,
  searchGroundingOf,
} from '~/components/chat/search-grounding';

interface MessageRowProps {
  message: UIMessage;
  streaming: boolean;
  editing: boolean;
  onEditingChange: Dispatch<SetStateAction<string | null>>;
  onRetry?: () => void;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onFork?: (messageId: string) => Promise<void>;
}

/**
 * The SDK replaces the active message and preserves historical object identity.
 * Shallow comparison skips both content extraction and Markdown for those rows.
 * Do not compare only IDs/text or ignore callbacks: metadata, sources, files,
 * permissions and action closures can all change independently of the text.
 */
export const MessageRow = memo(function MessageRow({
  message,
  streaming,
  editing,
  onEditingChange,
  onRetry,
  onEdit,
  onFork,
}: MessageRowProps) {
  const text = textOf(message);

  if (message.role === 'user') {
    return (
      <article
        className="group flex flex-col items-end"
        aria-label="Your message"
        data-message-id={message.id}
        data-message-role="user"
      >
        {editing && onEdit ? (
          <MessageEditor
            messageId={message.id}
            initialText={text}
            onEdit={onEdit}
            onClose={() => onEditingChange((current) => (current === message.id ? null : current))}
          />
        ) : (
          <>
            <div className="max-w-[85%] rounded-2xl border border-[var(--border-user-message)] bg-[var(--bg-user-message)] px-4 py-3 text-[0.9375rem] leading-relaxed text-[var(--text-primary)]">
              <Markdown>{text}</Markdown>
              <MessageAttachments message={message} />
            </div>
            <MessageActions
              text={text}
              onFork={onFork && !streaming ? () => onFork(message.id) : undefined}
              onEdit={onEdit && !streaming ? () => onEditingChange(message.id) : undefined}
            />
          </>
        )}
      </article>
    );
  }

  const reasoning = reasoningOf(message);
  const grounding = searchGroundingOf(message);
  const metadata = metadataOf(message);

  return (
    <article
      className="group flex flex-col"
      aria-label="Assistant message"
      data-message-id={message.id}
    >
      {contextLimitedOf(message) && (
        <p role="note" className="mb-2 text-xs text-[var(--text-muted)]">
          Earlier conversation context was omitted to fit the input limit.
        </p>
      )}
      {grounding && <SearchSourcesPanel grounding={grounding} />}
      {reasoning && (
        <ReasoningPanel text={reasoning} streaming={streaming} answerStarted={Boolean(text)} />
      )}
      <div className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
        <Markdown className={MARKDOWN_PROSE}>{text}</Markdown>
      </div>
      {grounding && <SearchGroundingDetails grounding={grounding} />}
      {!streaming && (
        <MessageActions
          text={text}
          onFork={onFork && metadata.status !== 'streaming' ? () => onFork(message.id) : undefined}
          onRetry={onRetry}
          modelSlug={metadata.modelSlug}
          effort={metadata.effort}
          searched={Boolean(grounding)}
        />
      )}
    </article>
  );
});
