// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageRow } from '../../src/components/chat/message-row';

/**
 * The person's own bubble and the reply show dollar amounts as typed (#339),
 * through the real MessageRow and the real Markdown renderer.
 */
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

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

const message = (role: 'user' | 'assistant', text: string): UIMessage => ({
  id: `${role}-1`,
  role,
  parts: [{ type: 'text', text }],
});
async function show(row: UIMessage) {
  await act(async () =>
    root.render(
      <MessageRow message={row} streaming={false} editing={false} onEditingChange={() => {}} />,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('p')).not.toBeNull(), { timeout: 5_000 });
}

const SENTENCE = 'tickets cost $5 for students, $10 for staff and $20 for guests.';

it("shows the person's own amounts as typed", async () => {
  await show(message('user', SENTENCE));
  expect(container.querySelector('p')?.textContent).toBe(SENTENCE);
  expect(container.querySelector('.katex')).toBeNull();
});

it('shows the LaTeX delimiters a person typed as typed', async () => {
  const text = 'Use $$ ... $$ and $ ... $ in LaTeX.';
  await show(message('user', text));
  expect(container.querySelector('p')?.textContent).toBe(text);
  expect(container.querySelector('.katex')).toBeNull();
});

it("shows a reply's amounts as typed, and its maths typeset", async () => {
  await show(message('assistant', `${SENTENCE} Also $x^2$.`));
  expect(container.querySelector('p')?.textContent).toContain(SENTENCE);
  expect(container.querySelectorAll('.katex')).toHaveLength(1);
});
