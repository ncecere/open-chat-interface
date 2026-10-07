// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Markdown, type MarkdownProps } from '../../src/components/chat/markdown';

/**
 * A GFM task list in a reply, through the real Streamdown renderer (#240):
 * each checkbox is named by its item's text, as a screen reader and axe's
 * `label` rule need, in a conversation and on a share page alike.
 */
const TASKS = [
  '- [x] Draft the **survey** questions',
  '- [ ] Conduct interviews',
  '  - [ ] Book the room',
  '- Plain item',
].join('\n');

async function checkboxes(props: Partial<MarkdownProps>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Markdown {...props}>{TASKS}</Markdown>));
  await vi.waitFor(() => expect(container.querySelector('input')).not.toBeNull(), {
    timeout: 5_000,
  });
  const found = [...container.querySelectorAll('input')].map((input) => ({
    type: input.type,
    checked: input.checked,
    disabled: input.disabled,
    name: input.getAttribute('aria-label'),
  }));
  const items = [...container.querySelectorAll('li')].map((item) => item.className);
  await act(async () => root.unmount());
  container.remove();
  return { found, items };
}

for (const [where, props] of [
  ['a conversation', {}],
  // A share page's props: Streamdown's own rehype plugins, raw HTML skipped.
  ['a share page', { skipHtml: true, urlTransform: (value: string) => value }],
] as const) {
  it(`names each task checkbox by its item's text in ${where}`, async () => {
    const { found, items } = await checkboxes(props);
    expect(found).toEqual([
      { type: 'checkbox', checked: true, disabled: true, name: 'Draft the survey questions' },
      // The nested item's words are its own, not its parent's.
      { type: 'checkbox', checked: false, disabled: true, name: 'Conduct interviews' },
      { type: 'checkbox', checked: false, disabled: true, name: 'Book the room' },
    ]);
    // Streamdown's own list-item styling is kept.
    expect(items.every((name) => name.includes('py-1'))).toBe(true);
  });
}
