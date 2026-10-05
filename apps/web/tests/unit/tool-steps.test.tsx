// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import { MessageRow } from '../../src/components/chat/message-row';
import type { AnswerApproval } from '../../src/components/chat/tool-steps';
import {
  approvalResponsesOf,
  denyUnansweredApprovals,
  hasOpenApproval,
} from '../../src/lib/tool-approvals';

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
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

const searched = {
  type: 'tool-web_search',
  toolCallId: 's1',
  state: 'output-available',
  input: { query: 'library opening hours' },
  output: {
    query: 'library opening hours',
    results: [
      { title: 'Library hours', url: 'https://library.test/hours', snippet: 'RAW_SNIPPET' },
      { title: 'City guide', url: 'https://city.test', snippet: 'more' },
    ],
  },
};
const awaiting = {
  type: 'tool-mcp__crm__create_note',
  toolCallId: 'w1',
  state: 'approval-requested',
  input: { account: 'Acme', text: 'Call back Monday' },
  approval: { id: 'approval-1' },
};
function reply(...parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts: parts as UIMessage['parts'] };
}
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(name),
  );

function show(
  message: UIMessage,
  { onAnswer, streaming = false }: { onAnswer?: AnswerApproval; streaming?: boolean } = {},
) {
  return act(() =>
    root.render(
      <MessageRow
        message={message}
        streaming={streaming}
        editing={false}
        onEditingChange={() => {}}
        onAnswerApproval={onAnswer}
      />,
    ),
  );
}
const block = () => container.querySelector<HTMLElement>('[data-reply-group="work"]');
const blockHeader = () => block()!.querySelector<HTMLButtonElement>('button')!;
const expandBlock = () => act(async () => blockHeader().click());

