// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Markdown, type MarkdownProps } from '../../src/components/chat/markdown';

const { renderStreamdown } = vi.hoisted(() => ({ renderStreamdown: vi.fn() }));
vi.mock('streamdown', () => ({
  Streamdown: (props: MarkdownProps) => {
    renderStreamdown(props);
    return <div>{props.children}</div>;
  },
  defaultRehypePlugins: {
    raw: 'raw',
    sanitize: 'sanitize',
    harden: ['harden', { allowedLinkPrefixes: ['*'] }],
  },
  defaultRemarkPlugins: { gfm: 'gfm' },
}));
vi.mock('@streamdown/code', () => ({ code: {} }));
vi.mock('@streamdown/math', () => ({ createMathPlugin: () => ({}) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  root = createRoot(container);
  renderStreamdown.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
});
async function render(props: MarkdownProps) {
  await act(() => root.render(<Markdown {...props} />));
}

it('skips the lazy renderer when text and safety props are unchanged', async () => {
  const props = { children: String.raw`Math: \(x\)` };
  await render(props);
  await vi.waitFor(() => expect(container.textContent).toBe('Math: $x$'));
  renderStreamdown.mockClear();
  for (let update = 0; update < 20; update++) await render(props);
  expect(renderStreamdown).not.toHaveBeenCalled();
  await render({ children: 'New text' });
  expect(container.textContent).toBe('New text');
  expect(renderStreamdown).toHaveBeenCalledOnce();
});

it('does not cache past changed HTML safety, URL policy or styling', async () => {
  const firstTransform = () => 'https://example.com';
  const nextTransform = () => null;
  await render({ children: 'Same text', urlTransform: firstTransform });
  await render({
    children: 'Same text',
    skipHtml: true,
    urlTransform: nextTransform,
    className: 'new-style',
  });
  expect(renderStreamdown).toHaveBeenLastCalledWith(
    expect.objectContaining({
      children: 'Same text',
      skipHtml: true,
      urlTransform: nextTransform,
      // After the classes every rendering needs (#186).
      className: expect.stringMatching(/ new-style$/),
    }),
  );
});

it('renders refused links as text in a conversation, keeping share pages strict', async () => {
  await render({ children: 'A [link](plan.md)' });
  await vi.waitFor(() => expect(renderStreamdown).toHaveBeenCalled());
  expect(renderStreamdown).toHaveBeenLastCalledWith(
    expect.objectContaining({
      rehypePlugins: [
        'raw',
        'sanitize',
        ['harden', { allowedLinkPrefixes: ['*'], linkBlockPolicy: 'text-only' }],
      ],
    }),
  );
  await render({ children: 'A [link](plan.md)', skipHtml: true, urlTransform: () => null });
  expect(renderStreamdown.mock.lastCall?.[0]).not.toHaveProperty('rehypePlugins');
});
