// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolSteps } from '../../src/components/chat/tool-steps';
import { ApiError } from '../../src/lib/api-client';

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

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
const undoButton = () =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'Undo');

describe('"Memory updated" note', () => {
  it('shows what was remembered and undoes it for this reply and step', async () => {
    await act(() => root.render(<ToolSteps message={reply(remembered)} />));
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
    await act(() => root.render(<ToolSteps message={reply(forgot)} />));
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
    await act(() => root.render(<ToolSteps message={reply(forgot)} />));
    await act(async () => undoButton()!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Memory is not available.');
    expect(undoButton()?.disabled).toBe(false);
  });

  it('disables Undo while the reply is still streaming', async () => {
    await act(() => root.render(<ToolSteps message={reply(remembered)} disabled />));
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
    await act(() => root.render(<ToolSteps message={reply(exists, running)} />));
    expect(container.querySelector('[data-testid="memory-note"]')).toBeNull();
    expect(container.textContent).toContain("Already remembered 'Prefers metric units'");
    expect(container.textContent).toContain('Saving a memory');
  });
});
