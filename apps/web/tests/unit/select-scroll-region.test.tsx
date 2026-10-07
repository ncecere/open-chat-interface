// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Select } from '../../src/components/ui/select';
import { styleFor } from './css-test-utils';

/**
 * #274: a Select long enough to scroll (the audit log's 40+ actions) failed
 * axe scrollable-region-focusable: Radix scrolled its viewport, a
 * presentational div with nothing in the tab order inside (options take
 * focus with tabindex -1). The listbox itself now scrolls and is in the tab
 * order. The real Select opened from the keyboard; its classes compiled by
 * the project's Tailwind, since happy-dom does no layout.
 */

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

const ACTIONS = Array.from({ length: 45 }, (_, index) => ({
  value: `action.${index}`,
  label: `Action ${index}`,
}));

/** The scrolling the element's own classes and inline style give it. */
async function overflowOf(element: HTMLElement) {
  const fromClasses = await styleFor(element.getAttribute('class') ?? '');
  return {
    overflowY: element.style.overflowY || element.style.overflow || fromClasses['overflow-y'],
    maxHeight: fromClasses['max-height'],
  };
}

it('scrolls a long list in the listbox, which is in the tab order', async () => {
  await act(async () =>
    root.render(
      <Select
        aria-label="Filter audit events by action"
        value="action.0"
        onChange={() => undefined}
        options={ACTIONS}
      />,
    ),
  );
  const trigger = container.querySelector<HTMLElement>('button[role="combobox"]')!;
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
  expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(45);
  // The scrolling region is focusable in the tab order.
  expect(await overflowOf(listbox)).toEqual({
    overflowY: 'auto',
    maxHeight: 'calc(var(--spacing) * 72)',
  });
  expect(listbox.tabIndex).toBe(0);
  // And nothing inside it scrolls instead: Radix's viewport is presentational.
  const viewport = listbox.querySelector<HTMLElement>('[data-radix-select-viewport]')!;
  expect(viewport.getAttribute('role')).toBe('presentation');
  expect((await overflowOf(viewport)).overflowY).toBe('visible');
  expect(viewport.hasAttribute('tabindex')).toBe(false);
});
