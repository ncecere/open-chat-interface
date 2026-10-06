import type { CatalogModel } from '@oci/shared';
import { Info } from 'lucide-react';
import { CapabilityIcon } from '~/components/model/capability-pill';
import { LabLogo } from '~/components/model/lab-logo';
import { ModelInfoCard } from '~/components/model/model-info-card';
import {
  ACTIVE_OPTION_RING,
  HIGHLIGHTED_ROW_TEXT,
  HOVERED_ROW_TEXT,
} from '~/components/ui/item-focus';
import { cn } from '~/lib/utils';
import { CAPABILITY_LABELS, modelDescription } from './model-picker-data';

/** The DOM id of a model's option, for the search box's aria-activedescendant. */
export const modelOptionId = (modelId: string) => `model-option-${modelId}`;

export function ModelPickerOption({
  model,
  selected,
  active = false,
  canShowDetails,
  detailsOpen,
  onSelect,
  onDetails,
}: {
  model: CatalogModel;
  selected: boolean;
  /** The option the arrow keys are on (focus stays in the search box). */
  active?: boolean;
  canShowDetails: boolean;
  detailsOpen: boolean;
  onSelect: (model: CatalogModel) => void;
  onDetails: (id: string) => void;
}) {
  return (
    // The info trigger is a sibling rather than a child: a button
    // inside a button is invalid markup, and browsers resolve it by
    // dropping the inner control.
    // Only options belong in a listbox (#114): the row is presentation, the
    // capabilities are read as part of the option, and the details button is
    // for the pointer (from the keyboard, Right arrow in the search box).
    <div
      role="none"
      className={cn(
        'relative flex w-full items-center rounded-lg transition-colors',
        // --bg-control is the panel's own white in light, so it showed nothing (#135).
        'hover:bg-[var(--bg-control-hover)]',
        HOVERED_ROW_TEXT,
        // The description stays readable on the wash (#188).
        selected && cn('bg-[var(--accent-soft)]', HIGHLIGHTED_ROW_TEXT),
        // Visible like a focus ring, since focus itself stays in the search box.
        active && ACTIVE_OPTION_RING,
      )}
    >
      <button
        type="button"
        role="option"
        id={modelOptionId(model.id)}
        aria-selected={selected}
        onClick={() => onSelect(model)}
        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-lg py-2.5 pr-3 pl-3 text-left text-[var(--text-secondary)] outline-offset-[-2px]"
      >
        {/* Name and description wrap rather than end in an ellipsis: on a
            phone there is no hover for a tooltip, and the cut hid what tells
            two models apart, "Claude Haiku 4.5 (t…" for "(thinking)" (#195). */}
        <span className="flex w-full items-start gap-2">
          <LabLogo labId={model.labId} className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 text-base font-semibold leading-5 wrap-anywhere text-[var(--text-primary)]">
            {model.displayName}
          </span>
        </span>

        <span className="w-full pl-6 text-xs font-medium leading-4 wrap-anywhere text-[var(--text-muted)]">
          {modelDescription(model)}
        </span>
        {model.capabilities.length > 0 && (
          <span className="sr-only">
            {`, ${model.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(', ')}`}
          </span>
        )}
      </button>

      {/*
       * Capabilities and the details control share one right-hand
       * column, so both line up down the list however long a model
       * name happens to be.
       */}
      <span className="flex shrink-0 items-center gap-1 pr-2" aria-hidden="true">
        {model.capabilities.map((capability) => (
          <CapabilityIcon key={capability} capability={capability} />
        ))}

        {canShowDetails && (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Details for ${model.displayName}`}
            aria-expanded={detailsOpen}
            onClick={() => onDetails(model.id)}
            className={cn(
              'ml-0.5 shrink-0 rounded p-1.5 transition-colors hover:text-[var(--text-primary)]',
              detailsOpen ? 'text-[var(--text-primary)]' : 'text-[var(--text-faint)]',
            )}
          >
            <Info className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * One card for the whole panel, in a fixed position beside it.
 * Matches the picker exactly: same width, and stretched to the panel's
 * own top and bottom edges. A card of some other size reads as a
 * detached object floating next to the list rather than part of it.
 */
export function ModelPickerDetails({ model, onLeft }: { model: CatalogModel; onLeft: boolean }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-y-0 hidden w-[calc(100%+2px)] md:block',
        onLeft ? 'right-full -translate-x-2' : 'left-full translate-x-2',
      )}
    >
      <div className="pointer-events-auto flex h-full w-full flex-col overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-popover)]">
        <ModelInfoCard model={model} />
      </div>
    </div>
  );
}
