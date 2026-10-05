// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  installStreamdownOverlayFocus,
  uninstallStreamdownOverlayFocus,
} from '../../src/components/chat/streamdown-overlay-focus';

const TABLE = ['| Name | Quota |', '| --- | --- |', '| Walk A | 5 TB |', '| Walk B | 1 TB |'].join(
  '\n',
);

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
