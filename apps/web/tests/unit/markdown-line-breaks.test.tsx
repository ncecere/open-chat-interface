// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Markdown } from '../../src/components/chat/markdown';

/**
 * Single line breaks in replies (#207), through the real lazily loaded
 * Streamdown renderer: a haiku keeps its three lines.
 */
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

async function render(markdown: string, ready = 'p') {
  await act(async () => root.render(<Markdown>{markdown}</Markdown>));
  await vi.waitFor(() => expect(container.querySelector(ready)).not.toBeNull(), {
    timeout: 5_000,
  });
}

/** A paragraph's lines as a reader sees them: text between line breaks. */
function lines(element: Element): string[] {
  const result = [''];
  const walk = (node: Node) => {
    if (node.nodeName === 'BR') result.push('');
    else if (node.nodeType === Node.TEXT_NODE)
      result[result.length - 1] += (node.textContent ?? '').replace(/\s+/g, ' ');
    else node.childNodes.forEach(walk);
  };
  element.childNodes.forEach(walk);
  return result.map((line) => line.trim());
}

it("keeps a haiku's single line breaks", async () => {
  await render(
    'Here is a haiku:\n\nLight scatters above\nBlue waves shorter, spread more wide\nSky paints itself blue',
  );
  const poem = container.querySelectorAll('p')[1]!;
  expect(lines(poem)).toEqual([
    'Light scatters above',
    'Blue waves shorter, spread more wide',
    'Sky paints itself blue',
  ]);
});

it('keeps them inside emphasis and quotes, and an address in a list item', async () => {
  await render('> **First line\nsecond line**\n\n- Jane Doe\n  1 Main Street');
  expect(lines(container.querySelector('blockquote p')!)).toEqual(['First line', 'second line']);
  expect(lines(container.querySelector('li')!)).toEqual(['Jane Doe', '1 Main Street']);
});

it('makes one break of a hard break, and leaves code untouched', async () => {
  await render('One  \nTwo\\\nThree\n\n```text\na\nb\n```', '[data-streamdown="code-block"]');
  expect(lines(container.querySelector('p')!)).toEqual(['One', 'Two', 'Three']);
  const code = container.querySelector('[data-streamdown="code-block"] pre')!;
  expect(code.querySelector('br')).toBeNull();
  expect(code.textContent).toContain('a');
  expect(code.textContent).toContain('b');
});
