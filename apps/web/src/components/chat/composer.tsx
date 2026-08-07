import type { CatalogModel, ReasoningEffort } from '@oci/shared';
import { REASONING_EFFORTS } from '@oci/shared';
import { ArrowUp, Globe, Paperclip, Square, Zap } from 'lucide-react';
import { type KeyboardEvent, useLayoutEffect, useRef } from 'react';
import { ModelPicker } from '~/components/chat/model-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { cn } from '~/lib/utils';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  streaming?: boolean;
  models: CatalogModel[];
  selectedModel: CatalogModel | null;
  onSelectModel: (model: CatalogModel) => void;
  effort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
  webSearch: boolean;
  onWebSearchChange: (enabled: boolean) => void;
  placeholder?: string;
}

function Pill({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: typeof Zap;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-[1.875rem] items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
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
  onStop,
  streaming,
  models,
  selectedModel,
  onSelectModel,
  effort,
  onEffortChange,
  webSearch,
  onWebSearchChange,
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

  const canSubmit = value.trim().length > 0 && Boolean(selectedModel) && !streaming;
  const supportsEffort = selectedModel?.capabilities.includes('effort_control') ?? false;
  const supportsSearch = selectedModel?.capabilities.includes('web_search') ?? true;

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
          <ModelPicker models={models} selected={selectedModel} onSelect={onSelectModel} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!supportsEffort}>
              <span>
                <Pill icon={Zap} label={effort} disabled={!supportsEffort} />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              {REASONING_EFFORTS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  onSelect={() => onEffortChange(option)}
                  className="capitalize"
                >
                  {option}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Pill
            icon={Globe}
            label="Search"
            active={webSearch}
            disabled={!supportsSearch}
            onClick={() => onWebSearchChange(!webSearch)}
          />

          <Pill icon={Paperclip} label="Attach" disabled />

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
}
