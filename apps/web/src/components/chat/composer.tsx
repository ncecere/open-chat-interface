import { type CatalogModel, effectiveSupportedEfforts, type ReasoningEffort } from '@oci/shared';
import {
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  Globe,
  Paperclip,
  Plus,
  Square,
  Zap,
} from 'lucide-react';
import {
  type ChangeEvent,
  type ComponentPropsWithoutRef,
  forwardRef,
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
} from 'react';
import { AttachmentChips } from '~/components/chat/attachment-chips';
import { ModelPicker } from '~/components/chat/model-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import type { PendingAttachment } from '~/hooks/use-attachments';
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
  webSearchAvailable?: boolean;
  attachmentsAvailable?: boolean;
  attachments?: PendingAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (localId: string) => void;
  placeholder?: string;
}

/**
 * Forwards its ref and remaining props so it can serve as a Radix `asChild`
 * trigger. Wrapping it in a span instead would put button semantics on an
 * element that cannot carry them.
 */
const Pill = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & {
    icon: typeof Zap;
    label: string;
    active?: boolean;
  }
>(({ icon: Icon, label, active, disabled, onClick, className, ...props }, ref) => {
  return (
    <button
      {...props}
      ref={ref}
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
        className,
      )}
    >
      <Icon className="size-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
});
Pill.displayName = 'Pill';

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
  webSearchAvailable = true,
  attachmentsAvailable = true,
  attachments = [],
  onAttachFiles,
  onRemoveAttachment,
  placeholder = 'Type your message here...',
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const availableEfforts = selectedModel ? effectiveSupportedEfforts(selectedModel) : [];
  const supportsEffort = availableEfforts.length > 0;
  // OCI search grounding is provider-independent, so every chat model can use it.
  const supportsSearch = webSearchAvailable;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) onAttachFiles?.(files);
    // Reset so selecting the same file again still fires a change event.
    event.target.value = '';
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More composer options"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--accent-button-border)] bg-[var(--accent-soft)] text-[var(--text-primary)] md:hidden"
              >
                <Plus className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-56 md:hidden">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={!supportsEffort}>
                  <Brain />
                  <span className="flex-1 capitalize">Reasoning: {effort}</span>
                  <ChevronRight className="ml-auto" />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {availableEfforts.map((option) => (
                    <DropdownMenuItem
                      key={option}
                      onSelect={() => onEffortChange(option)}
                      className="capitalize"
                    >
                      <span className="w-4">{option === effort && <Check />}</span>
                      {option}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                disabled={!supportsSearch}
                onSelect={() => onWebSearchChange(!webSearch)}
              >
                <Globe />
                Search {webSearch ? 'enabled' : 'disabled'}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!attachmentsAvailable || !onAttachFiles}
                onSelect={() => fileInputRef.current?.click()}
              >
                <Paperclip />
                Attach
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ModelPicker models={models} selected={selectedModel} onSelect={onSelectModel} />

          <div className="hidden md:block">
            <DropdownMenu>
              {/* Pill renders a real button, so the trigger's ARIA belongs on it
                directly; a wrapping span would receive button semantics it
                cannot legally carry. */}
              <DropdownMenuTrigger asChild disabled={!supportsEffort}>
                <Pill icon={Zap} label={effort} disabled={!supportsEffort} className="capitalize" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                {availableEfforts.map((option) => (
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
          </div>

          <Pill
            icon={Globe}
            label="Search"
            active={webSearch}
            disabled={!supportsSearch}
            onClick={() => onWebSearchChange(!webSearch)}
            className="hidden md:inline-flex"
          />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-label="Attach a file"
            onChange={handleFileChange}
          />
          <Pill
            icon={Paperclip}
            label="Attach"
            disabled={!attachmentsAvailable || !onAttachFiles}
            onClick={() => fileInputRef.current?.click()}
            className="hidden md:inline-flex"
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
}
