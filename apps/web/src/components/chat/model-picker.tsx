import type { CatalogModel, ModelCapability } from '@oci/shared';
import { ChevronDown, Search } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { LabLogo } from '~/components/model/lab-logo';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { ariaKeyShortcuts, OPEN_MODEL_PICKER_EVENT } from '~/lib/keyboard-shortcuts';
import { cn } from '~/lib/utils';
import { labsFrom, matchesCapabilities, matchesSearch } from './model-picker-data';
import { ModelPickerFilters } from './model-picker-filters';
import { ModelPickerDetails, ModelPickerOption, modelOptionId } from './model-picker-presentation';

export const ModelPicker = memo(function ModelPicker({
  models,
  selected,
  onSelect,
  loading = false,
}: {
  models: CatalogModel[];
  selected: CatalogModel | null;
  onSelect: (model: CatalogModel) => void;
  /** The list has not arrived yet: say so, not that there are no models (#156). */
  loading?: boolean;
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
  // The option the arrow keys are on; focus stays in the search box.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailsOnLeft, setDetailsOnLeft] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Chooses the side with room, measured when the card opens.
   *
   * Deciding once rather than per render keeps the card still: re-measuring as
   * the contents change could flip it mid-read.
   *
   * Returns false when neither side fits, since the card is as wide as the
   * picker and a narrow window has room for one or the other, not both.
   */
  function placeDetails(): 'left' | 'right' | null {
    const panel = panelRef.current?.getBoundingClientRect();
    if (!panel) return 'right';

    // The card matches the panel's width, so that plus the gutter is exactly
    // what has to fit beside it.
    const width = panel.width + 8;
    if (panel.right + width <= window.innerWidth) return 'right';
    if (panel.left - width >= 0) return 'left';
    return null;
  }

  function showDetails(modelId: string) {
    setDetailsFor((current) => {
      if (current === modelId) return null;

      const side = placeDetails();
      if (!side) return null;

      setDetailsOnLeft(side === 'left');
      return modelId;
    });
  }

  /**
   * Whether the details control is worth offering.
   *
   * A button that does nothing when clicked is worse than no button, so it is
   * hidden when the window is too narrow to place the card beside the picker.
   *
   * Measured in an effect rather than during render: the panel is portalled,
   * so on the render that first shows it there is nothing yet to measure.
   */
  const [canShowDetails, setCanShowDetails] = useState(false);

  useEffect(() => {
    if (!open) {
      setCanShowDetails(false);
      return;
    }

    const update = () => setCanShowDetails(placeDetails() !== null);
    // Radix positions the panel after mounting it, so a measurement taken in
    // the same frame reads its pre-placement box.
    const frame = requestAnimationFrame(update);

    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
    };
  });

  // ⌘/ (Ctrl+/) from anywhere on the page opens the picker with its search focused.
  const available = models.length > 0;
  useEffect(() => {
    if (!available) return;
    function openFromShortcut(event: Event) {
      event.preventDefault();
      setOpen(true);
      // Already open: the panel keeps focus where it was, so put it back on search.
      searchRef.current?.focus();
    }
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, openFromShortcut);
    return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, openFromShortcut);
  }, [available]);

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

  // The arrow keys' option: kept while it still matches, otherwise the
  // current model if it matches, otherwise the first match. So typing
  // "haiku" and pressing Enter picks Haiku.
  const active =
    visible.find((model) => model.id === activeId) ??
    visible.find((model) => model.id === selected?.id) ??
    visible[0] ??
    null;

  function moveActive(step: 1 | -1) {
    if (visible.length === 0) return;
    const index = active ? visible.indexOf(active) : -1;
    const next = visible[(index + step + visible.length) % visible.length];
    if (!next) return;
    setActiveId(next.id);
    document.getElementById(modelOptionId(next.id))?.scrollIntoView({ block: 'nearest' });
  }

  // A card left open for a model that filtering has just removed would describe
  // something no longer on screen.
  const detailsModel = visible.find((model) => model.id === detailsFor) ?? null;

  if (models.length === 0) {
    return (
      <span className="px-2 text-[0.8125rem] text-[var(--text-muted)]">
        {loading ? 'Loading models…' : 'No models available'}
      </span>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setActiveId(null);
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
        aria-keyshortcuts={ariaKeyShortcuts('model-picker')}
        // One line: a narrow composer row cuts a long name short rather than
        // wrapping it ("GPT-4.1 / mini", #109); the full name is in the label.
        className="inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[0.8125rem] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-control-hover)]"
      >
        {selected && <LabLogo labId={selected.labId} className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{selected?.displayName ?? 'Select model'}</span>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-muted)]" />
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
        // Never taller than the space Radix measures on the chosen side: from
        // the mid-screen composer on a phone it opened past the top edge,
        // hiding the search box.
        className="relative flex max-h-[var(--radix-popover-content-available-height)] w-[min(29rem,calc(100vw-1rem))] flex-col p-0"
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
            role="combobox"
            aria-expanded="true"
            aria-controls="model-picker-listbox"
            aria-autocomplete="list"
            aria-activedescendant={active ? modelOptionId(active.id) : undefined}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') event.stopPropagation();
              // The listbox pattern: arrows move through the matches and Enter
              // picks one, so a search never needs a dozen Tabs to reach it.
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveActive(event.key === 'ArrowDown' ? 1 : -1);
              } else if (event.key === 'Enter' && active) {
                event.preventDefault();
                onSelect(active);
                setOpen(false);
              } else if (
                // Details for the highlighted model, from the keyboard: the
                // row's Details button is for the pointer (#114).
                event.key === 'ArrowRight' &&
                active &&
                canShowDetails &&
                event.currentTarget.selectionStart === event.currentTarget.value.length
              ) {
                event.preventDefault();
                showDetails(active.id);
              }
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

        <div className="flex h-[min(26.5rem,calc(100vh-8rem))] min-h-32 shrink overflow-hidden rounded-b-xl">
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
            id="model-picker-listbox"
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
                <ModelPickerOption
                  key={model.id}
                  model={model}
                  selected={selected?.id === model.id}
                  active={active?.id === model.id}
                  canShowDetails={canShowDetails}
                  detailsOpen={detailsFor === model.id}
                  onSelect={(model) => {
                    onSelect(model);
                    setOpen(false);
                  }}
                  onDetails={showDetails}
                />
              ))
            )}
          </div>
        </div>

        {/*
         * Prefers the right, and falls back to the left only when the panel is
         * too near the viewport edge for the card to fit. Whichever side wins,
         * it stays there for as long as the picker is open, so moving between
         * models changes the contents and nothing else.
         */}
        {detailsModel && <ModelPickerDetails model={detailsModel} onLeft={detailsOnLeft} />}
      </PopoverContent>
    </Popover>
  );
});
