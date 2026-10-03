// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Markdown } from '../../src/components/chat/markdown';

/**
 * Links the renderer refuses, with the real Streamdown: in a person's own
 * conversation they read as plain text; share pages keep the visible marker.
 */
vi.mock('../../src/components/chat/mermaid-plugin', () => ({
  createEditorialMermaidPlugin: () => ({
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid: () => ({}),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const REFUSED = 'Open [the sign-up page](sandbox:/mnt/data/page.html) or [the plan](plan.md).';

/** Rendered by Streamdown, not the plain-text fallback shown while it loads. */
const rendered = () =>
  vi.waitFor(() => expect(container.innerHTML).toMatch(/sign-up page( \[blocked\])?</), {
    timeout: 10_000,
  });

it('shows a refused link as its text in a conversation', { timeout: 15_000 }, async () => {
  await act(async () => root.render(<Markdown>{REFUSED}</Markdown>));
  await rendered();
  expect(container.textContent).toContain('the sign-up page');
  expect(container.textContent).toContain('the plan');
  expect(container.textContent).not.toContain('[blocked]');
  expect(container.querySelector('a')).toBeNull();
});

it('keeps the marker on share pages', { timeout: 15_000 }, async () => {
  await act(async () =>
    root.render(
      <Markdown skipHtml urlTransform={() => null}>
        {REFUSED}
      </Markdown>,
    ),
  );
  await rendered();
  expect(container.textContent).toContain('[blocked]');
  expect(container.querySelector('a')).toBeNull();
});
