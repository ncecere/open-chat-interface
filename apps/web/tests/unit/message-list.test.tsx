// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';

const { renderMarkdown } = vi.hoisted(() => ({ renderMarkdown: vi.fn() }));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => {
    renderMarkdown(children);
    return <div>{children}</div>;
  },
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  renderMarkdown.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

async function render(props: ComponentProps<typeof MessageList>) {
  await act(() => root.render(<MessageList {...props} />));
}
async function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}
function message(id: string, role: UIMessage['role'] = 'assistant'): UIMessage {
  return { id, role, parts: [{ type: 'text', text: id }] };
}

describe('transcript render budget', () => {
  it('does no historical Markdown work across 40 chunks in a 100-message conversation', async () => {
    const history = Array.from({ length: 100 }, (_, i) =>
      message(`history-${i}`, i % 2 ? 'assistant' : 'user'),
    );
    const onRetry = vi.fn();
    const onFork = vi.fn(async () => {});
    const onEdit = vi.fn(async () => {});
    await render({
      messages: [...history, message('live')],
      streaming: true,
      onRetry,
      onFork,
      onEdit,
    });
    renderMarkdown.mockClear();
    for (let chunk = 1; chunk <= 40; chunk++) {
      await render({
        messages: [
          ...history,
          { ...message('live'), parts: [{ type: 'text', text: `chunk-${chunk}` }] },
        ],
        streaming: true,
        onRetry,
        onFork,
        onEdit,
      });
    }
    expect(renderMarkdown.mock.calls.filter(([text]) => text.startsWith('history-'))).toHaveLength(
      0,
    );
    expect(renderMarkdown).toHaveBeenCalledTimes(40);
    expect(container.textContent).toContain('chunk-40');
  });

  it('does no Markdown work for parent updates with unchanged transcript props', async () => {
    const props = {
      messages: [message('question', 'user'), message('answer')],
      streaming: false,
      onRetry: vi.fn(),
    };
    await render(props);
    renderMarkdown.mockClear();
    for (let key = 0; key < 20; key++) await render(props);
    expect(renderMarkdown).not.toHaveBeenCalled();
  });
});

