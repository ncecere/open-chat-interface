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
 * A reply shows everything the model did before answering (reasoning and tool
 * calls of every step, in written order) as one work block, then its text. A
 * reply with one run of reasoning and no tools keeps the plain "Reasoning"
 * disclosure.
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
    if (kind === 'work') return `work:${group.querySelector('button')?.textContent}`;
    return `text:${group.textContent}`;
  });
}
const header = () =>
  container.querySelector<HTMLButtonElement>('[data-reply-group] > button[aria-expanded]')!;
/** The expanded block's timeline: one description per entry. */
function timeline(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-work-timeline] > li')].map((item) =>
    item.dataset.workEntry === 'reasoning'
      ? `reasoning:${item.querySelector('[data-markdown]')?.textContent}`
      : `tool:${item.querySelector('button')?.textContent}`,
  );
}
const status = () => container.querySelector('[role="status"][aria-live="polite"]');

describe('a reply in written order', () => {
  it('puts the reasoning and tool step of a reply in one block, then the text', async () => {
    await render(
      row(reply(step, reasoning('I should search.'), search('s1', 'hours'), step, text('Nine.'))),
    );
    expect(shown()).toEqual(['work:Thought · searched the web', 'text:Nine.']);
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-work-timeline]')).toBeNull();
    await act(async () => header().click());
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(header().getAttribute('aria-controls')).toBe(
      container.querySelector('[data-work-timeline]')?.parentElement?.id,
    );
    expect(timeline()).toEqual([
      'reasoning:I should search.',
      "tool:Searched the web for 'hours' · 0 results",
    ]);
    expect(container.querySelector('[data-work-timeline]')?.tagName).toBe('OL');
  });

  it('gathers every step of a multi-step reply into one block, in order', async () => {
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
    // One block, no repeated headers; the text keeps its order below it.
    expect(shown()).toEqual([
      'work:Thought · searched the web 3 times',
      'text:Checking once more.',
      'text:Done.\nAnything else?',
    ]);
    await act(async () => header().click());
    expect(timeline()).toEqual([
      'reasoning:First \nthought.',
      "tool:Searched the web for 'one' · 0 results",
      "tool:Searched the web for 'two' · 0 results",
      'reasoning:Second thought.',
      "tool:Searched the web for 'three' · 0 results",
    ]);
    expect(container.textContent).toContain('Some models hide parts of their thinking');
  });

  it('collapses a reasoning-only multi-step reply into one block', async () => {
    await render(
      row(
        reply(
          step,
          reasoning('Plan.'),
          text('First part.'),
          step,
          reasoning('Check.'),
          text('Second part.'),
        ),
      ),
    );
    expect(shown()).toEqual(['work:Thought', 'text:First part.', 'text:Second part.']);
    await act(async () => header().click());
    expect(timeline()).toEqual(['reasoning:Plan.', 'reasoning:Check.']);
  });

  it('shows a tool-only reply as a block named for what it did', async () => {
    await render(row(reply(step, search('s1', 'one'), search('s2', 'two'), step, text('Found.'))));
    expect(shown()).toEqual(['work:Searched the web twice', 'text:Found.']);
  });

  it('names the current activity while the reply works, then summarises it', async () => {
    await render(row(reply(step, reasoning('Look it up.')), true));
    // One reasoning run so far: the plain disclosure, thinking.
    expect(shown()).toEqual(['reasoning:Thinking…']);
    const button = header();
    expect(container.querySelector('[data-reasoning-preview]')?.textContent).toBe('Look it up.');

    const running = { ...(search('s1', 'one') as object), state: 'input-available' } as never;
    await render(row(reply(step, reasoning('Look it up.'), running), true));
    // The same element becomes the block and names the tool call.
    expect(shown()).toEqual(['work:Searching the web…']);
    expect(header()).toBe(button);
    expect(container.querySelector('[data-reasoning-preview]')).toBeNull();
    expect(status()?.textContent).toBe('Searching the web…');

    await render(
      row(reply(step, reasoning('Look it up.'), search('s1', 'one'), step, reasoning('Now')), true),
    );
    expect(shown()).toEqual(['work:Thinking…']);
    // The new step's reasoning has the live window.
    expect(container.querySelector('[data-reasoning-preview]')?.textContent).toBe('Now');
    expect(status()?.textContent).toBe('Thinking…');
    // More tokens of the same step are not announced again.
    await render(
      row(
        reply(step, reasoning('Look it up.'), search('s1', 'one'), step, reasoning('Now more')),
        true,
      ),
    );
    expect(status()?.textContent).toBe('Thinking…');

    await render(
      row(
        reply(
          step,
          reasoning('Look it up.'),
          search('s1', 'one'),
          step,
          reasoning('Now more'),
          text('It opens'),
        ),
        true,
      ),
    );
    // The answer has started: the block collapses to its summary.
    expect(shown()).toEqual(['work:Thought · searched the web', 'text:It opens']);
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-reasoning-preview]')).toBeNull();
    expect(container.querySelector('[data-thinking-indicator]')).toBeNull();
  });

  it("keeps the person's choice to expand the block through the answer", async () => {
    const parts = [step, reasoning('Look it up.'), search('s1', 'one'), step, reasoning('Now')];
    await render(row(reply(...parts), true));
    await act(async () => header().click());
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-reasoning-preview]')).toBeNull();
    await render(row(reply(...parts, text('Answer.')), true));
    expect(header().textContent).toBe('Thought · searched the web');
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(timeline()).toHaveLength(3);
    await render(row(reply(...parts, text('Answer.'))));
    expect(header().getAttribute('aria-expanded')).toBe('true');
  });

  it('shows a reply with only text as before', async () => {
    await render(row(reply(step, text('Just an answer.'))));
    expect(shown()).toEqual(['text:Just an answer.']);
    expect(container.querySelector('[aria-label="Steps"]')).toBeNull();
  });

  it('keeps a single-step reply without tools as reasoning then text, thinking until the text starts', async () => {
    await render(row(reply(step, reasoning('Hmm.')), true));
    expect(shown()).toEqual(['reasoning:Thinking…']);
    await render(row(reply(step, reasoning('Hmm.'), text('Answer')), true));
    expect(shown()).toEqual(['reasoning:Reasoning', 'text:Answer']);
    await render(row(reply(step, reasoning('Hmm.'), text('Answer.'))));
    expect(shown()).toEqual(['reasoning:Reasoning', 'text:Answer.']);
    // Unchanged: no timeline, no announcements.
    await act(async () => header().click());
    expect(container.querySelector('[data-work-timeline]')).toBeNull();
    expect(container.querySelector('[data-markdown]')?.textContent).toBe('Hmm.');
    expect(status()).toBeNull();
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
  it('shows its tool steps as one block, then its text in written order', async () => {
    api.get.mockResolvedValue({
      thread: { title: 'Shared', sharedAt: '2026-01-01T00:00:00.000Z' },
      messages: [
        {
          id: 'reply-1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Let me check.' },
            {
              type: 'tool-step',
              toolId: 'web_search',
              summary: "Searched the web for 'hours' · 2 results",
            },
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
    // One collapsed block summarising the steps, then the text in written order.
    const block = article.querySelector<HTMLElement>('[data-reply-group="work"]')!;
    const toggle = block.querySelector('button')!;
    expect(toggle.textContent).toBe('Searched the web twice');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const order = article.textContent ?? '';
    expect(order.indexOf('Searched the web')).toBeLessThan(order.indexOf('Let me check.'));
    expect(order.indexOf('Let me check.')).toBeLessThan(order.indexOf('It opens at nine.'));
    await act(async () => toggle.click());
    expect(
      [...block.querySelectorAll('ol[aria-label="Steps"] > li')].map((li) => li.textContent),
    ).toEqual(["Searched the web for 'hours' · 2 results", 'Searched the web']);
  });
});
