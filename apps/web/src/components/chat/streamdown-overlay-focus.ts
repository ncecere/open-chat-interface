import {
  nameStreamdownControls,
  nameTableFullscreen,
} from '~/components/chat/streamdown-control-names';

/**
 * Focus management for Streamdown's table full-screen view (WCAG 2.4.3).
 *
 * Streamdown portals the view straight into <body> as
 * `<div role="dialog" aria-modal="true" data-streamdown="table-fullscreen">`,
 * but leaves focus on the button that opened it, lets Tab walk out to the page
 * behind, and does not hand focus back on close. It offers no prop to change
 * that (its `controls` option can only remove the button), so this watches for
 * the overlay instead of patching the library:
 *
 * - on open, focus moves to the overlay itself (so it is announced);
 * - Tab and Shift+Tab cycle through the overlay's controls only;
 * - on close, focus returns to the element that had it when the overlay opened;
 * - Escape closes it from anywhere inside (#155). Streamdown listens for
 *   Escape on the document, but its inner wrapper stops every keydown from
 *   bubbling, so once focus was on a control or link inside (which the Tab
 *   trap makes the usual case) Escape did nothing. This listener is on the
 *   overlay itself, below that wrapper's React handler, and closes the view
 *   the way a click on its backdrop does;
 * - it is named for what it shows ("Table 1, full screen"), not for the
 *   button that opened it, and so are its controls (#246).
 */

const OVERLAY_SELECTOR = '[data-streamdown="table-fullscreen"]';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let observer: MutationObserver | null = null;

export function installStreamdownOverlayFocus(doc: Document = document): void {
  if (observer || typeof MutationObserver === 'undefined' || !doc.body) return;

  const openers = new WeakMap<HTMLElement, HTMLElement | null>();

  const trapTab = (overlay: HTMLElement) => (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      event.preventDefault();
      overlay.focus();
      return;
    }
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || active === overlay)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const opened = (overlay: HTMLElement) => {
    const active = doc.activeElement;
    openers.set(
      overlay,
      active instanceof HTMLElement && active !== doc.body && !overlay.contains(active)
        ? active
        : null,
    );
    if (!overlay.hasAttribute('tabindex')) overlay.setAttribute('tabindex', '-1');
    // The view and its toolbar, named for the table that opened it (#246).
    nameTableFullscreen(overlay, openers.get(overlay) ?? null);
    overlay.addEventListener('keydown', trapTab(overlay));
    overlay.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Streamdown closes the view on a click whose target is the backdrop.
      overlay.click();
    });
    overlay.focus();
  };

  const closed = (overlay: HTMLElement) => {
    const opener = openers.get(overlay);
    openers.delete(overlay);
    // Only take focus back if it was lost with the overlay, not if something
    // else (a dialog the overlay opened, say) already has it.
    const active = doc.activeElement;
    const lost = !active || active === doc.body || !active.isConnected;
    if (opener?.isConnected && lost) opener.focus();
  };

  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.matches(OVERLAY_SELECTOR)) opened(node);
      }
      for (const node of record.removedNodes) {
        if (node instanceof HTMLElement && openers.has(node)) closed(node);
      }
    }
  });
  observer.observe(doc.body, { childList: true });
}

/** For tests: stops watching so a fresh document can install again. */
export function uninstallStreamdownOverlayFocus(): void {
  observer?.disconnect();
  observer = null;
}

/**
 * Streamdown's tables and code blocks scroll sideways inside their own
 * containers, which Safari and Firefox keyboard users cannot reach unless the
 * container can take focus (WCAG 2.1.1, axe scrollable-region-focusable).
 * Each one is named and made focusable as it appears; scans are batched to one
 * per frame so a streaming reply does not trigger one per token.
 */
const SCROLL_REGIONS: Array<[selector: string, label: string]> = [
  ['[data-streamdown="table-wrapper"] > .overflow-x-auto:not([tabindex])', 'Table'],
  ['[data-streamdown="code-block-body"]:not([tabindex])', 'Code block'],
];
let regionObserver: MutationObserver | null = null;

export function markStreamdownScrollRegions(root: ParentNode = document): void {
  for (const [selector, label] of SCROLL_REGIONS) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      element.tabIndex = 0;
      element.setAttribute('role', 'region');
      element.setAttribute('aria-label', label);
    }
  }
  // Then each region and button is named for its block (#194).
  nameStreamdownControls(root);
}

export function installStreamdownScrollRegions(doc: Document = document): void {
  if (regionObserver || typeof MutationObserver === 'undefined' || !doc.body) return;
  let scheduled = false;
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (run: () => void) => setTimeout(run, 0);
  regionObserver = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      markStreamdownScrollRegions(doc);
    });
  });
  regionObserver.observe(doc.body, { childList: true, subtree: true });
  markStreamdownScrollRegions(doc);
}

/** For tests. */
export function uninstallStreamdownScrollRegions(): void {
  regionObserver?.disconnect();
  regionObserver = null;
}
