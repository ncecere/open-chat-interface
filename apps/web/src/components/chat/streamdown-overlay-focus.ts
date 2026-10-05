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
 * - on close, focus returns to the element that had it when the overlay opened.
 *
 * Escape is still handled by Streamdown.
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
    overlay.addEventListener('keydown', trapTab(overlay));
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
