// @vitest-environment happy-dom
import { act, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '../../src/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../src/components/ui/dropdown-menu';
import { Select } from '../../src/components/ui/select';

/**
 * #172: a modal menu, Select popup or dialog hides the rest of the page with
 * aria-hidden; what it hides must not stay focusable (axe aria-hidden-focus).
 * Real Radix components; the page is a skip link, a sidebar and messages.
 */
const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

function Page({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main-content">Skip to main content</a>
      <aside>
        <button type="button">Archive thread</button>
      </aside>
      <main id="main-content">
        <p>
          A message citing <a href="https://example.edu">the course page</a>.
        </p>
        {children}
      </main>
    </>
  );
}

async function press(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Focusable elements inside aria-hidden content that is not inert. */
function hiddenButFocusable(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
    .flatMap((hidden) => [...hidden.querySelectorAll<HTMLElement>(FOCUSABLE)])
    .filter((element) => !element.closest('[inert]'))
    .map((element) => element.textContent ?? element.outerHTML);
}

async function expectHiddenPageInert(open: () => Promise<void>) {
  await open();
  const hidden = document.querySelectorAll('[data-aria-hidden]');
  expect(hidden.length, 'the page is hidden while open').toBeGreaterThan(0);
  expect(hiddenButFocusable()).toEqual([]);

  await press('Escape');
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  // Radix's own marker for what it hid (icons keep their own aria-hidden).
  expect(document.querySelectorAll('[data-aria-hidden]').length).toBe(0);
  expect(document.querySelectorAll('[inert]').length, 'inert is lifted on close').toBe(0);
}

it('makes the page inert behind a modal menu', async () => {
  await act(async () =>
    root.render(
      <Page>
        <DropdownMenu>
          <DropdownMenuTrigger>Appearance settings</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Dark</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Page>,
    ),
  );
  await expectHiddenPageInert(async () => {
    const trigger = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Appearance settings',
    )!;
    trigger.focus();
    await press('Enter');
  });
});

it('makes the page inert behind a Select popup', async () => {
  await act(async () =>
    root.render(
      <Page>
        <Select
          aria-label="Role for ada@example.test"
          value="user"
          onChange={() => undefined}
          options={[
            { value: 'user', label: 'User' },
            { value: 'admin', label: 'Admin' },
          ]}
        />
      </Page>,
    ),
  );
  await expectHiddenPageInert(async () => {
    container.querySelector<HTMLElement>('[aria-label="Role for ada@example.test"]')!.focus();
    await press('Enter');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
});

it('makes the page inert behind a dialog, and leaves inert it did not add', async () => {
  function WithDialog() {
    const [open, setOpen] = useState(false);
    return (
      <Page>
        <div inert>Already inert</div>
        <button type="button" onClick={() => setOpen(true)}>
          Rename
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Rename</DialogTitle>
          </DialogContent>
        </Dialog>
      </Page>
    );
  }
  await act(async () => root.render(<WithDialog />));
  await act(async () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Rename')!.click(),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(hiddenButFocusable()).toEqual([]);
  await press('Escape');
  expect(document.querySelectorAll('[inert]').length).toBe(1);
  expect(document.querySelector('[inert]')?.textContent).toBe('Already inert');
});
