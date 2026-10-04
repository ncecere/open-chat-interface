// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageRow } from '../../src/components/chat/message-row';
import { ApiError } from '../../src/lib/api-client';

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.post.mockReset().mockResolvedValue({ action: 'removed', changed: true });
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const remembered = {
  type: 'tool-remember',
  toolCallId: 'r1',
  state: 'output-available',
  input: { content: 'Prefers metric units' },
  output: { action: 'added', id: 'mem-1', content: 'Prefers metric units' },
};
const forgot = {
  type: 'tool-forget',
  toolCallId: 'f1',
  state: 'output-available',
  input: { id: 'abcd1234' },
  output: { action: 'removed', id: 'mem-2', content: 'Lives in Paris' },
};
const reply = (...parts: unknown[]): UIMessage => ({
  id: 'reply-1',
  role: 'assistant',
  parts: parts as UIMessage['parts'],
});
const show = (message: UIMessage, streaming = false) =>
  act(() =>
    root.render(
      <MessageRow
        message={message}
        streaming={streaming}
        editing={false}
        onEditingChange={() => {}}
      />,
    ),
  );
const undoButton = () =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'Undo');

describe('"Memory updated" note', () => {
  it('shows what was remembered and undoes it for this reply and step', async () => {
    await show(reply(remembered));
    const note = container.querySelector('[data-testid="memory-note"]')!;
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toContain('Memory updated');
    expect(note.textContent).toContain('Remembered: Prefers metric units');
    await act(async () => undoButton()!.click());
    expect(api.post).toHaveBeenCalledWith('/memory/undo', {
      messageId: 'reply-1',
      toolCallId: 'r1',
    });
    expect(undoButton()).toBeUndefined();
    expect(note.querySelector('[role="status"]')?.textContent).toBe('Undone');
  });

  it('shows what was forgotten, with an Undo that restores it', async () => {
    api.post.mockResolvedValue({ action: 'restored', changed: true });
    await show(reply(forgot));
    expect(container.textContent).toContain('Forgot: Lives in Paris');
    expect(undoButton()?.getAttribute('aria-label')).toBe('Undo: remember this again');
    await act(async () => undoButton()!.click());
    expect(api.post).toHaveBeenCalledWith('/memory/undo', {
      messageId: 'reply-1',
      toolCallId: 'f1',
    });
  });

  it('keeps Undo available after a failure and explains it', async () => {
    api.post.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Memory is not available.'));
    await show(reply(forgot));
    await act(async () => undoButton()!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Memory is not available.');
    expect(undoButton()?.disabled).toBe(false);
  });

  it('disables Undo while the reply is still streaming', async () => {
    await show(reply(remembered), true);
    expect(undoButton()?.disabled).toBe(true);
  });

  it('shows no note for a step that changed nothing or is still running', async () => {
    const exists = { ...remembered, output: { ...remembered.output, action: 'exists' } };
    const running = {
      ...remembered,
      toolCallId: 'r2',
      state: 'input-available',
      output: undefined,
    };
    await show(reply(exists, running));
    expect(container.querySelector('[data-testid="memory-note"]')).toBeNull();
    expect(container.textContent).toContain("Already remembered 'Prefers metric units'");
    expect(container.textContent).toContain('Saving a memory');
  });

  it('stays in sight below the work block and above the answer', async () => {
    await show(
      reply(
        { type: 'reasoning', text: 'They said metric.' },
        remembered,
        { type: 'reasoning', text: 'Now answer.' },
        { type: 'text', text: 'Noted.' },
      ),
    );
    const article = container.querySelector('article')!;
    const block = article.querySelector('[data-reply-group="work"]')!;
    const note = article.querySelector('[data-testid="memory-note"]')!;
    const answer = article.querySelector('[data-reply-group="text"]')!;
    // Two reasoning runs: one block, collapsed, and the note is not in it.
    expect(block.querySelector('button')?.textContent).toBe('Thought');
    expect(block.contains(note)).toBe(false);
    expect(block.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
