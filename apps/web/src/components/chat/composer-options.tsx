import { type CatalogModel, effectiveSupportedEfforts, type ReasoningEffort } from '@oci/shared';
import { Brain, Check, ChevronRight, Globe, Paperclip, Plus, Zap } from 'lucide-react';
import { type ChangeEvent, type ComponentPropsWithoutRef, forwardRef, useRef } from 'react';
import { ModelPicker } from '~/components/chat/model-picker';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { cn } from '~/lib/utils';

export interface ComposerOptionsProps {
  models: CatalogModel[];
  selectedModel: CatalogModel | null;
  onSelectModel: (model: CatalogModel) => void;
  effort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
  webSearch: boolean;
  onWebSearchChange: (enabled: boolean) => void;
  webSearchAvailable?: boolean;
  attachmentsAvailable?: boolean;
  /** Why attaching is paused for now (read-only maintenance): shown, disabled, with it. */
  attachmentsPausedReason?: string;
  onAttachFiles?: (files: File[]) => void;
  /**
   * The model list or the person's features are still loading: the picker
   * says so and Attach waits, rather than claiming there are no models or
   * hiding Attach until they arrive (#156).
   */
  loading?: boolean;
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
      // A toggle says whether it is on, not only with its border (#92).
      aria-pressed={active}
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

export function ComposerOptions({
  models,
  selectedModel,
  onSelectModel,
  effort,
  onEffortChange,
  webSearch,
  onWebSearchChange,
  webSearchAvailable = true,
  attachmentsAvailable = true,
  attachmentsPausedReason,
  onAttachFiles,
  loading = false,
}: ComposerOptionsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  return (
    <>
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
        {/* Below the composer where there is room (a new chat, where above is
            the greeting it would cover, #102); Radix flips it above when there
            is not, as in a conversation. */}
        <DropdownMenuContent align="start" side="bottom" className="min-w-56 md:hidden">
          {/* Only for a model that offers reasoning levels, as the user guide
              says; a greyed "Instant" on every other model explained nothing (#95). */}
          {supportsEffort && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
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
          )}
          {/* On or off, announced as checked: "Search disabled" read as if the
              feature were unavailable (#92). */}
          <DropdownMenuCheckboxItem
            disabled={!supportsSearch}
            checked={webSearch}
            onCheckedChange={(checked) => onWebSearchChange(checked === true)}
          >
            <Globe />
            Search the web
          </DropdownMenuCheckboxItem>
          {/* Not offered where attachments are not allowed (for this role, or
              while read-only), as the user guide says, rather than a disabled
              control with no reason (#99). */}
          {attachmentsAvailable && (
            <DropdownMenuItem
              disabled={!onAttachFiles || Boolean(attachmentsPausedReason) || loading}
              onSelect={() => fileInputRef.current?.click()}
            >
              <Paperclip />
              Attach
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ModelPicker
        models={models}
        selected={selectedModel}
        onSelect={onSelectModel}
        loading={loading}
      />

      {supportsEffort && (
        <div className="hidden md:block">
          <DropdownMenu>
            {/* Pill renders a real button, so the trigger's ARIA belongs on it
            directly; a wrapping span would receive button semantics it
            cannot legally carry. */}
            <DropdownMenuTrigger asChild>
              <Pill icon={Zap} label={effort} className="capitalize" />
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
      )}

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
      {attachmentsAvailable && (
        <Pill
          icon={Paperclip}
          label="Attach"
          disabled={!onAttachFiles || Boolean(attachmentsPausedReason) || loading}
          title={attachmentsPausedReason}
          onClick={() => fileInputRef.current?.click()}
          className="hidden md:inline-flex"
        />
      )}
    </>
  );
}
