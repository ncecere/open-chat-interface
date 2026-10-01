import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** Renders admin UI inside a fresh query client that never retries. */
export async function renderAdmin(ui: ReactNode): Promise<{ root: Root; container: HTMLElement }> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  );
  await settle();
  return { root, container };
}

/** Lets pending promises, query updates and React commits finish. */
export async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** Dialogs portal to the body, so every lookup searches the whole document. */
export function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named "${name}"`);
  return match;
}

export async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

export function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

export function alerts(scope: ParentNode = document): string[] {
  return [...scope.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? '');
}

export async function pressEscape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await settle();
}

export async function cleanup(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
}
