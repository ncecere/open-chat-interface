// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partGroupsOf } from '../../src/components/chat/message-content';
import { MessageRow } from '../../src/components/chat/message-row';
import { PublicSharePage } from '../../src/routes/share/public-share';

/**
 * A reply shows its parts in the order they were written: reasoning, then the
 * tool call it led to, then the text, step after step; runs of one kind are
 * one group.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
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
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const reasoning = (text: string) => ({ type: 'reasoning', text }) as const;
const text = (value: string) => ({ type: 'text', text: value }) as const;
const step = { type: 'step-start' } as const;
const search = (id: string, query: string) =>
  ({
    type: 'tool-web_search',
    toolCallId: id,
    state: 'output-available',
    input: { query },
    output: { results: [] },
  }) as never;

function reply(...parts: unknown[]): UIMessage {
  return { id: 'reply-1', role: 'assistant', parts: parts as UIMessage['parts'] };
}

async function render(ui: ReactNode) {
  await act(async () => root.render(ui));
}
function row(message: UIMessage, streaming = false) {
  return (
    <MessageRow
      message={message}
      streaming={streaming}
      editing={false}
      onEditingChange={() => {}}
    />
  );
}

/** The groups as rendered: kind and a short description of each. */
function shown(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-reply-group]')].map((group) => {
    const kind = group.dataset.replyGroup;
    if (kind === 'reasoning') return `reasoning:${group.querySelector('button')?.textContent}`;
    if (kind === 'tools')
      return `tools:${[...group.querySelectorAll('li')].map((item) => item.textContent).join('|')}`;
    return `text:${group.textContent}`;
  });
}

describe('a reply in written order', () => {
  it('shows reasoning, then the tool step, then the text', async () => {
    await render(
      row(reply(step, reasoning('I should search.'), search('s1', 'hours'), step, text('Nine.'))),
    );
    expect(shown()).toEqual([
      'reasoning:Reasoning',
      "tools:Searched the web for 'hours' · 0 results",
      'text:Nine.',
    ]);
  });

  it('interleaves the steps of a multi-step reply and groups runs of one kind', async () => {
    await render(
      row(
        reply(
          step,
          reasoning('First '),
          reasoning('thought.'),
          search('s1', 'one'),
          search('s2', 'two'),
          step,
          reasoning('Second thought.'),
          text('Checking once more.'),
          search('s3', 'three'),
          step,
          text('Done.'),
          text('Anything else?'),
        ),
      ),
    );
    expect(shown()).toEqual([
      'reasoning:Reasoning',
      "tools:Searched the web for 'one' · 0 results|Searched the web for 'two' · 0 results",
      'reasoning:Reasoning',
      'text:Checking once more.',
      "tools:Searched the web for 'three' · 0 results",
      'text:Done.\nAnything else?',
    ]);
    // Two reasoning chunks of one step are one disclosure.
    const first = container.querySelector<HTMLElement>('[data-reply-group="reasoning"] button')!;
    await act(async () => first.click());
    expect(container.querySelector('[data-reply-group="reasoning"]')?.textContent).toContain(
      'First \nthought.',
    );
  });

  it('appends new groups at the end while the reply streams', async () => {
    await render(row(reply(step, reasoning('Look it up.'), search('s1', 'one')), true));
    expect(shown()).toEqual([
      'reasoning:Reasoning',
      "tools:Searched the web for 'one' · 0 results",
    ]);
    await render(
      row(reply(step, reasoning('Look it up.'), search('s1', 'one'), step, reasoning('Now')), true),
    );
    // The new step's reasoning comes after the first step's tool call, still thinking.
    expect(shown()).toEqual([
      'reasoning:Reasoning',
      "tools:Searched the web for 'one' · 0 results",
      'reasoning:Thinking…',
    ]);
    await render(
      row(
        reply(
          step,
          reasoning('Look it up.'),
          search('s1', 'one'),
          step,
          reasoning('Now'),
          text('It opens'),
        ),
        true,
      ),
    );
    expect(shown().at(-1)).toBe('text:It opens');
    expect(shown()).toHaveLength(4);
    // The answer has started: that reasoning is finished.
    expect(shown()[2]).toBe('reasoning:Reasoning');
  });

  it('shows a reply with only text as before', async () => {
    await render(row(reply(step, text('Just an answer.'))));
    expect(shown()).toEqual(['text:Just an answer.']);
    expect(container.querySelector('[aria-label="Tool steps"]')).toBeNull();
  });

  it('keeps a single-step reply without tools as reasoning then text, thinking until the text starts', async () => {
    await render(row(reply(step, reasoning('Hmm.')), true));
    expect(shown()).toEqual(['reasoning:Thinking…']);
    await render(row(reply(step, reasoning('Hmm.'), text('Answer')), true));
    expect(shown()).toEqual(['reasoning:Reasoning', 'text:Answer']);
    await render(row(reply(step, reasoning('Hmm.'), text('Answer.'))));
    expect(shown()).toEqual(['reasoning:Reasoning', 'text:Answer.']);
  });

  it('keeps each text group\u2019s place in the whole reply text', () => {
    const groups = partGroupsOf(
      [text('ab'), search('s1', 'x'), text(''), text('cd')] as Array<{ type: string }>,
      (part) => part.type.startsWith('tool-'),
    );
    // textOf joins text parts with a newline: "ab\n\ncd".
    expect(groups).toEqual([
      { type: 'text', key: 'text-0', start: 0, end: 2 },
      expect.objectContaining({ type: 'tools', key: 'tools-1' }),
      { type: 'text', key: 'text-3', start: 4, end: 6 },
    ]);
  });
});

describe('a shared reply', () => {
  it('shows tool step summaries and text in written order', async () => {
    api.get.mockResolvedValue({
      thread: { title: 'Shared', sharedAt: '2026-01-01T00:00:00.000Z' },
      messages: [
        {
          id: 'reply-1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool-step', toolId: 'web_search', summary: 'Searched the web' },
            { type: 'text', text: 'It opens at nine.' },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      snapshot: false,
      expiresAt: null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={client}>
        <PublicSharePage slug="shared" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(container.textContent).toContain('It opens at nine.'));
    const article = container.querySelector('article[aria-label="Assistant message"]')!;
    const order = article.textContent ?? '';
    expect(order.indexOf('Let me check.')).toBeLessThan(order.indexOf('Searched the web'));
    expect(order.indexOf('Searched the web')).toBeLessThan(order.indexOf('It opens at nine.'));
  });
});
