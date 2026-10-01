import { ArrowUp, Square } from 'lucide-react';
import { type KeyboardEvent, memo, useLayoutEffect, useRef } from 'react';
import { AttachmentChips } from '~/components/chat/attachment-chips';
import { ComposerOptions, type ComposerOptionsProps } from '~/components/chat/composer-options';
import type { PendingAttachment } from '~/hooks/use-attachments';
import { cn } from '~/lib/utils';

interface ComposerProps extends ComposerOptionsProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  streaming?: boolean;
  attachments?: PendingAttachment[];
  onRemoveAttachment?: (localId: string) => void;
  placeholder?: string;
}

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
  onRemoveAttachment,
  placeholder = 'Type your message here...',
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-measure whenever the text changes so the field grows with its content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the resize
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [value]);

  const uploading = attachments.some((item) => item.status === 'uploading');
  const canSubmit = value.trim().length > 0 && Boolean(selectedModel) && !streaming && !uploading;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter confirms an IME candidate, not the message. Safari can report
    // composition ended while retaining the composing keyCode on this event.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[47rem] px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-3 md:pb-0">
      <div className="rounded-[1.25rem] border border-[var(--border-strong)] bg-[var(--bg-control)] px-4 pb-4 pt-5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent-bright)] md:rounded-b-none md:border-b-0">
        <AttachmentChips items={attachments} onRemove={(id) => onRemoveAttachment?.(id)} />

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
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
            onAttachFiles={onAttachFiles}
          />

          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="ml-auto inline-flex size-[2.125rem] items-center justify-center rounded-lg border border-[var(--accent-button-border)] bg-[var(--accent-send)] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-send-hover)]"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSubmit}
              onClick={onSubmit}
              aria-label="Send message"
              className={cn(
                'ml-auto inline-flex size-[2.125rem] items-center justify-center rounded-lg border transition-colors',
                canSubmit
                  ? 'border-[var(--accent-button-border)] bg-[var(--accent-send)] text-[var(--text-primary)] hover:bg-[var(--accent-send-hover)]'
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
