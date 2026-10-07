// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { InlineMarkdown, safeHref } from '../../src/components/ui/inline-markdown';
import { onThisPage } from '../../src/routes/admin/search';

async function render(text: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() => root.render(<InlineMarkdown text={text} />));
  return { container, unmount: () => act(() => root.unmount()) };
}

describe('announcement text (#86)', () => {
  it('formats bold and links instead of showing the Markdown', async () => {
    const { container, unmount } = await render(
      'Walk maintenance **on Sunday**. See [the status page](https://status.example.edu) or [help](/help).',
    );
    expect(container.textContent).toBe('Walk maintenance on Sunday. See the status page or help.');
    expect(container.querySelector('strong')?.textContent).toBe('on Sunday');
    const [external, local] = [...container.querySelectorAll('a')];
    expect(external?.getAttribute('href')).toBe('https://status.example.edu/');
    expect(external?.getAttribute('target')).toBe('_blank');
    expect(local?.getAttribute('href')).toBe('/help');
    expect(local?.hasAttribute('target')).toBe(false);
    await unmount();
  });

  it('never makes a script link or HTML, and leaves other Markdown as typed', async () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    const { container, unmount } = await render(
      '[click](javascript:alert(1)) <b>raw</b> # heading',
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('[click](javascript:alert(1)) <b>raw</b> # heading');
    await unmount();
  });
});

describe('web search messages on the Web search page (#86)', () => {
  it('points at this page rather than naming it', () => {
    expect(onThisPage('Tavily needs an API key. Add it on the Web search page.')).toBe(
      'Tavily needs an API key. Add it here.',
    );
    expect(
      onThisPage(
        'SerpApi rejected the web search API key (HTTP 401). An administrator needs to check it on the Web search page.',
      ),
    ).toBe('SerpApi rejected the web search API key (HTTP 401). Check it here.');
    expect(onThisPage('Search timed out.')).toBe('Search timed out.');
  });
});
