// @vitest-environment happy-dom
import type { MaintenanceSettings } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaintenanceMode } from '../../src/components/admin/maintenance-mode';
import { setReadOnlyStatus } from '../../src/lib/read-only';
import {
  button,
  cleanup,
  click,
  findButton,
  pressEscape,
  renderAdmin,
  settle,
  typeInto,
} from './admin-test-utils';

/**
 * #356: "Turn on read-only mode" asked for confirmation inline, with the same
 * button turning red and taking the focus: Enter twice refused every change
 * for every user, Escape did nothing, and Cancel dropped focus to <body>, so
 * the next Tab started at the skip link. It now asks like a destructive
 * dialog: focus on Cancel, Escape closes, focus returns to the button.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const OFF = { active: false, source: null, reason: null, until: null, window: null } as const;
const SETTINGS: MaintenanceSettings = {
  status: OFF,
  environmentLocked: false,
  readOnly: false,
  reason: null,
  until: null,
  changedAt: null,
  changedBy: null,
  window: null,
  jobs: [],
};

let root: Root | undefined;
beforeEach(() => {
  setReadOnlyStatus(OFF);
  api.get.mockReset();
  api.put.mockReset();
  api.get.mockResolvedValue(SETTINGS);
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const CONFIRM = 'Confirm: refuse every change now';
const reasonInput = () => document.querySelector<HTMLInputElement>('input[id$="-reason"]')!;

/** Focuses the button as a keyboard user does, then presses it. */
async function ask() {
  ({ root } = await renderAdmin(<MaintenanceMode />));
  const trigger = button('Turn on read-only mode');
  await act(async () => trigger.focus());
  await click(trigger);
  return trigger;
}

it('puts focus on Cancel, the safe choice, not on the red Confirm button', async () => {
  await ask();
  expect(document.activeElement).toBe(button('Cancel'));
  expect(document.activeElement).not.toBe(button(CONFIRM));
  expect(api.put).not.toHaveBeenCalled();
});

it('closes on Escape and returns focus to the button that asked', async () => {
  const trigger = await ask();
  await pressEscape();
  expect(findButton(CONFIRM)).toBeUndefined();
  expect(document.activeElement).toBe(trigger);
  expect(api.put).not.toHaveBeenCalled();
});

it('returns focus to the button when Cancel is pressed, not to <body>', async () => {
  const trigger = await ask();
  // As a keyboard user gets there: Tab to Cancel, then Enter.
  await act(async () => button('Cancel').focus());
  await click(button('Cancel'));
  expect(findButton(CONFIRM)).toBeUndefined();
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement).toBe(trigger);
  expect(api.put).not.toHaveBeenCalled();
});

it('announces what is being confirmed with the group the buttons are in', async () => {
  await ask();
  const group = button('Cancel').closest('fieldset');
  expect(group?.querySelector('legend')?.textContent).toBe('Confirm read-only mode');
  expect(group?.textContent).toContain('Every change is refused until it is turned off');
});

it('leaves focus in a field when Escape is pressed there, and still closes the question', async () => {
  await ask();
  const reason = reasonInput();
  await act(async () => reason.focus());
  await pressEscape();
  expect(findButton(CONFIRM)).toBeUndefined();
  expect(document.activeElement).toBe(reason);
});

it('does not turn it on when Enter submits the form from a field while asking', async () => {
  await ask();
  await typeInto(reasonInput(), 'Upgrading');
  await act(async () => {
    reasonInput().form?.requestSubmit();
  });
  await settle();
  expect(api.put).not.toHaveBeenCalled();
  expect(findButton(CONFIRM)).toBeDefined();
});

it('turns it on once, only from the Confirm button', async () => {
  api.put.mockResolvedValue({
    ...SETTINGS,
    readOnly: true,
    status: { ...OFF, active: true, source: 'administrator' },
  });
  await ask();
  await click(button(CONFIRM));
  expect(api.put).toHaveBeenCalledTimes(1);
  expect(api.put.mock.calls[0]?.[1]).toMatchObject({ readOnly: true });
});
