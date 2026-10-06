import type { KeyboardEvent } from 'react';

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab reaches inside `container`, in order. */
function tabbables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.closest('[inert]') &&
      // Hidden at this width (`hidden lg:block`) or collapsed: not a Tab stop.
      (typeof element.checkVisibility !== 'function' || element.checkVisibility()),
  );
}

/**
 * Keeps Tab and Shift+Tab inside a modal that is not a Radix dialog (the
 * phone sidebar drawer, #191): from its last control Tab goes to its first,
 * and from its first Shift+Tab goes to its last, as Radix's dialogs do,
 * instead of leaving for the page behind it or the browser's own controls.
 */
export function loopTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  const stops = tabbables(event.currentTarget);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
