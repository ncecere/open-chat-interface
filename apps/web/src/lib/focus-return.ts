/**
 * Where keyboard focus goes when the thing that had it closes or disappears
 * (WCAG 2.4.3 Focus Order, #41, #128).
 *
 * Dialogs return focus to their opener. Two kinds of opener escaped that:
 *
 * - An item in a Select or menu popup. Choosing it closes the popup in the
 *   same render that opens the dialog, so the item is gone (focus is on the
 *   body) by the time the dialog asks what was focused. The popup's trigger
 *   is the opener a person would expect, so it is remembered instead.
 * - A control in a row that the action removes (delete a memory or an
 *   attachment, archive a conversation). Focus then moves to the row that
 *   took its place, else the one before it, else the list's heading.
 */

/** Rows a removal can take focus to: list items, table rows, or opted-in rows. */
const ROW = 'li, tr, [role="row"], [data-focus-row]';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let lastFocused: { element: HTMLElement; fromPopup: boolean } | null = null;
let tracking = false;

const POPUP = '[role="listbox"][id], [role="menu"][id]';

/** The trigger of the open Select or menu popup that contains `element`. */
function popupTrigger(element: Element): HTMLElement | null {
  const popup = element.closest<HTMLElement>(POPUP);
  if (!popup) return null;
  const trigger = document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(popup.id)}"]`);
  // A listbox's own search box controls it too; that is not a trigger.
  return trigger && !popup.contains(trigger) ? trigger : null;
}

/**
 * Starts remembering the last focused element (once per page). A focus that
 * leaves for nothing (a click on the page) forgets it, unless it was a popup
 * item: removing a node does not report where focus went.
 */
export function trackFocus() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const trigger = popupTrigger(event.target);
    lastFocused = { element: trigger ?? event.target, fromPopup: trigger !== null };
  });
  document.addEventListener('focusout', (event) => {
    if (event.relatedTarget === null && !lastFocused?.fromPopup) lastFocused = null;
  });
}

/** The element a dialog opening now should give focus back to. */
export function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    if (!active.closest(POPUP)) return active;
    // A closing popup drops its trigger's aria-controls before it leaves the
    // page, so use the trigger noted when focus entered the popup.
    const remembered = lastFocused?.fromPopup ? lastFocused.element : null;
    return popupTrigger(active) ?? remembered ?? active;
  }
  return lastFocused?.element.isConnected ? lastFocused.element : null;
}

export interface FocusPlace {
  element: HTMLElement;
  next: Element | null;
  previous: Element | null;
  ancestors: HTMLElement[];
  /**
   * Where focus goes when no row is left, before the section's heading: the
   * message box after a composer's last attachment chip (#250).
   */
  fallback?: HTMLElement | null;
}

/** Notes what surrounds `element`, to find a new place if it is removed. */
export function rememberPlace(element: HTMLElement): FocusPlace {
  const row = element.closest(ROW);
  const ancestors: HTMLElement[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) ancestors.push(node);
  return {
    element,
    next: row?.nextElementSibling ?? null,
    previous: row?.previousElementSibling ?? null,
    ancestors,
  };
}

/**
 * The place for `element` (a bulk action's button) when the `removing` rows
 * of one list are about to go: the row that takes the first one's place, else
 * the last one before them, else the section's heading (#189). The rows next
 * to the control itself would be no use: the control is not in the list.
 */
export function placeBesideRows(element: HTMLElement, removing: readonly Element[]): FocusPlace {
  const place = rememberPlace(element);
  const list = removing[0]?.parentElement;
  if (!list) return place;
  const rows = [...list.children];
  const gone = new Set(removing);
  const first = Math.min(...removing.map((row) => rows.indexOf(row)).filter((index) => index >= 0));
  return {
    ...place,
    next: rows.slice(first + 1).find((row) => !gone.has(row)) ?? null,
    previous:
      rows
        .slice(0, first)
        .reverse()
        .find((row) => !gone.has(row)) ?? null,
  };
}

function focusRow(row: Element | null): boolean {
  if (!(row instanceof HTMLElement) || !row.isConnected) return false;
  const target = row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE);
  if (target) {
    target.focus();
  } else {
    row.tabIndex = -1;
    row.focus();
  }
  return document.activeElement !== document.body;
}

/**
 * Focuses `place`'s element if it is still on the page, else the row after
 * its row, the row before, or the heading of the nearest surviving section.
 * Returns whether focus landed somewhere.
 */
export function focusPlace(place: FocusPlace): boolean {
  if (place.element.isConnected) {
    place.element.focus();
    if (document.activeElement === place.element) return true;
  }
  if (focusRow(place.next) || focusRow(place.previous)) return true;
  if (place.fallback?.isConnected) {
    place.fallback.focus();
    if (document.activeElement === place.fallback) return true;
  }
  const container = place.ancestors.find((ancestor) => ancestor.isConnected);
  const landmark = container?.closest<HTMLElement>('section, main, [role="dialog"], body');
  const heading = landmark?.querySelector<HTMLElement>('h1, h2, h3') ?? null;
  if (!heading) return false;
  if (!heading.matches(FOCUSABLE)) heading.tabIndex = -1;
  heading.focus();
  return document.activeElement === heading;
}

const WATCH_MS = 15_000;

/**
 * If `element` (a control, or a whole row) is removed while focus is in it,
 * moves focus to `place` instead of leaving it on the body. Stops when focus
 * moves elsewhere or after a while.
 */
export function keepFocusWhenRemoved(element: HTMLElement, place = rememberPlace(element)) {
  if (typeof MutationObserver === 'undefined') return;
  const stop = () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocus);
    window.clearTimeout(timeout);
  };
  const observer = new MutationObserver(() => {
    if (element.isConnected) return;
    stop();
    // Something else already took focus (a component's own handling): leave it.
    if (document.activeElement && document.activeElement !== document.body) return;
    focusPlace({ ...place, element });
  });
  const onFocus = (event: FocusEvent) => {
    if (!(event.target instanceof Node) || !element.contains(event.target)) stop();
  };
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('focusin', onFocus);
  const timeout = window.setTimeout(stop, WATCH_MS);
}
