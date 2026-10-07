import { ArrowUp, Square } from 'lucide-react';
import { type KeyboardEvent, memo, useEffect, useLayoutEffect, useRef } from 'react';
import { AttachmentChips } from '~/components/chat/attachment-chips';
import { ComposerConnectHint } from '~/components/chat/composer-connect-hint';
import { ComposerOptions, type ComposerOptionsProps } from '~/components/chat/composer-options';
import { ProjectFilesControl } from '~/components/chat/project-files-control';
import type { PendingAttachment } from '~/hooks/use-attachments';
import { readOnlyShortReason, useReadOnlyStatus } from '~/lib/read-only';
import { isSendKey, sendKeyShortcuts } from '~/lib/send-keys';
import { cn } from '~/lib/utils';
import { useInvertSend } from '~/providers/theme-provider';

interface ComposerProps extends ComposerOptionsProps {
  /** Focus the message field when it first appears. */
  autoFocus?: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  streaming?: boolean;
  /** A send is being handed over (the home page creating its conversation): no second one. */
  submitting?: boolean;
  attachments?: PendingAttachment[];
  onRemoveAttachment?: (localId: string) => void;
  placeholder?: string;
  /** The conversation's project, for the Project files control (v0.10). */
  projectId?: string | null;
  /** Project files left out of the next message. */
  excludedProjectFileIds?: readonly string[];
  onExcludedProjectFilesChange?: (ids: string[]) => void;
}

const NO_FILES: readonly string[] = [];

/**
 * Bottom-anchored composer. The card is flush with the bottom edge and only
 * its top corners are rounded, matching the reference layout.
 */
export const Composer = memo(function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  submitting = false,
  models,
  selectedModel,
  onSelectModel,
  effort,
  onEffortChange,
  webSearch,
  onWebSearchChange,
  webSearchAvailable,
  attachmentsAvailable,
  attachments = [],
  onAttachFiles,
  loading = false,
  onRemoveAttachment,
  placeholder = 'Type your message here...',
  autoFocus = false,
  projectId = null,
  excludedProjectFileIds = NO_FILES,
  onExcludedProjectFilesChange,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Settings → Customization: Enter adds a line and Cmd/Ctrl+Enter sends.
  const invertSend = useInvertSend();

  // Only on mount: a conversation started from the home page replaces the
  // composer the person was typing in, which would otherwise drop focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // Re-measure whenever the text changes so the field grows with its content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the resize
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [value]);

  // Read-only maintenance mode (v0.11): nothing can be sent or uploaded; the
  // banner above says why, and the field says so where the person types.
  const readOnly = useReadOnlyStatus();
  const uploading = attachments.some((item) => item.status === 'uploading');
  const canSubmit =
    value.trim().length > 0 &&
    Boolean(selectedModel) &&
    !streaming &&
    !uploading &&
    !submitting &&
    !readOnly.active;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter that confirms an IME candidate never sends (see isSendKey). Any
    // other Enter that does not send is left to add a new line.
    if (isSendKey(event, { invert: invertSend })) {
      event.preventDefault();
      // A held key sends once: its auto-repeats are not further messages
      // (v0.10.2; on the home page each one started another conversation).
      if (canSubmit && !event.repeat) onSubmit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[47rem] px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-3 md:pb-0">
      <ComposerConnectHint selectedModel={selectedModel} />
      <div className="rounded-[1.25rem] border border-[var(--border-strong)] bg-[var(--bg-control)] px-4 pb-4 pt-5 focus-within:outline focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-[var(--text-faint)] md:rounded-b-none md:border-b-0">
        <AttachmentChips items={attachments} onRemove={(id) => onRemoveAttachment?.(id)} />

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={readOnly.active ? `${readOnlyShortReason(readOnly)}.` : placeholder}
          disabled={readOnly.active}
          aria-label="Message input"
          className={cn(
            'w-full resize-none bg-transparent text-[0.9375rem] leading-relaxed',
            'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
            'focus:outline-none',
          )}
        />

        <div className="mt-5 flex items-center gap-2">
          <ComposerOptions
            models={models}
            selectedModel={selectedModel}
            onSelectModel={onSelectModel}
            effort={effort}
            onEffortChange={onEffortChange}
            webSearch={webSearch}
            onWebSearchChange={onWebSearchChange}
            webSearchAvailable={webSearchAvailable}
            attachmentsAvailable={attachmentsAvailable}
            attachmentsPausedReason={readOnly.active ? readOnlyShortReason(readOnly) : undefined}
            onAttachFiles={onAttachFiles}
            loading={loading}
          />
          {projectId && attachmentsAvailable !== false && onExcludedProjectFilesChange && (
            <ProjectFilesControl
              projectId={projectId}
              excluded={excludedProjectFileIds}
              onExcludedChange={onExcludedProjectFilesChange}
              disabled={streaming}
            />
          )}

          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="ml-auto inline-flex size-[2.125rem] shrink-0 items-center justify-center rounded-lg border border-[var(--accent-button-border)] bg-[var(--accent-send)] text-[var(--accent-button-foreground)] transition-colors hover:bg-[var(--accent-send-hover)]"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSubmit}
              aria-busy={submitting || undefined}
              onClick={onSubmit}
              aria-label="Send message"
              title={readOnly.active ? readOnlyShortReason(readOnly) : undefined}
              aria-keyshortcuts={sendKeyShortcuts(invertSend)}
              className={cn(
                'ml-auto inline-flex size-[2.125rem] shrink-0 items-center justify-center rounded-lg border transition-colors',
                canSubmit
                  ? 'border-[var(--accent-button-border)] bg-[var(--accent-send)] text-[var(--accent-button-foreground)] hover:bg-[var(--accent-send-hover)]'
                  : 'border-[var(--border-strong)] bg-[var(--accent-soft)] text-[var(--text-faint)]',
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
