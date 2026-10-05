const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keeps Tab inside a full-screen panel: everything else is inert, so tabbing
 * past either end (including out of a preview's frame, whose key presses the
 * page never sees) lands here and is sent round to the other end.
 */
export function FocusGuard({ to }: { to: 'first' | 'last' }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a focus guard only passes focus on.
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focus guard must be reachable by Tab.
      tabIndex={0}
      data-focus-guard={to}
      className="pointer-events-none fixed size-px overflow-hidden opacity-0"
      onFocus={(event) => {
        const panel = event.currentTarget.closest('[data-artifact-panel]');
        const items = [...(panel?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])].filter(
          (item) => !item.hasAttribute('data-focus-guard'),
        );
        (to === 'first' ? items[0] : items.at(-1))?.focus();
      }}
    />
  );
}

/**
 * Makes everything outside `element` inert (the way a modal dialog does),
 * except live regions such as notifications, and returns how to undo it.
 * Elements that were already inert are left alone.
 */
export function inertOthers(element: HTMLElement): () => void {
  const changed: Element[] = [];
  let node: Element = element;
  while (node.parentElement && node !== document.body) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling.hasAttribute('inert')) continue;
      if (sibling.hasAttribute('aria-live') || /^(SCRIPT|STYLE|TEMPLATE)$/.test(sibling.tagName))
        continue;
      sibling.setAttribute('inert', '');
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const sibling of changed) sibling.removeAttribute('inert');
  };
}
