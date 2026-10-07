// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ThemeMenu } from '../../src/components/layout/theme-menu';
import { ThemeProvider } from '../../src/providers/theme-provider';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

it('announces the current theme as the checked choice (#92)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.setItem('theme', 'dark');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <ThemeProvider>
        <ThemeMenu />
      </ThemeProvider>,
    ),
  );
  const open = async () =>
    act(async () => {
      container
        .querySelector('button[aria-label="Appearance settings"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
  const checked = () =>
    [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter((item) => item.getAttribute('aria-checked') === 'true')
      .map((item) => item.textContent);

  await open();
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(3);
  const current = checked();
  expect(current).toHaveLength(1);

  const light = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent === 'Light',
  )!;
  await act(async () => light.click());
  await open();
  expect(checked()).toEqual(['Light']);
  await act(() => root.unmount());
  container.remove();
});
