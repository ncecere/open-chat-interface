import { ArrowUp, ChevronDown, Globe, Paperclip, Zap } from 'lucide-react';
import { type KeyboardEvent, useLayoutEffect, useRef } from 'react';
import { cn } from '~/lib/utils';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
}

function ComposerPill({
  icon: Icon,
  label,
  active,
}: {
  icon: typeof Zap;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        'inline-flex h-[1.875rem] items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] font-medium transition-colors',
        active
          ? 'border-[var(--accent-button-border)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
          : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon className="size-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/**
 * Bottom-anchored composer. The card is flush with the bottom edge and only
 * its top corners are rounded, matching the reference layout.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
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

  const canSubmit = value.trim().length > 0 && !disabled;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[47rem] px-3">
      <div className="rounded-t-[1.25rem] border border-b-0 border-[var(--border-strong)] bg-[var(--bg-control)] px-4 pb-4 pt-5">
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
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[0.8125rem] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-control-hover)]"
          >
            Select model
            <ChevronDown className="size-4 text-[var(--text-muted)]" />
          </button>

          <ComposerPill icon={Zap} label="Instant" />
          <ComposerPill icon={Globe} label="Search" />
          <ComposerPill icon={Paperclip} label="Attach" />

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
        </div>
      </div>
    </div>
  );
}
