// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { Markdown } from '../../src/components/chat/markdown';
import { headingLevelsOf, headingTagLevel } from '../../src/components/chat/markdown-headings';

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
    // Ranked, not moved down by one: no level is skipped (#271).
    { tag: 'H5', text: 'Small', level: 'heading-5' },
    { tag: 'H6', text: 'Smallest', level: 'heading-6' },
  ]);
  // The reply looks as it did: a Markdown h1 keeps the largest size.
  expect(container.querySelector('h2')?.className).toContain('text-3xl');
  expect(container.querySelector('h3')?.className).toContain('text-2xl');
  await act(async () => root.unmount());
  container.remove();
});

/** Renders `markdown` and lists its headings as "H2 Title (heading-3)". */
async function headingsOf(markdown: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Markdown>{markdown}</Markdown>));
  await vi.waitFor(() => expect(container.querySelector('h2')).not.toBeNull(), {
    timeout: 5_000,
  });
  const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(
    (heading) =>
      `${heading.tagName} ${heading.textContent} (${heading.getAttribute('data-streamdown')})`,
  );
  await act(async () => root.unmount());
  container.remove();
  return headings;
}

/**
 * #271: a reply that began "### Quick example" was an h4 straight under the
 * page's h1, and one going from ### to ##### skipped a level.
 */
describe('heading levels continue from the page h1 without skipping', () => {
  it('makes a reply’s largest heading an h2, whatever its Markdown level', async () => {
    expect(await headingsOf('### Quick example\n\nText\n\n##### Detail\n\n### Next')).toEqual([
      'H2 Quick example (heading-3)',
      'H3 Detail (heading-5)',
      'H2 Next (heading-3)',
    ]);
  });

  it('keeps a heading’s size from its Markdown level', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Markdown>{'### Quick example'}</Markdown>));
    await vi.waitFor(() => expect(container.querySelector('h2')).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(container.querySelector('h2')?.className).toContain('text-xl');
    await act(async () => root.unmount());
    container.remove();
  });

  it('ignores # lines in code blocks and counts setext headings', () => {
    const levels = headingLevelsOf(
      '```bash\n# a comment\n```\n\nTitle\n=====\n\n~~~\n## not a heading\n~~~\n\n#### Four',
    );
    expect(headingTagLevel(1, levels)).toBe(2);
    expect(headingTagLevel(4, levels)).toBe(3);
    // A level the scan missed still sits below the larger ones it found.
    expect(headingTagLevel(2, levels)).toBe(3);
    expect(headingTagLevel(6, levels)).toBe(4);
    // Outside a message: one level down, as before.
    expect(headingTagLevel(3, null)).toBe(4);
  });
});
