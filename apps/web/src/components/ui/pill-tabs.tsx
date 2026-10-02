import { type KeyboardEvent, useRef } from 'react';
import { cn } from '~/lib/utils';

export interface PillTab<T extends string> {
  id: T;
  label: string;
}

/**
 * The pill-shaped segmented control pages use to divide one subject into facets.
 *
 * Extracted because the same markup, ARIA wiring, and active styling had begun
 * to appear on several pages; a shared control keeps a tab strip behaving the
 * same way wherever it turns up.
 *
 * Pages that keep the active tab in the URL pass a navigating `onChange`, so
 * a reload or shared link opens the same facet.
 *
 * Keyboard behaviour follows the WAI-ARIA tabs pattern: only the selected tab
 * is in the Tab order, and Left/Right (or Up/Down), Home and End move between
 * tabs and select them. Selection follows focus because switching a facet is
 * cheap and reversible.
 */
export function PillTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  controls,
}: {
  tabs: readonly PillTab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  /** The panel every tab controls, when they share one (e.g. a date range). */
  controls?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    const tab = tabs[target];
    if (!tab) return;
    buttons.current[target]?.focus();
    if (tab.id !== active) onChange(tab.id);
  }

  return (
    <div
      className="inline-flex flex-wrap gap-1 rounded-xl bg-[var(--bg-segment-track)] p-1"
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={controls ?? `panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => move(event, index)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm transition-colors',
            active === tab.id
              ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
