// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RevealWhenLoaded } from '../../src/components/ui/reveal-when-loaded';

function Section({ release }: { release: Promise<string> }) {
  const { data } = useQuery({ queryKey: ['walk-section'], queryFn: () => release });
  return <p>{data ?? 'loading section'}</p>;
}

const frames = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

it('lays a page out hidden until its first data is in, then shows it for good (#104)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let finish!: (value: string) => void;
  const release = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const client = new QueryClient();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RevealWhenLoaded resetKey="/admin/health">
          <Section release={release} />
        </RevealWhenLoaded>
      </QueryClientProvider>,
    ),
  );
  await frames();
  const wrapper = container.firstElementChild as HTMLElement;
  // Laid out (in the DOM) but not shown, with a spinner announced instead.
  expect(wrapper.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('.invisible')?.textContent).toBe('loading section');
  expect(container.querySelector('[role="status"]')).not.toBeNull();

  await act(async () => finish('Walk health checks'));
  await frames();
  expect(wrapper.getAttribute('aria-busy')).toBe('false');
  expect(container.querySelector('.invisible')).toBeNull();
  expect(container.textContent).toContain('Walk health checks');

  // A refetch afterwards does not hide it again.
  await act(async () => {
    void client.refetchQueries({ queryKey: ['walk-section'] });
  });
  await frames();
  expect(container.querySelector('.invisible')).toBeNull();
  await act(() => root.unmount());
  container.remove();
});

it('shows the page after three seconds however slow a request is', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient();
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RevealWhenLoaded resetKey="/admin/roles">
          <Section release={new Promise(() => {})} />
        </RevealWhenLoaded>
      </QueryClientProvider>,
    ),
  );
  expect(container.querySelector('.invisible')).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_100);
  });
  expect(container.querySelector('.invisible')).toBeNull();
  await act(() => root.unmount());
  vi.useRealTimers();
});
