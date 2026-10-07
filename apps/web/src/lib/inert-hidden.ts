/**
 * Content a modal hides from assistive technology is also taken out of the
 * keyboard order (#172).
 *
 * Radix's modal dialogs, menus and Select popups mark everything else on the
 * page `aria-hidden` (through the aria-hidden package, which also sets
 * `data-aria-hidden`), but leave it focusable: axe's aria-hidden-focus, as
 * the skip link, sidebar, header and messages could still take focus while
 * hidden. Native modals make the rest of the page inert; this does the same
 * for Radix's, for exactly as long as it hides it, and leaves alone any
 * `inert` it did not add.
 */

const HIDDEN = 'data-aria-hidden';
const OURS = 'data-oci-inert';

function sync(element: Element) {
  if (element.hasAttribute(HIDDEN)) {
    if (element.hasAttribute('inert')) return;
    element.setAttribute('inert', '');
    element.setAttribute(OURS, '');
  } else if (element.hasAttribute(OURS)) {
    element.removeAttribute('inert');
    element.removeAttribute(OURS);
  }
}

let installed = false;

/** Starts mirroring Radix's hiding as `inert` (once per page). */
export function keepHiddenContentInert() {
  if (installed || typeof MutationObserver === 'undefined' || typeof document === 'undefined')
    return;
  installed = true;
  const observer = new MutationObserver((records) => {
    for (const record of records) if (record.target instanceof Element) sync(record.target);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [HIDDEN],
    subtree: true,
  });
}
