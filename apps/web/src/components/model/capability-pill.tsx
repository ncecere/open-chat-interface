import type { ModelCapability } from '@oci/shared';
import { CAPABILITY_ICONS, CAPABILITY_LABELS } from '~/components/chat/model-picker-data';
import { cn } from '~/lib/utils';

/**
 * Colour per capability.
 *
 * Kept as one map so adding a capability means adding a row here, rather than
 * hunting for class strings across the picker and the info card.
 */
const CAPABILITY_COLORS: Record<ModelCapability, string> = {
  vision: 'text-[var(--cap-vision)]',
  reasoning: 'text-[var(--cap-reasoning)]',
  effort_control: 'text-[var(--cap-effort)]',
  tool_calling: 'text-[var(--cap-tools)]',
  fast: 'text-[var(--cap-fast)]',
  pdf_comprehension: 'text-[var(--cap-pdf)]',
  image_generation: 'text-[var(--cap-image)]',
  web_search: 'text-[var(--cap-search)]',
};

/**
 * The tint behind a capability.
 *
 * Derived from the text colour with `bg-current` rather than declared
 * separately, so the two can never drift apart.
 */
function Tint() {
  return <span className="absolute inset-0 bg-current opacity-15" aria-hidden="true" />;
}

/** A labelled capability, for surfaces with room to spell it out. */
export function CapabilityPill({ capability }: { capability: ModelCapability }) {
  const Icon = CAPABILITY_ICONS[capability];

  return (
    <span
      className={cn(
        'relative flex items-center gap-2 overflow-hidden rounded-full px-3 py-1.5 text-sm',
        CAPABILITY_COLORS[capability],
      )}
    >
      <Tint />
      {Icon && <Icon className="relative size-4" aria-hidden="true" />}
      <span className="relative whitespace-nowrap">{CAPABILITY_LABELS[capability]}</span>
    </span>
  );
}

/**
 * The icon alone, for picker rows where a full label would not fit.
 *
 * The label still reaches assistive technology, so colour is a second signal
 * rather than the only one.
 */
export function CapabilityIcon({ capability }: { capability: ModelCapability }) {
  const Icon = CAPABILITY_ICONS[capability];
  if (!Icon) return null;

  return (
    <span
      className={cn(
        'relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md',
        CAPABILITY_COLORS[capability],
      )}
    >
      <Tint />
      <Icon className="relative size-3.5" aria-label={CAPABILITY_LABELS[capability]} />
    </span>
  );
}
