import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * At or below this many rows every row is rendered, exactly as before v0.11:
 * find in page, the accessibility tree and layout see the whole transcript.
 * A conversation's first page (100 messages) stays below it.
 */
export const WINDOW_THRESHOLD = 150;
/** Rendered beyond each edge of the view: at least this, or one view height. */
const MIN_OVERSCAN_PX = 800;

export type RowPlanEntry =
  | { type: 'row'; index: number }
  | { type: 'spacer'; key: string; height: number };

interface Anchor {
  key: string;
  index: number;
  /** Distance of the row's top from the top of the view. */
  top: number;
}

/**
 * Windowing for a long transcript (v0.11, item 21): only rows near the view
 * are rendered; the rest are spacers of their measured (or estimated) height,
 * so the scroll height and position stay right. Hand-rolled rather than a
 * library because the conversation's own scrolling (pin to bottom, the
 * question pinned under the top bar, opening at a search result) owns the
 * scroller and must stay in charge of it.
 *
 * - Rows are measured with one ResizeObserver; heights are kept per key.
 * - While windowing, the browser's scroll anchoring is turned off and a row
 *   above the view that changes height (it was estimated, or its code was
 *   highlighted) moves the view by the same amount, so nothing in sight
 *   jumps. Rows the reader can see are never compensated for.
 * - When rows are inserted before what the reader sees (an earlier page, the
 *   gap filling), the first visible row is kept where it was.
 * - `forced` keys are always rendered: the message opened from search and
 *   the row holding keyboard focus, so focus is never dropped with its row.
 */
