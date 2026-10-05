// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CapacityNote,
  capacityWaitLabel,
  capacityWaitOf,
  waitEstimate,
} from '../../src/components/chat/capacity-wait';
import { MessageList } from '../../src/components/chat/message-list';
import { useChatSession } from '../../src/hooks/use-chat-session';

/**
 * A reply waiting for its model's provider (v0.11): the reply shows the
 * turn's place with Stop, instead of the "generating" dots, and a turn handed
 * back by a server shutting down is sent again by itself.
 */
const { queryClient, models } = vi.hoisted(() => ({
  queryClient: { invalidateQueries: vi.fn() },
  models: [
    {
      slug: 'model',
      isDefault: true,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
  ],
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const capacity = (data: Record<string, unknown>) => ({
  type: 'data-capacity' as const,
  id: 'capacity',
  data: {
    model: 'GPT Test',
    position: null,
    estimatedWaitSeconds: null,
    waitedSeconds: 0,
    ...data,
  },
});
const prompt: UIMessage = { id: 'p', role: 'user', parts: [{ type: 'text', text: 'Question' }] };
const waiting = (position: number, estimatedWaitSeconds: number | null = 40): UIMessage => ({
  id: 'r',
  role: 'assistant',
  parts: [capacity({ state: 'waiting', position, estimatedWaitSeconds })],
});

describe('waiting for capacity', () => {
  it('shows the place in the queue and its estimate, with Stop, instead of the dots', async () => {
    const onStop = vi.fn();
    await act(() =>
      root.render(
        <MessageList
          messages={[prompt, waiting(3)]}
          streaming
          onRetry={() => {}}
          onStop={onStop}
        />,
      ),
    );
    const status = container.querySelector('[data-capacity-wait] [role="status"]');
    expect(status?.textContent).toContain('Waiting for GPT Test — you’re number 3');
    expect(status?.textContent).toContain('should start in about 40 seconds');
    expect(container.querySelector('[aria-label="Generating response"]')).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop waiting"]');
    await act(() => stop!.click());
    expect(onStop).toHaveBeenCalledTimes(1);

    // The place updates in the same part; the reply then streams as usual.
    await act(() =>
      root.render(
        <MessageList messages={[prompt, waiting(1, null)]} streaming onRetry={() => {}} />,
      ),
    );
    expect(container.textContent).toContain('you’re number 1');
    expect(container.textContent).not.toContain('should start');
    await act(() =>
      root.render(
        <MessageList
          messages={[
            prompt,
            {
              id: 'r',
              role: 'assistant',
              parts: [capacity({ state: 'admitted', waitedSeconds: 12 })],
            },
          ]}
          streaming
          onRetry={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[data-capacity-wait]')).toBeNull();
    expect(container.querySelector('[aria-label="Generating response"]')).not.toBeNull();
  });

  it('says how long a finished reply waited, or that it ran out of time', async () => {
    await act(() =>
      root.render(
        <MessageList
          messages={[
            prompt,
            {
              id: 'r',
              role: 'assistant',
              parts: [
                capacity({ state: 'admitted', waitedSeconds: 12 }),
                { type: 'text', text: 'Answer' },
              ],
            },
          ]}
          streaming={false}
          onRetry={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('Waited 12 seconds for GPT Test.');
    await act(() =>
      root.render(<CapacityNote wait={{ ...capacityWaitOf(waiting(1))!, state: 'timeout' }} />),
    );
    expect(container.textContent).toContain('GPT Test was busy for too long');
    await act(() =>
      root.render(
        <CapacityNote
          wait={{ ...capacityWaitOf(waiting(1))!, state: 'admitted', waitedSeconds: 2 }}
        />,
      ),
    );
    expect(container.textContent).toBe('');
  });

  it('reads the latest capacity part and words estimates', () => {
    expect(capacityWaitOf(prompt)).toBeNull();
    expect(
      capacityWaitOf({
        id: 'r',
        role: 'assistant',
        parts: [
          capacity({ state: 'waiting', position: 4 }),
          capacity({ state: 'waiting', position: 2 }),
          { type: 'data-capacity', data: { state: 'bogus' } } as never,
        ],
      }),
    ).toMatchObject({ state: 'waiting', position: 2 });
    expect(capacityWaitLabel({ ...capacityWaitOf(waiting(1))!, position: null, model: '' })).toBe(
      'Waiting for the model',
    );
    expect(waitEstimate(null)).toBeNull();
    expect(waitEstimate(4)).toBe('a few seconds');
    expect(waitEstimate(62)).toBe('about 60 seconds');
    expect(waitEstimate(60 * 7)).toBe('about 7 minutes');
    expect(waitEstimate(80)).toBe('about 80 seconds');
    expect(waitEstimate(95)).toBe('about 2 minutes');
  });
});

let session: ReturnType<typeof useChatSession>;
function Harness() {
  session = useChatSession({ threadId: 'thread', initialMessages: [] });
  return null;
}
const sse = (chunks: unknown[], runId: string) =>
  new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      headers: {
        ...UI_MESSAGE_STREAM_HEADERS,
        'X-OCI-Chat-Run-Id': runId,
        'X-OCI-Prompt-Message-Id': 'stored-prompt',
      },
    },
  );
const handoff = () =>
  sse(
    [
      { type: 'start', messageId: 'first' },
      {
        type: 'data-capacity',
        id: 'capacity',
        data: { state: 'waiting', model: 'M', position: 2 },
      },
      { type: 'data-capacity', id: 'capacity', data: { state: 'handoff', model: 'M' } },
      { type: 'finish', finishReason: 'other' },
    ],
    'first',
  );
const answer = () =>
  sse(
    [
      { type: 'start', messageId: 'second' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Answer' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'stop' },
    ],
    'second',
  );

describe('a turn handed back by a server shutting down', () => {
  it('is sent again for the stored prompt, replacing the empty reply', async () => {
    const answers = [handoff(), answer()];
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => answers.shift()!);
    vi.stubGlobal('fetch', fetch);
    await act(() => root.render(<Harness />));
    await act(() => session.send('Question'));
    await act(async () => {
      for (let i = 0; i < 20 && fetch.mock.calls.length < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      for (let i = 0; i < 20 && session.status !== 'ready'; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const again = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(again).toMatchObject({
      trigger: 'regenerate-message',
      messages: [{ id: 'stored-prompt', role: 'user' }],
    });
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(session.messages.at(-1)?.parts).toContainEqual({
      type: 'text',
      text: 'Answer',
      state: 'done',
    });
  });

  it('stops sending again after two hand-backs in a row', async () => {
    const fetch = vi.fn(async () => handoff());
    vi.stubGlobal('fetch', fetch);
    await act(() => root.render(<Harness />));
    await act(() => session.send('Question'));
    await act(async () => {
      for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
