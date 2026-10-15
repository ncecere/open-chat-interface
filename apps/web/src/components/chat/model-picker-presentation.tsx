import type { CatalogModel, ClassificationModel } from '@oci/shared';
import { Info, ShieldAlert } from 'lucide-react';
import { CapabilityIcon } from '~/components/model/capability-pill';
import { LabLogo } from '~/components/model/lab-logo';
import { ModelInfoCard } from '~/components/model/model-info-card';
import {
  ACTIVE_OPTION_RING,
  HIGHLIGHTED_ROW_TEXT,
  HOVERED_ROW_TEXT,
} from '~/components/ui/item-focus';
import { notApprovedText, warnNoteText } from '~/lib/classification';
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
  availability,
  onSelect,
  onDetails,
}: {
  model: CatalogModel;
  /**
   * Whether the conversation's data classes allow this model (v0.14, #395):
   * a blocked model stays in the list, aria-disabled, with the classes it is
   * not approved for in words; in `warn` it can be chosen, with an amber note.
   */
  availability?: ClassificationModel | undefined;
  selected: boolean;
  /** The option the arrow keys are on (focus stays in the search box). */
  active?: boolean;
  canShowDetails: boolean;
  detailsOpen: boolean;
  onSelect: (model: CatalogModel) => void;
  onDetails: (id: string) => void;
}) {
  const blocked = availability?.status === 'blocked';
  const warned = availability?.status === 'warn';
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
        !blocked && 'hover:bg-[var(--bg-control-hover)]',
        !blocked && HOVERED_ROW_TEXT,
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
        // Still reachable with the arrow keys and read out with its reason, but
        // not chosen: the server refuses it anyway (#395).
        aria-disabled={blocked || undefined}
        onClick={() => {
          if (!blocked) onSelect(model);
        }}
        className={cn(
          'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg py-2.5 pe-3 ps-3 text-start text-[var(--text-secondary)] outline-offset-[-2px]',
          blocked ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
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

        <span className="w-full ps-6 text-xs font-medium leading-4 wrap-anywhere text-[var(--text-muted)]">
          {modelDescription(model)}
        </span>
        {availability && availability.status !== 'ok' && (
          // Text, not colour alone: the reason is part of the option's name.
          <span
            data-classification-note={availability.status}
            className={cn(
              'flex w-full items-start gap-1.5 ps-6 text-xs font-semibold leading-4 wrap-anywhere',
              warned ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]',
            )}
          >
            <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {warned ? warnNoteText(availability) : notApprovedText(availability)}
          </span>
        )}
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
      <span className="flex shrink-0 items-center gap-1 pe-2" aria-hidden="true">
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
              'ms-0.5 shrink-0 rounded p-1.5 transition-colors hover:text-[var(--text-primary)]',
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
