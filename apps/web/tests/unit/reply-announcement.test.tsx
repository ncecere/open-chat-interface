// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import type { HistoryControls } from '../../src/hooks/use-history-pages';

/**
 * 4.1.3 (#401, D6): a person who cannot see the page is told that a reply is
 * coming and that it has ended, in a polite live region, and is never read the
 * streamed words. A fake chat session walks the message list through the
 * states a real one goes through, and the region's text is read at each step.
 */
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

const STARTED = 'The assistant is replying.';
const COMPLETE = 'Reply complete.';
const STOPPED = 'Reply stopped.';
/** Longer than the pause the list waits to be sure a reply has ended. */
const SETTLED = 1_000;

interface FakeSession {
  streaming: boolean;
  messages: UIMessage[];
  /** What the conversation's own alert shows for a failure (`session.error`). */
  failed: boolean;
}

let container: HTMLDivElement;
let root: Root;
let drive: (next: Partial<FakeSession>) => Promise<void>;
let history: HistoryControls | undefined;
/** Every distinct text the reply region took, in order: what a screen reader was handed. */
let said: string[];
let watcher: MutationObserver;

const question: UIMessage = { id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] };
const assistant = (id: string, text: string, metadata?: Record<string, unknown>): UIMessage => ({
  id,
  role: 'assistant',
  parts: text ? [{ type: 'text', text }] : [],
  ...(metadata ? { metadata } : {}),
});

function Session({ start }: { start: FakeSession }) {
  const [session, setSession] = useState(start);
  drive = (next) => act(async () => setSession((current) => ({ ...current, ...next })));
  return (
    <MessageList
      messages={session.messages}
      streaming={session.streaming}
      replyFailed={session.failed}
      history={history}
      onRetry={() => {}}
    />
  );
}

const region = () => container.querySelector<HTMLElement>('[data-reply-status]');
const text = () => region()?.textContent ?? '';
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

