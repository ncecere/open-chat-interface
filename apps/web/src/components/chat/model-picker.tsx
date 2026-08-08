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
  /**
   * Which model's details are showing.
   *
   * Held here rather than per row so the card occupies one fixed position
   * beside the panel. A popover anchored to each row would jump up and down
   * the screen as the pointer moves between them.
   */
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [detailsOnLeft, setDetailsOnLeft] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Chooses the side with room, measured when the card opens.
   *
   * Deciding once rather than per render keeps the card still: re-measuring as
   * the contents change could flip it mid-read.
   */
  function showDetails(modelId: string) {
    setDetailsFor((current) => {
      if (current === modelId) return null;

      const panel = panelRef.current?.getBoundingClientRect();
      if (panel) {
        // Mirrors the card's own `w-[min(32rem,32vw)]` plus its gutter, so the
        // measurement matches what will actually render.
        const width = Math.min(512, window.innerWidth * 0.32) + 8;
        const fitsRight = panel.right + width <= window.innerWidth;
        setDetailsOnLeft(!fitsRight && panel.left - width >= 0);
      }
      return modelId;
    });
  }

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

  // A card left open for a model that filtering has just removed would describe
  // something no longer on screen.
  const detailsModel = visible.find((model) => model.id === detailsFor) ?? null;

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
        if (!nextOpen) {
          setFiltersOpen(false);
          setDetailsFor(null);
        }
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
        ref={panelRef}
        className="relative w-[min(29rem,calc(100vw-1rem))] p-0"
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

        <div className="flex h-[min(26.5rem,calc(100vh-8rem))] min-h-64 overflow-hidden rounded-b-xl">
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
                    className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-lg py-2.5 pr-3 pl-3 text-left text-[var(--text-secondary)] outline-offset-[-2px]"
                  >
                    <span className="flex w-full items-center gap-2">
                      <LabLogo labId={model.labId} className="size-4 shrink-0" />
                      <span className="min-w-0 truncate text-base font-semibold leading-5 text-[var(--text-primary)]">
                        {model.displayName}
                      </span>
                    </span>

                    <span className="w-full truncate pl-6 text-xs font-medium leading-4 text-[var(--text-muted)]">
                      {modelDescription(model)}
                    </span>
                  </button>

                  {/*
                   * Capabilities and the details control share one right-hand
                   * column, so both line up down the list however long a model
                   * name happens to be.
                   */}
                  <span className="flex shrink-0 items-center gap-1 pr-2">
                    {model.capabilities.map((capability) => (
                      <CapabilityIcon key={capability} capability={capability} />
                    ))}

                    <button
                      type="button"
                      aria-label={`Details for ${model.displayName}`}
                      aria-expanded={detailsFor === model.id}
                      onClick={() => showDetails(model.id)}
                      className={cn(
                        'ml-0.5 shrink-0 rounded p-1.5 transition-colors hover:text-[var(--text-primary)]',
                        detailsFor === model.id
                          ? 'text-[var(--text-primary)]'
                          : 'text-[var(--text-faint)]',
                      )}
                    >
                      <Info className="size-3.5" />
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/*
         * One card for the whole panel, in a fixed position beside it.
         *
         * Prefers the right, and falls back to the left only when the panel is
         * too near the viewport edge for the card to fit. Whichever side wins,
         * it stays there for as long as the picker is open, so moving between
         * models changes the contents and nothing else.
         *
         * Aligned to the panel's top rather than centred, so the heading sits
         * at a predictable height however much detail a model carries.
         */}
        {detailsModel && (
          <div
            className={cn(
              'pointer-events-none absolute top-0 hidden md:block',
              detailsOnLeft ? 'right-full pr-2' : 'left-full pl-2',
            )}
          >
            <div className="pointer-events-auto flex h-[26rem] w-[min(32rem,32vw)] flex-col overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-popover)]">
              <ModelInfoCard model={detailsModel} />
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
