// @vitest-environment happy-dom
import { useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/components/admin/confirm-dialog';
import { ApiError } from '../../src/lib/api-client';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  pressEscape,
  renderAdmin,
  settle,
} from './admin-test-utils';

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

function Harness({ onConfirm }: { onConfirm: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete Widget?"
        description="This action cannot be undone."
        confirmLabel="Delete widget"
        pendingLabel="Deleting…"
        errorMessage="The widget could not be deleted."
        onConfirm={onConfirm}
      />
    </>
  );
}

async function openHarness(onConfirm: () => Promise<unknown>) {
  ({ root } = await renderAdmin(<Harness onConfirm={onConfirm} />));
  await click(button('Open'));
  expect(dialog()?.textContent).toContain('Delete Widget?');
}

it('opens with focus on Cancel and does nothing when cancelled', async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  await openHarness(onConfirm);
  expect(document.activeElement?.textContent?.trim()).toBe('Cancel');

  await click(button('Cancel'));
  expect(dialog()).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});

it('dismisses with Escape without running the action', async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  await openHarness(onConfirm);
  await pressEscape();
  expect(dialog()).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});

it('runs the action once and closes on success', async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  await openHarness(onConfirm);
  await click(button('Delete widget'));
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(dialog()).toBeNull();
});

it('stays open while pending and ignores Escape until the action settles', async () => {
  let finish!: () => void;
  const onConfirm = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await openHarness(onConfirm);
  await click(button('Delete widget'));

  expect(button('Deleting…').disabled).toBe(true);
  // Cancel has focus (Radix's first button), so it keeps it, marked
  // aria-disabled rather than disabled, and a press does nothing (#269).
  expect(document.activeElement).toBe(button('Cancel'));
  expect(button('Cancel').getAttribute('aria-disabled')).toBe('true');
  await click(button('Cancel'));
  expect(dialog()).not.toBeNull();
  await pressEscape();
  expect(dialog()).not.toBeNull();

  finish();
  await settle();
  expect(dialog()).toBeNull();
});

it('keeps the dialog open with the error on failure, then clears it on retry', async () => {
  const onConfirm = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'The widget is still in use.'))
    .mockResolvedValueOnce(undefined);
  await openHarness(onConfirm);

  await click(button('Delete widget'));
  const open = dialog();
  expect(open).not.toBeNull();
  expect(alerts(open!)).toEqual(['The widget could not be deleted. The widget is still in use.']);
  expect(button('Delete widget').disabled).toBe(false);

  await click(button('Delete widget'));
  expect(onConfirm).toHaveBeenCalledTimes(2);
  expect(dialog()).toBeNull();
  expect(alerts()).toEqual([]);
});

it('does not show a stale error after being cancelled and reopened', async () => {
  const onConfirm = vi.fn().mockRejectedValue(new Error('network down'));
  await openHarness(onConfirm);
  await click(button('Delete widget'));
  expect(alerts(dialog()!)).toEqual(['The widget could not be deleted.']);

  await click(button('Cancel'));
  await click(button('Open'));
  expect(alerts()).toEqual([]);
});
