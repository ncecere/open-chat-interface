// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nameStreamdownControls } from '../../src/components/chat/streamdown-control-names';
import {
  installStreamdownOverlayFocus,
  uninstallStreamdownOverlayFocus,
} from '../../src/components/chat/streamdown-overlay-focus';

const TABLE = [
  '| Name | Quota |',
  '| --- | --- |',
  '| [Walk A](https://example.com/a) | 5 TB |',
  '| Walk B | 1 TB |',
].join('\n');

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installStreamdownOverlayFocus();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Streamdown mode="static">{TABLE}</Streamdown>));
  await vi.waitFor(() => expect(container.querySelector('table')).not.toBeNull());
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  uninstallStreamdownOverlayFocus();
});

/** Streamdown's own "View fullscreen" button for the table. */
function fullscreenButton(): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (button) => button.title === 'View fullscreen',
  );
  if (!match) throw new Error('No "View fullscreen" button');
  return match;
}

const overlay = () => document.querySelector<HTMLElement>('[data-streamdown="table-fullscreen"]');
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function openOverlay() {
  const trigger = fullscreenButton();
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  await flush();
  expect(overlay()).not.toBeNull();
  return trigger;
}

function pressTab(shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.activeElement?.dispatchEvent(event);
  return event;
}

it('moves focus into the full-screen table when it opens', async () => {
  await openOverlay();
  expect(document.activeElement).toBe(overlay());
});

it('keeps Tab inside the full-screen table', async () => {
  await openOverlay();
  const controls = [...(overlay()?.querySelectorAll<HTMLElement>('button') ?? [])];
  expect(controls.length).toBeGreaterThan(0);

  // From the last control, Tab wraps to the first instead of reaching the page.
  controls.at(-1)?.focus();
  expect(pressTab().defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls[0]);

  // From the first, Shift+Tab wraps to the last.
  expect(pressTab(true).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls.at(-1));
});

it('returns focus to the View fullscreen button when it closes', async () => {
  const trigger = await openOverlay();
  const exit = [...(overlay()?.querySelectorAll('button') ?? [])].find(
    (button) => button.title === 'Exit fullscreen',
  );
  expect(exit).toBeTruthy();

  // A keyboard user closes it from inside: focus is on Exit fullscreen, which
  // disappears with the overlay.
  await act(async () => {
    exit?.focus();
    exit?.click();
  });
  await flush();

  expect(overlay()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it.each([
  ['the overlay', () => overlay()],
  ['Copy table', () => overlay()?.querySelector<HTMLElement>('button') ?? null],
  [
    'a link in a cell',
    () =>
      overlay()?.querySelector<HTMLElement>('table a[href], table [data-streamdown="link"]') ??
      null,
  ],
])('closes on Escape with focus on %s, and gives focus back (#155)', async (_name, target) => {
  const trigger = await openOverlay();
  const focused = target();
  expect(focused).toBeTruthy();
  await act(async () => {
    focused?.focus();
    focused?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await flush();
  expect(overlay()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('is named for the table it shows, not for the button that opened it (#155)', async () => {
  await openOverlay();
  expect(overlay()?.getAttribute('aria-label')).toBe('Table, full screen');
});

/**
 * #246: the full-screen view's toolbar was named only by `title` ("Copy
 * table", "Download table", "Exit fullscreen"), unlike the table's own
 * controls ("Copy table 1"), and every control was 22 px square.
 */
it('names its controls for the table that opened it, as the table names its own', async () => {
  nameStreamdownControls(container);
  expect(fullscreenButton().getAttribute('aria-label')).toBe('View table 1 full screen');
  await openOverlay();
  expect(overlay()?.getAttribute('aria-label')).toBe('Table 1, full screen');
  // The toolbar's buttons; a link in a cell is a button too.
  const names = [...overlay()!.querySelectorAll('button[title]')].map((button) =>
    button.getAttribute('aria-label'),
  );
  expect(names).toEqual(['Copy table 1', 'Download table 1', 'Exit full screen']);
});

it('makes every table control at least 24 px square, inline and full screen', async () => {
  // The app's own stylesheet, as written: its plain rules, minus Tailwind's.
  const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rules = [...css.matchAll(/^([^@{}\n][^{}]*)\{([^{}]*)\}/gm)];
  const minimum = (button: Element, property: 'min-width' | 'min-height') => {
    let px = 0;
    for (const [, selector, body] of rules) {
      const matches = (part: string) => {
        try {
          return button.matches(part.trim());
        } catch {
          return false; // A pseudo-element or a keyframe step: not a selector for elements.
        }
      };
      if (!selector!.split(',').some(matches)) continue;
      const value = body!.match(new RegExp(`${property}:\\s*([\\d.]+)(rem|px)`));
      if (value) px = Number(value[1]) * (value[2] === 'rem' ? 16 : 1);
    }
    return px;
  };
  await openOverlay();
  const buttons = [
    ...container.querySelectorAll('[data-streamdown="table-wrapper"] button[title]'),
    ...overlay()!.querySelectorAll('button[title]'),
  ];
  expect(buttons).toHaveLength(6);
  for (const button of buttons) {
    expect(minimum(button, 'min-width'), button.getAttribute('title')!).toBeGreaterThanOrEqual(24);
    expect(minimum(button, 'min-height'), button.getAttribute('title')!).toBeGreaterThanOrEqual(24);
  }
});
