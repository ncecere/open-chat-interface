import type { CatalogModel, ModelCapability } from '@oci/shared';
import { ChevronDown, Info, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { CapabilityIcon } from '~/components/model/capability-pill';
import { LabLogo } from '~/components/model/lab-logo';
import { ModelInfoCard } from '~/components/model/model-info-card';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { cn } from '~/lib/utils';
import {
  labsFrom,
  matchesCapabilities,
  matchesSearch,
  modelDescription,
} from './model-picker-data';
import { ModelPickerFilters } from './model-picker-filters';

export function ModelPicker({
  models,
  selected,
  onSelect,
}: {
  models: CatalogModel[];
  selected: CatalogModel | null;
  onSelect: (model: CatalogModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [labFilter, setLabFilter] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [capabilityFilters, setCapabilityFilters] = useState<ModelCapability[]>([]);
  const [combineFilters, setCombineFilters] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const labs = useMemo(() => labsFrom(models), [models]);
  const visible = useMemo(
    () =>
      models.filter(
        (model) =>
          matchesSearch(model, query) &&
          (!labFilter || model.labId === labFilter) &&
          matchesCapabilities(model, capabilityFilters, combineFilters),
      ),
    [models, query, labFilter, capabilityFilters, combineFilters],
  );

  if (models.length === 0) {
    return (
      <span className="px-2 text-[0.8125rem] text-[var(--text-muted)]">No models available</span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setFiltersOpen(false);
      }}
    >
      <PopoverTrigger
        role="combobox"
        aria-haspopup="listbox"
        aria-label={`Select model. Current model: ${selected?.displayName ?? 'none'}`}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[0.8125rem] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-control-hover)]"
      >
        {selected && <LabLogo labId={selected.labId} className="size-3.5" />}
        {selected?.displayName ?? 'Select model'}
        <ChevronDown className="size-4 text-[var(--text-muted)]" />
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        aria-label="Choose a model"
        className="relative w-[min(29rem,calc(100vw-1rem))] overflow-hidden p-0"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <Search className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label="Search models"
            placeholder="Search models..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // Keep normal Escape handling so the menu remains keyboard-closeable.
            onKeyDown={(event) => {
              if (event.key !== 'Escape') event.stopPropagation();
            }}
            className="h-9 w-full bg-transparent text-[0.9375rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          <ModelPickerFilters
            open={filtersOpen}
            selected={capabilityFilters}
            combine={combineFilters}
            onOpenChange={setFiltersOpen}
            onSelectedChange={setCapabilityFilters}
            onCombineChange={setCombineFilters}
          />
        </div>

        <div className="flex h-[min(26.5rem,calc(100vh-8rem))] min-h-64">
          {labs.length > 1 && (
            <fieldset className="scrollbar-thin m-0 flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-0 border-r border-[var(--border-subtle)] p-2">
              <legend className="sr-only">Filter by lab</legend>
              <button
                type="button"
                aria-label="All labs"
                aria-pressed={labFilter === null}
                onClick={() => setLabFilter(null)}
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg text-[0.6875rem] font-semibold outline-offset-1 transition-colors',
                  labFilter === null
                    ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-control-hover)]',
                )}
              >
                All
              </button>
              {labs.map((lab) => (
                <button
                  key={lab.id}
                  type="button"
                  aria-label={lab.name}
                  title={lab.name}
                  aria-pressed={labFilter === lab.id}
                  onClick={() => setLabFilter(labFilter === lab.id ? null : lab.id)}
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg outline-offset-1 transition-colors',
                    labFilter === lab.id
                      ? 'bg-[var(--accent-soft)]'
                      : 'hover:bg-[var(--bg-control-hover)]',
                  )}
                >
                  <LabLogo labId={lab.id} className="size-4" />
                </button>
              ))}
            </fieldset>
          )}

          <div
            role="listbox"
            aria-label="Models"
            className="scrollbar-thin min-w-0 flex-1 overflow-y-auto p-1.5"
          >
            {visible.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
                No models match that search.
              </p>
            ) : (
              visible.map((model) => (
                // The info trigger is a sibling rather than a child: a button
                // inside a button is invalid markup, and browsers resolve it by
                // dropping the inner control.
                <div
                  key={model.id}
                  className={cn(
                    'relative flex w-full items-center rounded-lg transition-colors',
                    'hover:bg-[var(--bg-control)]',
                    selected?.id === model.id && 'bg-[var(--accent-soft)]',
                  )}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected?.id === model.id}
                    onClick={() => {
                      onSelect(model);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 text-left text-[var(--text-secondary)] outline-offset-[-2px]"
                  >
                    <span className="flex w-full items-center gap-2">
                      <LabLogo labId={model.labId} className="size-4 shrink-0" />
                      <span className="min-w-0 truncate text-base font-semibold leading-5 text-[var(--text-primary)]">
                        {model.displayName}
                      </span>
                      {/* Pushes the capabilities to the right edge of the row. */}
                      <span className="flex-1" />
                      {model.capabilities.length > 0 && (
                        <span className="flex shrink-0 items-center gap-1">
                          {model.capabilities.map((capability) => (
                            <CapabilityIcon key={capability} capability={capability} />
                          ))}
                        </span>
                      )}
                    </span>

                    <span className="w-full truncate pl-6 text-xs font-medium leading-4 text-[var(--text-muted)]">
                      {modelDescription(model)}
                    </span>
                  </button>

                  {/*
                   * A popover rather than a hover card: the panel carries real
                   * detail, and content that vanishes when the pointer drifts
                   * cannot be read at leisure or reached from a keyboard.
                   */}
                  <Popover>
                    <PopoverTrigger
                      aria-label={`Details for ${model.displayName}`}
                      className="mr-2 shrink-0 self-end rounded p-1.5 text-[var(--text-faint)] transition-colors hover:text-[var(--text-primary)]"
                    >
                      <Info className="size-3.5" />
                    </PopoverTrigger>
                    <PopoverContent
                      side="right"
                      align="end"
                      collisionPadding={12}
                      className="max-h-[min(28rem,calc(100vh-6rem))] min-h-56 w-[min(34rem,calc(100vw-2rem))] overflow-y-auto p-6"
                    >
                      <ModelInfoCard model={model} />
                    </PopoverContent>
                  </Popover>
                </div>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
