import { isToolPart } from '@oci/shared';
import type { UIMessage } from 'ai';
import { type Dispatch, memo, type SetStateAction, useRef } from 'react';
import { showsArtifactCard } from '~/components/artifacts/artifact-tool-step';
import { useArtifacts } from '~/components/artifacts/artifacts-context';
import { ReplyMarkdown } from '~/components/artifacts/reply-content';
import { CapacityNote, CapacityWait, capacityWaitOf } from '~/components/chat/capacity-wait';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { MessageActions } from '~/components/chat/message-actions';
import { MessageAttachments } from '~/components/chat/message-attachments';
import {
  contextLimitedOf,
  failureOf,
  interruptionOf,
  metadataOf,
  replyLayoutOf,
  stoppedOf,
  textOf,
  type WorkEntry,
} from '~/components/chat/message-content';
import { MessageEditor } from '~/components/chat/message-editor';
import { ProjectSearchNote } from '~/components/chat/project-search-note';
import { ReplyFailureNote } from '~/components/chat/reply-outcome-note';
import { type ReplySwitch, ReplySwitcher } from '~/components/chat/reply-switcher';
import { WorkBlock } from '~/components/chat/reply-work';
import { replySearchOf, searchGroundingOf } from '~/components/chat/search-grounding';
import {
  type AnswerApproval,
  ReplyResults,
  type ToolPart,
  toolPlaceOf,
} from '~/components/chat/tool-steps';
import { cn } from '~/lib/utils';

interface MessageRowProps {
  message: UIMessage;
  /** The saved conversation; finished replies then offer "Export as…". */
  threadId?: string;
  streaming: boolean;
  editing: boolean;
  onEditingChange: Dispatch<SetStateAction<string | null>>;
  onRetry?: () => void;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onFork?: (messageId: string) => Promise<void>;
  replySwitch?: ReplySwitch;
  /** Answers this reply's open approvals; only the latest reply can be answered. */
  onAnswerApproval?: AnswerApproval;
  /** Stops the latest reply; offered while it waits for its model. */
  onStop?: () => void;
}

/**
 * The SDK replaces the active message and preserves historical object identity.
 * Shallow comparison skips both content extraction and Markdown for those rows.
 * Do not compare only IDs/text or ignore callbacks: metadata, sources, files,
 * permissions and action closures can all change independently of the text.
 */
export const MessageRow = memo(function MessageRow({
  message,
  threadId,
  streaming,
  editing,
  onEditingChange,
  onRetry,
  onEdit,
  onFork,
  replySwitch,
  onAnswerApproval,
  onStop,
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

  const grounding = searchGroundingOf(message);
  const metadata = metadataOf(message);
  const interruption = interruptionOf(message);
  const failure = streaming ? null : failureOf(message);
  const stopped = !streaming && stoppedOf(message);
  const capacity = capacityWaitOf(message);

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
      <ProjectSearchNote message={message} />
      {capacity &&
        (streaming ? (
          capacity.state === 'waiting' && <CapacityWait wait={capacity} onStop={onStop} />
        ) : (
          <CapacityNote wait={capacity} />
        ))}
      {/* Keyed: switching replies starts each one's block collapsed. */}
      <ReplyBody
        key={message.id}
        message={message}
        text={text}
        streaming={streaming}
        onAnswerApproval={onAnswerApproval}
      />
      {interruption && (
        <p role="note" className="mb-1 text-xs text-[var(--text-muted)]">
          {interruption}
        </p>
      )}
      {failure && <ReplyFailureNote reason={failure} onRetry={onRetry} latest={Boolean(onRetry)} />}
      {stopped && (
        <p role="note" className="mb-1 text-xs text-[var(--text-muted)]">
          {text.trim() ? 'You stopped this reply.' : 'You stopped this reply before it began.'}
        </p>
      )}
      {(replySwitch || !streaming) && (
        <div className="flex flex-wrap items-center gap-1">
          {replySwitch && <ReplySwitcher {...replySwitch} />}
          {!streaming && (
            <MessageActions
              text={text}
              onFork={
                onFork && metadata.status !== 'streaming' ? () => onFork(message.id) : undefined
              }
              onRetry={onRetry}
              exportTarget={
                threadId && metadata.status !== 'streaming'
                  ? { threadId, messageId: message.id }
                  : undefined
              }
              modelSlug={metadata.modelSlug}
              effort={metadata.effort}
              searched={Boolean(grounding)}
            />
          )}
        </div>
      )}
    </article>
  );
});

/**
 * A reply's work, results and text (v0.10.1): one block with everything the
 * model did before answering, then what that work made or needs (artifact
 * cards, approvals, memory notes), then the text in the order it was written.
 */
function ReplyBody({
  message,
  text,
  streaming,
  onAnswerApproval,
}: {
  message: UIMessage;
  text: string;
  streaming: boolean;
  onAnswerApproval?: AnswerApproval;
}) {
  const artifacts = useArtifacts();
  // Approvals answered in this view, so focus can follow the step they become.
  const answeredHere = useRef(new Set<string>()).current;
  const layout = replyLayoutOf(
    message.parts as ToolPart[],
    isToolPart,
    (part) => toolPlaceOf(part, showsArtifactCard(artifacts, message.id, part, streaming)),
    (part) => `tool-${part.toolCallId}`,
  );
  // The search before the reply and the links tool calls returned are steps
  // of the same block (v0.11), so a reply has at most one disclosure above it.
  const { presearch, sources } = replySearchOf(message);
  const work: WorkEntry<ToolPart>[] = [
    ...(presearch ? [{ type: 'search' as const, key: 'presearch', grounding: presearch }] : []),
    ...layout.work,
    ...(sources.length ? [{ type: 'sources' as const, key: 'sources', sources }] : []),
  ];
  return (
    <>
      {work.length > 0 && (
        <WorkBlock
          messageId={message.id}
          layout={{ ...layout, work }}
          streaming={streaming}
          answeredHere={answeredHere}
        />
      )}
      <ReplyResults
        message={message}
        parts={layout.results}
        onAnswer={onAnswerApproval}
        disabled={streaming}
        streaming={streaming}
        answeredHere={answeredHere}
      />
      {layout.text.map((group, index) => (
        <div
          key={group.key}
          data-reply-group="text"
          className={cn(
            'text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]',
            index < layout.text.length - 1 && 'mb-4',
          )}
        >
          <ReplyMarkdown
            messageId={message.id}
            text={text}
            range={{ start: group.start, end: group.end }}
            className={MARKDOWN_PROSE}
          />
        </div>
      ))}
    </>
  );
}
