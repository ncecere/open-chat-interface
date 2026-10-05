// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import { MessageRow } from '../../src/components/chat/message-row';
import { replySearchOf } from '../../src/components/chat/search-grounding';
import { workSummary } from '../../src/components/chat/work-summary';

vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

/**
 * "Searched the web" in the reply's work block (v0.11): the search made
 * before a reply and the links tool calls returned are steps of the one block,
 * so a reply shows at most one disclosure above its answer.
 */
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

const results = [
  { title: 'Library hours', url: 'https://library.test/hours', snippet: 'Opens at 9' },
  { title: 'City guide', url: 'https://city.test/guide', snippet: 'Varies' },
];
const grounding = (data: Record<string, unknown> = {}) => ({
  type: 'data-search-grounding',
  data: { query: 'library hours', results, provider: 'SearXNG', ...data },
});
const sources = results.map((result, index) => ({
  type: 'source-url',
  sourceId: `search-${index + 1}`,
  url: result.url,
  title: result.title,
}));
const reply = (...parts: unknown[]): UIMessage => ({
  id: 'a1',
  role: 'assistant',
  parts: parts as UIMessage['parts'],
});
const connectorCall = {
  type: 'tool-mcp__library__lookup',
  toolCallId: 'c1',
  state: 'output-available',
  input: { card: '1' },
  output: { loans: 2 },
};

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
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === name);
/** Collapsed disclosures before the answer's first text. */
const disclosuresAboveAnswer = () => {
  const answer = container.querySelector('[data-reply-group="text"]')!;
  return [...container.querySelectorAll('button[aria-expanded]')].filter(
    (candidate) => candidate.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
};

describe('the search before a reply', () => {
  it('is the first step of the one work block, with its sources inside', async () => {
    await show(
      reply(
        grounding(),
        ...sources,
        { type: 'reasoning', text: 'Both agree.' },
        {
          type: 'text',
          text: 'It opens at 9.',
        },
      ),
    );
    expect(disclosuresAboveAnswer()).toHaveLength(1);
    const header = button('Searched the web · thought')!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Search Grounding Details');
    expect(container.textContent).not.toContain('Library hours');

    await act(async () => header.click());
    const entries = [...container.querySelectorAll('[data-work-entry]')].map(
      (entry) => (entry as HTMLElement).dataset.workEntry,
    );
    expect(entries).toEqual(['search', 'reasoning']);
    const step = button('Searched the web · 2 sources')!;
    await act(async () => step.click());
    expect(step.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('library hours');
    expect(container.textContent).toContain('SearXNG');
    const list = container.querySelector('[aria-label="Sources"]')!;
    expect(list.textContent).toContain('Library hours');
    expect(list.textContent).toContain('https://library.test/hours');
    expect(list.textContent).toContain('Opens at 9');
    // The reply still says the web was used.
    expect(container.querySelector('[aria-label="Web search used"]')).not.toBeNull();
  });

  it('reads "Searched the web" alone, and reports a failed search', async () => {
    await show(reply(grounding(), ...sources, { type: 'text', text: 'It opens at 9.' }));
    expect(button('Searched the web')).toBeDefined();
    expect(disclosuresAboveAnswer()).toHaveLength(1);

    await show(
      reply(grounding({ results: [], error: 'The search provider did not answer.' }), {
        type: 'text',
        text: 'Without the web, I think 9.',
      }),
    );
    const header = button('Web search failed')!;
    await act(async () => header.click());
    const step = [...container.querySelectorAll('[data-work-entry="search"] button')][0]!;
    expect(step.textContent).toBe('Web search failed');
    await act(async () => (step as HTMLButtonElement).click());
    expect(container.textContent).toContain('The search provider did not answer.');
  });

  it('keeps an older reply’s sources, stored without the search details', async () => {
    await show(reply(...sources, { type: 'text', text: 'It opens at 9.' }));
    await act(async () => button('Searched the web')!.click());
    await act(async () => button('Searched the web · 2 sources')!.click());
    expect(container.textContent).toContain('Query not retained for this older response');
  });
});

describe('links a tool call returned', () => {
  it('are a sources step in the block, not a panel of their own', async () => {
    await show(
      reply(
        { type: 'step-start' },
        connectorCall,
        { type: 'source-url', sourceId: 'search-1', url: 'https://library.test/me', title: 'You' },
        { type: 'text', text: 'Two loans.' },
      ),
    );
    expect(disclosuresAboveAnswer()).toHaveLength(1);
    expect(container.textContent).not.toContain('Searched the web');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-reply-group="work"] > button')!.click(),
    );
    await act(async () => button('Sources · 1 link')!.click());
    expect(container.querySelector('[aria-label="Sources"]')?.textContent).toContain(
      'https://library.test/me',
    );
  });

  it('are not repeated for a web search step, which lists its own results', () => {
    const search = {
      type: 'tool-web_search',
      toolCallId: 's1',
      state: 'output-available',
      input: { query: 'hours' },
      output: { query: 'hours', results },
    };
    expect(replySearchOf(reply(search, ...sources, { type: 'text', text: 'Nine.' }))).toEqual({
      presearch: null,
      sources: [],
    });
    // A search before the reply keeps its own sources apart from the tools'.
    expect(
      replySearchOf(
        reply(grounding(), ...sources, connectorCall, {
          type: 'source-url',
          sourceId: 'search-3',
          url: 'https://library.test/me',
          title: 'You',
        }),
      ).sources,
    ).toEqual([{ url: 'https://library.test/me', title: 'You' }]);
  });
});

it('waits for the search with the block’s header, then for the model', async () => {
  const empty: UIMessage = { id: 'live', role: 'assistant', parts: [] };
  await act(() =>
    root.render(<MessageList messages={[empty]} streaming searching onRetry={() => {}} />),
  );
  expect(container.textContent).toContain('Searching the web…');
  await act(() =>
    root.render(
      <MessageList
        messages={[{ ...empty, parts: [grounding()] as UIMessage['parts'] }]}
        streaming
        searching
        onRetry={() => {}}
      />,
    ),
  );
  expect(container.textContent).not.toContain('Searching the web…');
  expect(button('Searched the web')).toBeDefined();
  expect(container.querySelector('[aria-label="Generating response"]')).not.toBeNull();
});

describe('the work summary', () => {
  const presearch = { toolId: 'web_search', label: 'Web search', presearch: true } as const;
  it('leads with a search made before the reply', () => {
    expect(workSummary({ reasoning: true, steps: [{ ...presearch, state: 'done' }] })).toBe(
      'Searched the web · thought',
    );
    expect(
      workSummary({ reasoning: true, steps: [{ ...presearch, state: 'done' }], seconds: 6 }),
    ).toBe('Searched the web · thought for 6s');
    expect(workSummary({ reasoning: false, steps: [{ ...presearch, state: 'done' }] })).toBe(
      'Searched the web',
    );
    expect(workSummary({ reasoning: false, steps: [{ ...presearch, state: 'error' }] })).toBe(
      'Web search failed',
    );
    // With a tool search too, counted together as before.
    expect(
      workSummary({
        reasoning: true,
        steps: [
          { ...presearch, state: 'done' },
          { toolId: 'web_search', label: 'Web search', state: 'done' },
        ],
      }),
    ).toBe('Thought · searched the web twice');
  });
});