describe('tool steps', () => {
  it('shows a collapsed one-line summary that expands to inputs and a result summary', async () => {
    await show(reply(searched));
    // A reply with tool calls and no reasoning: the work block names what it did.
    expect(blockHeader().textContent).toBe('Searched the web');
    expect(blockHeader().getAttribute('aria-expanded')).toBe('false');
    expect(button("Searched the web for 'library opening hours'")).toBeUndefined();
    await expandBlock();
    const toggle = button("Searched the web for 'library opening hours' · 2 results")!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Library hours');
    await act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`),
    ).not.toBeNull();
    expect(container.textContent).toContain('"query": "library opening hours"');
    expect(container.textContent).toContain('Library hours');
    // A summary of the result, never the raw snippets.
    expect(container.textContent).not.toContain('RAW_SNIPPET');
    // Each result says where it leads, as the search before a reply does.
    const sources = container.querySelector('ul[aria-label="Sources"]');
    expect(sources?.textContent).toContain('https://library.test/hours');
    expect(sources?.querySelectorAll('li')).toHaveLength(2);
  });

  it('shows the note when a reply hit its step limit, outside the block', async () => {
    await show(
      reply(searched, {
        type: 'data-tool-limit',
        data: { reason: 'steps', steps: 8 },
      }),
    );
    const note = container.querySelector('[role="note"]')!;
    expect(note.textContent).toBe(
      'This reply reached the limit of 8 tool steps, so it answered with what it had found.',
    );
    expect(block()!.contains(note)).toBe(false);
  });

  it('shows the limit note alone when the reply made no tool call', async () => {
    await show(reply({ type: 'data-tool-limit', data: { reason: 'allowance' } }));
    expect(block()).toBeNull();
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      'usage allowance ran out',
    );
  });

  it('asks for approval with the tool, its connector and the exact inputs', async () => {
    const onAnswer = vi.fn();
    await show(reply(awaiting), { onAnswer });
    const card = container.querySelector('section[data-testid="tool-approval"]')!;
    const heading = card.querySelector('h3')!;
    expect(card.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(card.textContent).toContain('mcp__crm__create_note');
    expect(card.textContent).toContain('Connector');
    expect(card.textContent).toContain('crm');
    expect(card.querySelector('pre')?.textContent).toContain('"text": "Call back Monday"');
    expect(card.querySelector('[role="status"]')?.textContent).toContain(
      'is waiting for your approval',
    );
    const approve = button('Approve')!;
    expect(approve.getAttribute('type')).toBe('button');
    await act(async () => approve.click());
    expect(onAnswer).toHaveBeenCalledWith('approval-1', true);
    const status = card.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe('Approved. Continuing the reply.');
    expect(document.activeElement).toBe(status);
  });

  it('keeps a waiting approval outside the collapsed block, above the text', async () => {
    await show(
      reply(
        { type: 'reasoning', text: 'Search, then note.' },
        searched,
        { type: 'reasoning', text: 'Now the note.' },
        { type: 'text', text: 'I can send that note.' },
        awaiting,
      ),
      { onAnswer: vi.fn() },
    );
    expect(blockHeader().textContent).toBe('Thought · searched the web');
    expect(blockHeader().getAttribute('aria-expanded')).toBe('false');
    const card = container.querySelector('section[data-testid="tool-approval"]')!;
    expect(block()!.contains(card)).toBe(false);
    const text = container.querySelector('[data-reply-group="text"]')!;
    expect(block()!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Expanded, the timeline has the steps but not the approval.
    await expandBlock();
    expect(block()!.querySelector('ol[aria-label="Steps"]')?.children).toHaveLength(3);
    expect(block()!.textContent).not.toContain('create_note');
  });

  it('denies with the Deny button and disables answers while a reply streams', async () => {
    const onAnswer = vi.fn();
    await show(reply(awaiting), { onAnswer, streaming: true });
    expect(button('Approve')!.disabled).toBe(true);
    await show(reply(awaiting), { onAnswer });
    await act(async () => button('Deny')!.click());
    expect(onAnswer).toHaveBeenCalledWith('approval-1', false);
  });

  it('shows an answered approval without buttons, then the finished step in the block', async () => {
    const responded = {
      ...awaiting,
      state: 'approval-responded',
      approval: { id: 'approval-1', approved: true },
    };
    await show(reply(responded), { onAnswer: vi.fn() });
    expect(button('Approve')).toBeUndefined();
    expect(container.textContent).toContain('Approved. Continuing the reply…');
    const denied = {
      ...awaiting,
      state: 'output-denied',
      approval: { id: 'approval-1', approved: false, reason: 'not answered' },
    };
    await show(reply(denied));
    expect(container.querySelector('section[data-testid="tool-approval"]')).toBeNull();
    expect(blockHeader().textContent).toBe('A step was not run');
    await expandBlock();
    expect(container.textContent).toContain('mcp__crm__create_note was not run (not answered)');
  });

  it('moves focus to the block once an approval answered here has run', async () => {
    const onAnswer = vi.fn();
    await show(reply(awaiting), { onAnswer });
    await act(async () => button('Approve')!.click());
    await show(reply({ ...awaiting, state: 'output-available', output: { ok: true } }), {
      onAnswer,
      streaming: true,
    });
    expect(container.querySelector('section[data-testid="tool-approval"]')).toBeNull();
    expect(document.activeElement).toBe(blockHeader());
  });

  it('counts a tool step as visible progress in the conversation', async () => {
    const running = { ...searched, state: 'input-available', output: undefined };
    await act(() =>
      root.render(
        <MessageList
          messages={[
            { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hours?' }] },
            reply(running),
          ]}
          streaming
          onRetry={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('Searching the web…');
    expect(container.querySelector('[aria-label="Generating response"]')).toBeNull();
  });
});

describe('approval answers', () => {
  it('collects answered approvals of the latest reply for the approvals request', () => {
    expect(approvalResponsesOf(reply(awaiting))).toEqual([]);
    expect(
      approvalResponsesOf(
        reply(
          { ...awaiting, state: 'approval-responded', approval: { id: 'a', approved: true } },
          {
            ...awaiting,
            toolCallId: 'w2',
            state: 'approval-responded',
            approval: { id: 'b', approved: false },
          },
          {
            ...awaiting,
            toolCallId: 'w3',
            state: 'approval-responded',
            approval: { id: 'c', approved: true, isAutomatic: true },
          },
        ),
      ),
    ).toEqual([
      { approvalId: 'a', approved: true },
      { approvalId: 'b', approved: false },
    ]);
    expect(approvalResponsesOf({ id: 'u', role: 'user', parts: [] })).toEqual([]);
  });

  it('denies unanswered approvals as "not answered" when a new message is sent', () => {
    const user: UIMessage = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    const messages = [user, reply(searched, awaiting)];
    expect(hasOpenApproval(messages)).toBe(true);
    const next = denyUnansweredApprovals(messages);
    expect(next[0]).toBe(user);
    expect(next[1]!.parts[1]).toMatchObject({
      state: 'output-denied',
      approval: { id: 'approval-1', approved: false, reason: 'not answered' },
    });
    expect(next[1]!.parts[0]).toBe(messages[1]!.parts[0]);
    expect(hasOpenApproval(next)).toBe(false);
    expect(denyUnansweredApprovals(next)).toBe(next);
  });
});
