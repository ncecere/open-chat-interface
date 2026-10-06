// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { IntroductionWizard } from '../../src/components/onboarding/introduction-wizard';

const post = vi.hoisted(() => vi.fn(async (_path: string, _body?: unknown) => ({ ok: true })));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api: { post },
}));

/**
 * At 390px the card was centred, so its top edge and Back/Continue moved
 * between steps of different heights (126 → 124 → 90 px); measured in a
 * browser after the change, both stay put. Here: the rules that keep them so.
 */
it('keeps the card still between steps on phones, without a prefilled-looking name (#107)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntroductionWizard />
      </QueryClientProvider>,
    ),
  );
  const page = container.firstElementChild as HTMLElement;
  // Top-aligned on phones, centred from md up.
  expect(page.className).toContain('items-start');
  expect(page.className).toContain('md:items-center');
  // One height for every step on phones, the answers' panel taking the rest.
  const grid = page.querySelector('.grid') as HTMLElement;
  expect(grid.className).toContain('min-h-[calc(100dvh-5rem)]');
  expect(grid.className).toContain('grid-rows-[auto_1fr]');
  const name = container.querySelector<HTMLInputElement>('#wizard-name');
  expect(name?.placeholder).toBe('Your first name');
  await act(() => root.unmount());
});

it('refreshes /me on finishing, so the home page greets by the name just given (#315)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient();
  client.setQueryData(['me'], { user: { name: 'Walk7 Newcomer' }, preferences: {} });
  client.setQueryData(['me', 'onboarding'], { needsIntroduction: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <IntroductionWizard />
      </QueryClientProvider>,
    ),
  );
  const name = container.querySelector<HTMLInputElement>('#wizard-name')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(name, 'Newt');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const press = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
    await act(async () => button.click());
  };
  await press('Continue');
  await press('Continue');
  await press('Finish');
  expect(post).toHaveBeenCalledWith(
    '/me/onboarding/complete',
    expect.objectContaining({ displayName: 'Newt' }),
  );
  expect(client.getQueryState(['me'])?.isInvalidated).toBe(true);
  expect(client.getQueryState(['me', 'onboarding'])?.isInvalidated).toBe(true);
  await act(() => root.unmount());
});
