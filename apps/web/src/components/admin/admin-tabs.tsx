import { cn } from '~/lib/utils';

export interface AdminTab<T extends string> {
  id: T;
  label: string;
}

/**
 * The segmented control admin pages use to divide one subject into facets.
 *
 * Extracted because the same markup, ARIA wiring, and active styling had begun
 * to appear on several pages; a shared control keeps a tab strip behaving the
 * same way wherever it turns up.
 *
 * Pages that keep the active tab in the URL pass a navigating `onChange`, so
 * a reload or shared link opens the same facet.
 */
export function AdminTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  controls,
}: {
  tabs: readonly AdminTab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  /** The panel every tab controls, when they share one (e.g. a date range). */
  controls?: string;
}) {
  return (
    <div
      className="inline-flex flex-wrap gap-1 rounded-xl bg-[var(--bg-segment-track)] p-1"
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={controls ?? `panel-${tab.id}`}
          onClick={() => onChange(tab.id)}
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