describe('memoized transcript correctness', () => {
  it('shows a persisted context-limit notice and updates it without changing the message ID', async () => {
    const answer = message('answer');
    await render({ messages: [answer], streaming: false });
    expect(container.querySelector('[role="note"]')).toBeNull();
    await render({
      messages: [
        {
          ...answer,
          parts: [...answer.parts, { type: 'data-context-window', data: { limited: true } }],
        },
      ],
      streaming: false,
    });
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      'Earlier conversation context was omitted',
    );
    await render({
      messages: [
        {
          ...answer,
          parts: [...answer.parts, { type: 'data-context-window', data: { limited: false } }],
        },
      ],
      streaming: false,
    });
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('uses new callbacks and updates same-ID text, attribution and retry eligibility', async () => {
    const firstRetry = vi.fn();
    const nextRetry = vi.fn();
    const firstFork = vi.fn(async () => {});
    const nextFork = vi.fn(async () => {});
    const original = message('answer');
    await render({
      messages: [original],
      streaming: false,
      onRetry: firstRetry,
      onFork: firstFork,
    });
    await render({
      messages: [
        {
          ...original,
          parts: [{ type: 'text', text: 'Replaced answer' }],
          metadata: { modelSlug: 'new-model', effort: 'high' },
        },
      ],
      streaming: false,
      onRetry: nextRetry,
      onFork: nextFork,
    });
    expect(container.textContent).toContain('Replaced answer');
    expect(container.textContent).toContain('new-model');
    expect(container.textContent).toContain('(high)');
    await click('Retry');
    await click('Fork conversation here');
    expect(nextRetry).toHaveBeenCalledOnce();
    expect(nextFork).toHaveBeenCalledWith('answer');
    expect(firstRetry).not.toHaveBeenCalled();
    expect(firstFork).not.toHaveBeenCalled();
    await render({
      messages: [original, message('next', 'user')],
      streaming: true,
      onRetry: nextRetry,
    });
    expect(container.querySelector('[aria-label="Retry"]')).toBeNull();
  });

  it('shows waiting feedback until visible content, then reasoning and final actions', async () => {
    const onRetry = vi.fn();
    const empty: UIMessage = { id: 'live', role: 'assistant', parts: [] };
    await render({ messages: [empty], streaming: true, searching: true, onRetry });
    expect(
      [...container.querySelectorAll('[role="status"]')].some(
        (status) => status.textContent === 'Searching the web…',
      ),
    ).toBe(true);
    const reasoning: UIMessage = { ...empty, parts: [{ type: 'reasoning', text: 'Let me think' }] };
    await render({ messages: [reasoning], streaming: true, onRetry });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('Let me think');
    expect(container.querySelector('[aria-label="Retry"]')).toBeNull();
    const answered: UIMessage = {
      ...reasoning,
      parts: [...reasoning.parts, { type: 'text', text: 'Final answer' }],
    };
    await render({ messages: [answered], streaming: true, onRetry });
    expect(container.textContent).not.toContain('Let me think');
    await render({ messages: [answered], streaming: false, onRetry });
    await click('Retry');
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('refreshes grounding and attachments without relying on text-only comparisons', async () => {
    const onRetry = vi.fn();
    const user = message('question', 'user');
    const assistant = message('answer');
    await render({ messages: [user, assistant], streaming: false, onRetry });
    await render({
      messages: [
        {
          ...user,
          parts: [
            ...user.parts,
            {
              type: 'data-attachment',
              data: {
                id: 'file',
                filename: 'notes.txt',
                mimeType: 'text/plain',
                url: '/api/files/file',
              },
            },
          ],
        },
        {
          ...assistant,
          parts: [
            ...assistant.parts,
            {
              type: 'source-url',
              sourceId: 'source',
              title: 'Reference',
              url: 'https://example.com',
            },
          ],
        },
      ],
      streaming: false,
      onRetry,
    });
    expect(container.textContent).toContain('notes.txt');
    // The search is a step of the reply's one work block (v0.11), not a panel.
    const header = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Searched the web',
    );
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Search Grounding Details');
    await act(() => header!.click());
    expect(container.textContent).toContain('Searched the web · 1 source');
  });

  it('does not dismiss a newer editor when an earlier save finishes', async () => {
    let finishSave!: () => void;
    const onEdit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    await render({
      messages: [message('first', 'user'), message('second', 'user')],
      streaming: false,
      onRetry: vi.fn(),
      onEdit,
    });
    await click('Edit message');
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save & submit',
    )!;
    await act(() => save.click());
    // The first row has an editor; the remaining Edit button belongs to row two.
    await click('Edit message');
    expect(container.querySelector('textarea')?.value).toBe('second');
    await act(() => finishSave());
    expect(container.querySelector('textarea')?.value).toBe('second');
  });

  it('keeps editing local and recovers after a rejected branch', async () => {
    const onEdit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Branch failed'))
      .mockResolvedValueOnce(undefined);
    const props = {
      messages: [message('question', 'user'), message('answer')],
      streaming: false,
      onRetry: vi.fn(),
      onEdit,
    };
    await render(props);
    await click('Edit message');
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(editor.value).toBe('question');
    renderMarkdown.mockClear();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(() => {
      setValue.call(editor, 'Edited question');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(renderMarkdown).not.toHaveBeenCalled();
    async function submit() {
      const save = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Save & submit',
      )!;
      await act(() => save.click());
    }
    await submit();
    expect(container.textContent).toContain('Branch failed');
    expect(editor.disabled).toBe(false);
    await submit();
    expect(onEdit).toHaveBeenLastCalledWith('question', 'Edited question');
    expect(container.querySelector('textarea')).toBeNull();
  });
});
