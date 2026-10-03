import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/** The docked panel's width in CSS pixels, remembered in this browser. */
export const PANEL_WIDTH_STORAGE_KEY = 'oci.artifacts.panelWidth';

/** The narrowest docked panel: 22rem at the default root size. */
export const PANEL_MIN_WIDTH = 352;
/** The widest docked panel, as a share of the window. */
export const PANEL_MAX_SHARE = 0.7;
/** One arrow-key step; Shift makes it four times as large. */
export const PANEL_KEY_STEP = 32;

/** The widest the panel may be in a window this wide (never below the minimum). */
export function maxPanelWidth(windowWidth: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.floor(windowWidth * PANEL_MAX_SHARE));
}

/**
 * An estimate of the default width (the CSS default is 45% of the layout
 * beside the sidebar, at least 22rem and at most 56rem), used for the
 * separator's value until the panel has been measured.
 */
export function defaultPanelWidth(windowWidth: number): number {
  return clampPanelWidth(Math.min(896, Math.round(windowWidth * 0.45)), windowWidth);
}

export function clampPanelWidth(width: number, windowWidth: number): number {
  return Math.min(maxPanelWidth(windowWidth), Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

export function readPanelWidth(): number | null {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    // Blocked storage: the default width.
    return null;
  }
}

function writePanelWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(PANEL_WIDTH_STORAGE_KEY);
    else localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage full or blocked: the width lasts for this page only.
  }
}

/**
 * The width a key press asks for, or null for a key the separator ignores.
 * The separator is the panel's left edge, so Left widens and Right narrows.
 */
export function widthForKey(
  key: string,
  shift: boolean,
  width: number,
  windowWidth: number,
): number | null {
  const step = shift ? PANEL_KEY_STEP * 4 : PANEL_KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clampPanelWidth(width + step, windowWidth);
    case 'ArrowRight':
    case 'ArrowDown':
      return clampPanelWidth(width - step, windowWidth);
    case 'Home':
      return PANEL_MIN_WIDTH;
    case 'End':
      return maxPanelWidth(windowWidth);
    default:
      return null;
  }
}

/** Keeps a drag's pointer events on the handle, even over the preview's frame. */
function capture(element: HTMLElement, pointerId: number, on: boolean) {
  try {
    if (on) element.setPointerCapture(pointerId);
    else if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  } catch {
    // No such pointer (a synthetic event): the drag still follows the handle.
  }
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

/** The rendered width of an element, followed as it changes (null before it is measured). */
export function useMeasuredWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const value = Math.round(element.getBoundingClientRect().width);
      setWidth(value > 0 ? value : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/**
 * The docked panel's width. `custom` is false until the person resizes it
 * (the panel then keeps its responsive CSS default, and `measured` gives the
 * separator its value); a stored width is clamped to the current window, so
 * a narrower window never loses the conversation.
 */
export function usePanelWidth(measured: number | null = null) {
  const windowWidth = useWindowWidth();
  const [stored, setStored] = useState(readPanelWidth);
  const width =
    stored === null
      ? clampPanelWidth(measured ?? defaultPanelWidth(windowWidth), windowWidth)
      : clampPanelWidth(stored, windowWidth);
  const set = useCallback((next: number | null, persist = true) => {
    setStored(next);
    if (persist) writePanelWidth(next);
  }, []);
  return {
    width,
    custom: stored !== null,
    min: PANEL_MIN_WIDTH,
    max: maxPanelWidth(windowWidth),
    windowWidth,
    set,
  };
}

/**
 * The drag handle on the docked panel's left edge: a focusable vertical
 * separator. Drag it, or use the arrow keys (Shift for larger steps), Home
 * (narrowest) and End (widest); Enter or a double click restores the default.
 */
export function PanelResizeHandle({
  width,
  min,
  max,
  windowWidth,
  controls,
  onResize,
}: {
  width: number;
  min: number;
  max: number;
  windowWidth: number;
  /** The id of the panel it resizes. */
  controls?: string;
  /** null restores the default; `persist` false while a drag is still moving. */
  onResize: (width: number | null, persist?: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    capture(event.currentTarget, event.pointerId, true);
    drag.current = { x: event.clientX, width, last: width };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    start.last = clampPanelWidth(start.width + (start.x - event.clientX), windowWidth);
    onResize(start.last, false);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    drag.current = null;
    setDragging(false);
    capture(event.currentTarget, event.pointerId, false);
    // A click without movement changes nothing (and stores nothing).
    if (start.last !== start.width) onResize(start.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onResize(null);
      return;
    }
    const next = widthForKey(event.key, event.shiftKey, width, windowWidth);
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused or dragged; a focusable separator is the ARIA pattern for a splitter.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize artifact panel"
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${width} pixels wide`}
      title="Drag to resize; double-click to reset"
      tabIndex={0}
      data-panel-resize=""
      data-dragging={dragging ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onResize(null)}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 left-0 z-10 flex w-2 cursor-col-resize touch-none select-none justify-center focus-visible:outline-offset-[-2px]"
    >
      <span
        aria-hidden="true"
        className="my-auto h-10 w-1 rounded-full bg-[var(--border-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[dragging]:opacity-100"
      />
    </div>
  );
}