export function useWindowedRows(options: {
  keys: readonly string[];
  /** A height for a row not measured yet. */
  estimate: (index: number) => number;
  scrollRef?: RefObject<HTMLElement | null>;
  rowsRef: RefObject<HTMLElement | null>;
  forced: ReadonlyArray<string | null | undefined>;
}) {
  const { keys, estimate, scrollRef, rowsRef, forced } = options;
  const enabled = Boolean(scrollRef) && keys.length > WINDOW_THRESHOLD;
  const heights = useRef(new Map<string, number>()).current;
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);

  const indexOf = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  // Row tops relative to the first row, from measured heights or estimates.
  // Heights change without a render; `range` changes with them when it matters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when the range moves.
  const offsets = useMemo(() => {
    const list = new Array<number>(keys.length + 1);
    list[0] = 0;
    for (let index = 0; index < keys.length; index++)
      list[index + 1] = list[index]! + (heights.get(keys[index]!) ?? estimate(index));
    return list;
  }, [keys, estimate, heights, range]);
  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;
  const layout = useRef({ keys, offsets, indexOf, enabled });
  layout.current = { keys, offsets, indexOf, enabled };

  /** The rows of about two views at the end: where a conversation opens. */
  const tailRange = useCallback(() => {
    const { keys: current, offsets: tops } = layout.current;
    const view = (scrollRef?.current?.clientHeight || globalThis.innerHeight || 800) * 2;
    let start = current.length - 1;
    while (start > 0 && tops[current.length]! - tops[start]! < view) start--;
    return { start: current[Math.max(0, start)]!, end: current.at(-1)! };
  }, [scrollRef]);

  /** Row tops from the heights known now (measurements arrive between renders). */
  const freshOffsets = useCallback(() => {
    const { keys: current } = layout.current;
    const tops = new Array<number>(current.length + 1);
    tops[0] = 0;
    for (let index = 0; index < current.length; index++)
      tops[index + 1] = tops[index]! + (heights.get(current[index]!) ?? estimateRef.current(index));
    return tops;
  }, [heights]);

  const updateRange = useCallback(() => {
    const { keys: current, enabled: on } = layout.current;
    const scroller = scrollRef?.current;
    const rows = rowsRef.current;
    if (!on || !scroller || !rows || current.length === 0) return;
    const view = scroller.clientHeight;
    if (view === 0) return;
    const tops = freshOffsets();
    const rowsTop =
      rows.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const over = Math.max(MIN_OVERSCAN_PX, view);
    const top = scroller.scrollTop - rowsTop - over;
    const bottom = scroller.scrollTop - rowsTop + view + over;
    // First row ending below `top`, last row starting above `bottom`.
    let low = 0;
    let high = current.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tops[middle + 1]! > top) high = middle;
      else low = middle + 1;
    }
    const start = low;
    let end = start;
    while (end < current.length - 1 && tops[end + 1]! < bottom) end++;
    const next = { start: current[start]!, end: current[end]! };
    setRange((previous) =>
      previous?.start === next.start && previous.end === next.end ? previous : next,
    );
  }, [scrollRef, rowsRef, freshOffsets]);

  // The first row in sight, to keep in place when rows are inserted above it.
  const anchor = useRef<Anchor | null>(null);
  const captureAnchor = useCallback(() => {
    const scroller = scrollRef?.current;
    const rows = rowsRef.current;
    if (!scroller || !rows) return;
    const viewTop = scroller.getBoundingClientRect().top;
    for (const row of rows.querySelectorAll<HTMLElement>(':scope > [data-row-key]')) {
      const box = row.getBoundingClientRect();
      if (box.bottom > viewTop) {
        const key = row.dataset.rowKey!;
        const index = layout.current.indexOf.get(key);
        anchor.current = index === undefined ? null : { key, index, top: box.top - viewTop };
        return;
      }
    }
    anchor.current = null;
  }, [scrollRef, rowsRef]);

  // Measure rows; compensate for rows above the view changing height.
  const frame = useRef(0);
  const scheduleUpdate = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      updateRange();
      captureAnchor();
    });
  }, [updateRange, captureAnchor]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const [observer] = useState(() =>
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const scroller = scrollRef?.current;
          const viewTop = scroller?.getBoundingClientRect().top ?? 0;
          let shift = 0;
          for (const entry of entries) {
            const row = entry.target as HTMLElement;
            const key = row.dataset.rowKey;
            if (!key || !row.isConnected) continue;
            const height =
              entry.borderBoxSize?.[0]?.blockSize ?? row.getBoundingClientRect().height;
            const index = layout.current.indexOf.get(key);
            const previous =
              heights.get(key) ?? (index === undefined ? height : estimateRef.current(index));
            heights.set(key, height);
            // Entirely above the view: the reader cannot see it change, but
            // would see everything below it move.
            if (layout.current.enabled && Math.abs(height - previous) > 0.5) {
              if (row.getBoundingClientRect().bottom <= viewTop + 1) shift += height - previous;
            }
          }
          if (scroller && shift !== 0) scroller.scrollTop += shift;
          scheduleUpdate();
        }),
  );
  useEffect(() => () => observer?.disconnect(), [observer]);
  /** Ref for each rendered row (stable; React 19 runs the returned cleanup). */
  const measure = useCallback(
    (row: HTMLElement | null) => {
      if (!row || !observer) return;
      observer.observe(row);
      return () => observer.unobserve(row);
    },
    [observer],
  );

  // Windowing turns scroll anchoring off: compensation above replaces it.
  useLayoutEffect(() => {
    const scroller = scrollRef?.current;
    if (!scroller) return;
    scroller.style.overflowAnchor = enabled ? 'none' : '';
    return () => {
      scroller.style.overflowAnchor = '';
    };
  }, [enabled, scrollRef]);

  // Rows inserted before the first one in sight: keep that one where it was.
  useLayoutEffect(() => {
    const held = anchor.current;
    const scroller = scrollRef?.current;
    const rows = rowsRef.current;
    const index = held ? indexOf.get(held.key) : undefined;
    if (held && scroller && rows && index !== undefined && index !== held.index) {
      const row = rows.querySelector<HTMLElement>(
        `:scope > [data-row-key="${CSS.escape(held.key)}"]`,
      );
      if (row) {
        const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const shift = top - held.top;
        if (Math.abs(shift) > 0.5) scroller.scrollTop += shift;
      }
      anchor.current = { ...held, index };
    }
    updateRange();
  }, [indexOf, scrollRef, rowsRef, updateRange]);

  // After every commit (and the conversation's own scrolling): where the reader is.
  useEffect(() => {
    captureAnchor();
  });

  useEffect(() => {
    const scroller = scrollRef?.current;
    if (!scroller) return;
    const options = { passive: true } as const;
    scroller.addEventListener('scroll', scheduleUpdate, options);
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => scheduleUpdate());
    resize?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', scheduleUpdate);
      resize?.disconnect();
    };
  }, [scrollRef, scheduleUpdate]);

  const plan = useMemo<RowPlanEntry[]>(() => {
    if (!enabled) return keys.map((_, index) => ({ type: 'row', index }));
    // Windowing starts where the reader is (loading earlier pages crossed the
    // threshold), or at the end where a conversation opens.
    const held = anchor.current;
    const heldIndex = held ? indexOf.get(held.key) : undefined;
    const window =
      range ??
      (heldIndex === undefined
        ? tailRange()
        : {
            start: keys[Math.max(0, heldIndex - 10)]!,
            end: keys[Math.min(keys.length - 1, heldIndex + 30)]!,
          });
    let start = indexOf.get(window.start);
    let end = indexOf.get(window.end);
    if (start === undefined || end === undefined || end < start) {
      const tail = tailRange();
      start = indexOf.get(tail.start) ?? 0;
      end = keys.length - 1;
    }
    const shown = new Set<number>();
    for (let index = start; index <= end; index++) shown.add(index);
    for (const key of forced) {
      const index = key ? indexOf.get(key) : undefined;
      if (index !== undefined) shown.add(index);
    }
    const entries: RowPlanEntry[] = [];
    let next = 0;
    for (const index of [...shown].sort((a, b) => a - b)) {
      if (index > next)
        entries.push({
          type: 'spacer',
          key: `spacer-${keys[next]}`,
          height: offsets[index]! - offsets[next]!,
        });
      entries.push({ type: 'row', index });
      next = index + 1;
    }
    if (next < keys.length)
      entries.push({
        type: 'spacer',
        key: `spacer-${keys[next]}`,
        height: offsets[keys.length]! - offsets[next]!,
      });
    return entries;
  }, [enabled, keys, range, indexOf, offsets, forced, tailRange]);

  return { plan, measure, windowed: enabled };
}
