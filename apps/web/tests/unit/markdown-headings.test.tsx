// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Markdown } from '../../src/components/chat/markdown';

/**
 * Headings in replies (#212), through the real Streamdown renderer: the
 * page's title is its one h1, so a reply's "# Title" is an h2, and so on
 * down, at the size the Markdown level had.
 */
it('renders Markdown headings one level below the page title, at their usual size', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <Markdown>
        {'# Ten Facts About Owls\n\n## Hunting\n\n### At night\n\n##### Small\n\n###### Smallest'}
      </Markdown>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('h2')).not.toBeNull(), {
    timeout: 5_000,
  });

  expect(container.querySelector('h1')).toBeNull();
  const headings = [...container.querySelectorAll('h2, h3, h4, h5, h6')].map((heading) => ({
    tag: heading.tagName,
    text: heading.textContent,
    level: heading.getAttribute('data-streamdown'),
  }));
  expect(headings).toEqual([
    { tag: 'H2', text: 'Ten Facts About Owls', level: 'heading-1' },
    { tag: 'H3', text: 'Hunting', level: 'heading-2' },
    { tag: 'H4', text: 'At night', level: 'heading-3' },
    { tag: 'H6', text: 'Small', level: 'heading-5' },
    { tag: 'H6', text: 'Smallest', level: 'heading-6' },
  ]);
  // The reply looks as it did: a Markdown h1 keeps the largest size.
  expect(container.querySelector('h2')?.className).toContain('text-3xl');
  expect(container.querySelector('h3')?.className).toContain('text-2xl');
  await act(async () => root.unmount());
  container.remove();
});
