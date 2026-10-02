// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import type { ReplySwitch } from '../../src/components/chat/reply-switcher';
import { useReplySwitcher } from '../../src/hooks/use-reply-switcher';

const { activateReply } = vi.hoisted(() => ({ activateReply: vi.fn() }));
vi.mock('../../src/lib/chat-history', () => ({ activateReply }));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  activateReply.mockReset();
  activateReply.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

function message(id: string, role: UIMessage['role'] = 'assistant'): UIMessage {
  return { id, role, parts: [{ type: 'text', text: `${id} text` }] };
}
function button(label: string) {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(found).not.toBeNull();
  return found!;
}
const status = () => container.querySelector('[role="status"]')?.textContent;
const transcript = () =>
  [...container.querySelectorAll('article')].map((article) => article.dataset.messageId);

describe('reply switcher controls', () => {
  async function render(replySwitch: ReplySwitch | undefined, streaming = false) {
    await act(() =>
      root.render(
        <MessageList
          messages={[message('prompt', 'user'), message('reply-2')]}
          streaming={streaming}
          onRetry={() => {}}
          replySwitch={replySwitch}
        />,
      ),
    );
  }

  it('shows the position on the last reply with accessible names and a live region', async () => {
    const onSelect = vi.fn();
    await render({ index: 1, count: 3, disabled: false, onSelect });
    expect(container.querySelector('fieldset')?.getAttribute('aria-label')).toBe('Replies');
    expect(container.querySelector('fieldset')?.textContent).toContain('2 / 3');
    expect(status()).toBe('Reply 2 of 3');
    await act(() => button('Previous reply').click());
    await act(() => button('Next reply').click());
    expect(onSelect.mock.calls).toEqual([[0], [2]]);
  });

  it('keeps unavailable buttons focusable but inert at either end and while streaming', async () => {
    const onSelect = vi.fn();
    await render({ index: 0, count: 2, disabled: false, onSelect });
    expect(button('Previous reply').getAttribute('aria-disabled')).toBe('true');
    expect(button('Previous reply').disabled).toBe(false);
    expect(button('Next reply').getAttribute('aria-disabled')).toBe('false');
    await act(() => button('Previous reply').click());
    expect(onSelect).not.toHaveBeenCalled();

    await render({ index: 1, count: 2, disabled: true, onSelect }, true);
    for (const label of ['Previous reply', 'Next reply']) {
      expect(button(label).getAttribute('aria-disabled')).toBe('true');
      await act(() => button(label).click());
    }
    expect(onSelect).not.toHaveBeenCalled();
    // Retry and the other actions stay hidden while streaming; the position stays visible.
    expect(container.querySelector('button[aria-label="Retry"]')).toBeNull();
  });

  it('is absent without alternatives', async () => {
    await render(undefined);
    expect(container.querySelector('fieldset')).toBeNull();
    expect(container.querySelector('button[aria-label="Retry"]')).not.toBeNull();
  });
});

describe('useReplySwitcher', () => {
  const prompt = message('prompt', 'user');
  let api!: ReturnType<typeof useReplySwitcher> & {
    setMessages: (update: (current: UIMessage[]) => UIMessage[]) => void;
  };

  function Harness({
    initialMessages,
    initialReplies,
    streaming = false,
  }: {
    initialMessages: UIMessage[];
    initialReplies: UIMessage[];
    streaming?: boolean;
  }) {
    const [messages, setMessages] = useState(initialMessages);
    const replies = useReplySwitcher({
      threadId: 'thread',
      initialMessages,
      initialReplies,
      messages,
      setMessages,
      streaming,
    });
    api = { ...replies, setMessages };
    return (
      <MessageList
        messages={messages}
        streaming={streaming}
        onRetry={() => {}}
        replySwitch={replies.switcher}
      />
    );
  }
  async function mount(props: Parameters<typeof Harness>[0]) {
    await act(() => root.render(<Harness {...props} />));
  }

  it('starts on the server’s active reply, switches at once and saves the choice', async () => {
    const replies = [message('reply-1'), message('reply-2'), message('reply-3')];
    await mount({ initialMessages: [prompt, replies[1]!], initialReplies: replies });
    expect(status()).toBe('Reply 2 of 3');

    const nextButton = button('Next reply');
    nextButton.focus();
    await act(() => nextButton.click());
    expect(transcript()).toEqual(['prompt', 'reply-3']);
    expect(status()).toBe('Reply 3 of 3');
    // The row is not remounted, so keyboard focus stays on the control.
    expect(button('Next reply')).toBe(nextButton);
    expect(document.activeElement).toBe(nextButton);
    expect(activateReply).toHaveBeenCalledWith('thread', 'reply-3');
    await act(() => api.settled());

    await act(() => button('Previous reply').click());
    await act(() => api.settled());
    await act(() => button('Previous reply').click());
    await act(() => api.settled());
    expect(transcript()).toEqual(['prompt', 'reply-1']);
    expect(activateReply.mock.calls.map(([, id]) => id)).toEqual(['reply-3', 'reply-2', 'reply-1']);
  });

  it('is unavailable while a switch is saving, and restores the reply when saving fails', async () => {
    let fail!: (error: Error) => void;
    activateReply.mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
    );
    const replies = [message('reply-1'), message('reply-2')];
    await mount({ initialMessages: [prompt, replies[1]!], initialReplies: replies });
    await act(() => button('Previous reply').click());
    expect(transcript()).toEqual(['prompt', 'reply-1']);
    expect(button('Next reply').getAttribute('aria-disabled')).toBe('true');
    await act(() => button('Next reply').click());
    expect(activateReply).toHaveBeenCalledTimes(1);

    await act(async () => {
      fail(new Error('offline'));
      await api.settled();
    });
    expect(transcript()).toEqual(['prompt', 'reply-2']);
    expect(api.error).toBe('The reply could not be switched. Try again.');
    expect(button('Previous reply').getAttribute('aria-disabled')).toBe('false');
  });

  it('keeps a reply a retry replaces, adding the new reply last', async () => {
    await mount({ initialMessages: [prompt, message('first')], initialReplies: [] });
    expect(container.querySelector('fieldset')).toBeNull();

    // What a retry does: remember the reply on screen, then the SDK replaces it.
    await act(() => api.remember());
    await act(() => api.setMessages((current) => [...current.slice(0, -1), message('second')]));
    expect(status()).toBe('Reply 2 of 2');
    await act(() => button('Previous reply').click());
    expect(transcript()).toEqual(['prompt', 'first']);
    expect(activateReply).toHaveBeenCalledWith('thread', 'first');
  });

  it('disables switching while a reply streams and drops it once the turn moves on', async () => {
    const replies = [message('reply-1'), message('reply-2')];
    await mount({
      initialMessages: [prompt, replies[1]!],
      initialReplies: replies,
      streaming: true,
    });
    expect(button('Previous reply').getAttribute('aria-disabled')).toBe('true');
    await act(() => button('Previous reply').click());
    expect(activateReply).not.toHaveBeenCalled();

    await mount({ initialMessages: [prompt, replies[1]!], initialReplies: replies });
    await act(() =>
      api.setMessages((current) => [...current, message('next', 'user'), message('answer')]),
    );
    expect(container.querySelector('fieldset')).toBeNull();
  });
});
