// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import { ToolSteps } from '../../src/components/chat/tool-steps';
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

describe('tool steps', () => {
  it('shows a collapsed one-line summary that expands to inputs and a result summary', async () => {
    await act(() => root.render(<ToolSteps message={reply(searched)} />));
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
  });

  it('shows the note when a reply hit its step limit', async () => {
    await act(() =>
      root.render(
        <ToolSteps
          message={reply(searched, {
            type: 'data-tool-limit',
            data: { reason: 'steps', steps: 8 },
          })}
        />,
      ),
    );
    expect(container.querySelector('[role="note"]')?.textContent).toBe(
      'This reply reached the limit of 8 steps and stopped.',
    );
  });

  it('asks for approval with the tool, its connector and the exact inputs', async () => {
    const onAnswer = vi.fn();
    await act(() => root.render(<ToolSteps message={reply(awaiting)} onAnswer={onAnswer} />));
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

  it('denies with the Deny button and disables answers while a reply streams', async () => {
    const onAnswer = vi.fn();
    await act(() =>
      root.render(<ToolSteps message={reply(awaiting)} onAnswer={onAnswer} disabled />),
    );
    expect(button('Approve')!.disabled).toBe(true);
    await act(() => root.render(<ToolSteps message={reply(awaiting)} onAnswer={onAnswer} />));
    await act(async () => button('Deny')!.click());
    expect(onAnswer).toHaveBeenCalledWith('approval-1', false);
  });

  it('shows an answered approval without buttons, then the finished step', async () => {
    const responded = {
      ...awaiting,
      state: 'approval-responded',
      approval: { id: 'approval-1', approved: true },
    };
    await act(() => root.render(<ToolSteps message={reply(responded)} onAnswer={vi.fn()} />));
    expect(button('Approve')).toBeUndefined();
    expect(container.textContent).toContain('Approved. Continuing the reply…');
    const denied = {
      ...awaiting,
      state: 'output-denied',
      approval: { id: 'approval-1', approved: false, reason: 'not answered' },
    };
    await act(() => root.render(<ToolSteps message={reply(denied)} />));
    expect(container.querySelector('section[data-testid="tool-approval"]')).toBeNull();
    expect(container.textContent).toContain('mcp__crm__create_note was not run (not answered)');
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
    expect(container.textContent).toContain("Searching the web for 'library opening hours'");
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
