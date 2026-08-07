import type { ModelCapability } from '@oci/shared';
import { ListFilter, X } from 'lucide-react';
import { CAPABILITY_ICONS, CAPABILITY_LABELS, FILTER_CAPABILITIES } from './model-picker-data';

interface ModelPickerFiltersProps {
  open: boolean;
  selected: ModelCapability[];
  combine: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectedChange: (selected: ModelCapability[]) => void;
  onCombineChange: (combine: boolean) => void;
}

export function ModelPickerFilters({
  open,
  selected,
  combine,
  onOpenChange,
  onSelectedChange,
  onCombineChange,
}: ModelPickerFiltersProps) {
  const toggle = (capability: ModelCapability) => {
    onSelectedChange(
      selected.includes(capability)
        ? selected.filter((value) => value !== capability)
        : [...selected, capability],
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label="Filter models"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]"
      >
        <ListFilter className="size-4" aria-hidden="true" />
        {selected.length > 0 && (
          <span className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[0.625rem] font-bold leading-none text-[var(--accent-foreground)]">
            {selected.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-2 top-12 z-20 w-56 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-[var(--shadow-popover)]">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-xs font-semibold text-[var(--text-primary)]">Capabilities</span>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onSelectedChange([])}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-[0.6875rem] text-[var(--text-muted)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]"
              >
                <X className="size-3" aria-hidden="true" />
                Clear
              </button>
            )}
          </div>

          <div className="flex flex-col">
            {FILTER_CAPABILITIES.map((capability) => {
              const Icon = CAPABILITY_ICONS[capability];
              const active = selected.includes(capability);
              return (
                <button
                  key={capability}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(capability)}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)] aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--text-primary)]"
                >
                  {Icon && <Icon className="size-4" aria-hidden="true" />}
                  {CAPABILITY_LABELS[capability]}
                </button>
              );
            })}
          </div>

          <div className="mt-1 border-t border-[var(--border-subtle)] pt-1">
            <button
              type="button"
              aria-pressed={combine}
              disabled={selected.length < 2}
              onClick={() => onCombineChange(!combine)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Match every selected capability
              <span
                aria-hidden="true"
                className="rounded-full bg-[var(--bg-control)] px-2 py-0.5 text-[0.625rem] font-semibold text-[var(--text-muted)]"
              >
                {combine ? 'All' : 'Any'}
              </span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
