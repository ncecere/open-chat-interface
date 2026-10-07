import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
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
  const list = useRef<HTMLDivElement>(null);
  const overflow = useOverflow(list);

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
    // One row, scrolling sideways when it does not fit (a phone): wrapped, a
    // tab sat on a second line inside the same pill (#89). A tab moved to
    // with the keyboard scrolls itself into view. Its scrollbar is hidden, so
    // the side with more tabs fades out, saying there is more (#243).
    <div
      ref={list}
      data-overflow-start={overflow.start || undefined}
      data-overflow-end={overflow.end || undefined}
      className={cn(
        'inline-flex max-w-full overflow-x-auto rounded-xl bg-[var(--bg-segment-track)] p-1 [scrollbar-width:none]',
        // Tighter on a phone, so four tabs (a project's) fit 390 px (#243).
        'gap-0.5 sm:gap-1',
        FADE,
      )}
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
            'shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm transition-colors sm:px-3',
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

/**
 * The fade on a side with tabs scrolled out of view, over its last 1.5rem.
 * Written out in full: Tailwind finds classes in the source as written.
 */
const FADE = [
  'data-[overflow-end]:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]',
  'data-[overflow-start]:[mask-image:linear-gradient(to_left,#000_calc(100%-1.5rem),transparent)]',
  'data-[overflow-start]:data-[overflow-end]:[mask-image:linear-gradient(to_right,transparent,#000_1.5rem,#000_calc(100%-1.5rem),transparent)]',
].join(' ');

/** Whether the strip has tabs out of view before or after what shows. */
function useOverflow(ref: RefObject<HTMLElement | null>) {
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const start = node.scrollLeft > 1;
    const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setOverflow((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, [ref]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      node.removeEventListener('scroll', measure);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, measure]);
  return overflow;
}
