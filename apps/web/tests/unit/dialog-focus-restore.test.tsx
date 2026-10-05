// @vitest-environment happy-dom
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../src/components/ui/dialog';
import { button, cleanup, dialog, pressEscape, renderAdmin, settle } from './admin-test-utils';

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/**
 * Two state-opened dialogs, like the chat top bar's Rename and Share. Neither
 * uses a DialogTrigger, so Radix has no trigger to give focus back to.
 */
function Harness() {
  const [open, setOpen] = useState<'rename' | 'share' | null>(null);
  return (
    <>
      <button type="button">Focused at load</button>
      <button type="button" onClick={() => setOpen('rename')}>
        Rename
      </button>
      <button type="button" onClick={() => setOpen('share')}>
        Share
      </button>
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent>
          <DialogTitle>{open === 'share' ? 'Share' : 'Rename'} conversation</DialogTitle>
          <DialogDescription>Walk dialog</DialogDescription>
          <input aria-label="Title" />
        </DialogContent>
      </Dialog>
    </>
  );
}

async function openWith(name: string) {
  const opener = button(name);
  await act(async () => {
    opener.focus();
    opener.click();
  });
  await settle();
  expect(dialog()).not.toBeNull();
  expect(dialog()?.contains(document.activeElement)).toBe(true);
  return opener;
}

it('returns focus to the button that opened the dialog when Escape closes it', async () => {
  ({ root } = await renderAdmin(<Harness />));
  // Focus something else first: the old code remembered whatever was focused
  // when the component mounted, not when the dialog opened.
  await act(async () => button('Focused at load').focus());

  const rename = await openWith('Rename');
  await pressEscape();

  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(rename);
});

it('remembers the opener afresh on every open', async () => {
  ({ root } = await renderAdmin(<Harness />));

  const rename = await openWith('Rename');
  await pressEscape();
  expect(document.activeElement).toBe(rename);

  const share = await openWith('Share');
  await pressEscape();
  expect(document.activeElement).toBe(share);
});

it('returns focus to the opener when the Close button closes the dialog', async () => {
  ({ root } = await renderAdmin(<Harness />));

  const share = await openWith('Share');
  const close = dialog()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  expect(close).toBeTruthy();
  await act(async () => close?.click());
  await settle();

  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(share);
});