async function open(start: Partial<FakeSession> = {}) {
  // Watching from before the first render: a region that already holds its text when it
  // appears is not announced, so what changes after the page is up is what counts.
  said = [];
  watcher = new MutationObserver(() => {
    const now = text();
    if (now && said.at(-1) !== now) said.push(now);
  });
  watcher.observe(container, { childList: true, characterData: true, subtree: true });
  await act(async () =>
    root.render(
      <Session start={{ streaming: false, messages: [question], failed: false, ...start }} />,
    ),
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  history = undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  watcher?.disconnect();
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('a reply is announced, not read out', () => {
  it('is a polite status that exists before anything is said, and says nothing at rest', async () => {
    await open();
    const status = region();
    expect(status).not.toBeNull();
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(status?.className).toContain('sr-only');
    expect(text()).toBe('');
    await advance(SETTLED);
    expect(said).toEqual([]);
  });

  it('says a reply started, then that it is complete, and never the words', async () => {
    await open();
    await drive({ streaming: true, messages: [question, assistant('a1', '')] });
    expect(text()).toBe(STARTED);
    const words = ['Once', ' upon', ' a', ' time', ' there', ' was', ' a', ' library'];
    let written = '';
    for (const word of words) {
      written += word;
      await drive({ messages: [question, assistant('a1', written)] });
      await advance(200);
      expect(text()).toBe(STARTED);
    }
    // Not repeated while it streams, and not a word of the reply in it.
    expect(said).toEqual([STARTED]);
    expect(container.textContent).toContain('Once upon a time there was a library');
    expect(text()).not.toContain('library');

    await drive({ streaming: false, messages: [question, assistant('a1', written)] });
    // Not at the first moment: the pause tells an end from a hiccup.
    expect(text()).toBe(STARTED);
    await advance(SETTLED);
    expect(text()).toBe(COMPLETE);
    expect(said).toEqual([STARTED, COMPLETE]);
    // And it stays quiet afterwards.
    await advance(10_000);
    expect(said).toEqual([STARTED, COMPLETE]);
  });

  it('announces a second reply again', async () => {
    await open();
    await drive({ streaming: true, messages: [question, assistant('a1', '')] });
    await drive({ messages: [question, assistant('a1', 'One')] });
    await drive({ streaming: false });
    await advance(SETTLED);
    const second = [question, assistant('a1', 'One'), { ...question, id: 'q2' }];
    await drive({ streaming: true, messages: second });
    await drive({ messages: [...second, assistant('a2', 'Two')] });
    await drive({ streaming: false });
    await advance(SETTLED);
    expect(said).toEqual([STARTED, COMPLETE, STARTED, COMPLETE]);
  });

  it('says a stopped reply was stopped, not that it is complete', async () => {
    await open();
    await drive({ streaming: true, messages: [question, assistant('a1', 'Half an')] });
    await drive({
      streaming: false,
      messages: [question, assistant('a1', 'Half an', { status: 'cancelled' })],
    });
    await advance(SETTLED);
    expect(said).toEqual([STARTED, STOPPED]);
  });

  it('leaves a failed reply to its alert: one alert, nothing said in the status', async () => {
    await open();
    await drive({ streaming: true, messages: [question, assistant('a1', '')] });
    await drive({
      streaming: false,
      messages: [
        question,
        assistant('a1', '', { status: 'error', errorMessage: 'The model could not be reached' }),
      ],
    });
    await advance(SETTLED);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'The model could not be reached',
    );
    expect(said).toEqual([STARTED]);
    expect(text()).toBe('');
  });

  it('leaves a failure the conversation reports itself to its alert too', async () => {
    await open();
    await drive({ streaming: true, messages: [question, assistant('a1', 'Partial')] });
    await drive({ streaming: false, failed: true });
    await advance(SETTLED);
    // The page shows the error as an alert (thread.tsx); a "complete" here would contradict it.
    expect(said).toEqual([STARTED]);
    expect(text()).toBe('');
  });

  it('does not say complete when nothing answered', async () => {
    await open();
    await drive({ streaming: true });
    await drive({ streaming: false });
    await advance(SETTLED);
    expect(said).toEqual([STARTED]);
  });

  it('is one announcement, not two, when a reply recovers after the connection was lost', async () => {
    await open();
    await drive({ streaming: true, messages: [question, assistant('a1', 'The li')] });
    // The connection drops: for a moment nothing is streaming, then the page
    // follows the reply on the server, and the saved reply replaces the partial one.
    await drive({ streaming: false });
    await advance(300);
    await drive({ streaming: true });
    await advance(5_000);
    expect(said).toEqual([STARTED]);
    await drive({
      streaming: false,
      messages: [question, assistant('a1', 'The library opens at nine.', { status: 'complete' })],
    });
    await advance(SETTLED);
    expect(said).toEqual([STARTED, COMPLETE]);
  });

  it('announces a reply that is already under way when the conversation opens', async () => {
    await open({ streaming: true, messages: [question, assistant('a1', 'So far')] });
    await advance(0);
    expect(said).toEqual([STARTED]);
  });

  it('keeps the history announcement apart: neither repeats the other', async () => {
    history = {
      hasOlder: true,
      gapAfter: null,
      loading: null,
      error: null,
      loadOlder: vi.fn(),
      loadGap: vi.fn(),
      announcement: 'Loaded 20 messages earlier in the conversation.',
    };
    await open();
    const regions = [...container.querySelectorAll('[role="status"]')];
    expect(regions.map((node) => node.textContent)).toContain(history.announcement);
    await drive({ streaming: true, messages: [question, assistant('a1', '')] });
    await drive({ streaming: false, messages: [question, assistant('a1', 'Done')] });
    await advance(SETTLED);
    expect(said).toEqual([STARTED, COMPLETE]);
    const history$ = regions.find((node) => node.textContent === history?.announcement);
    expect(history$).not.toBe(region());
    expect(history$?.textContent).toBe(history.announcement);
  });
});
