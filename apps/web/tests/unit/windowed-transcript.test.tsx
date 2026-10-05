// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import type { HistoryControls } from '../../src/hooks/use-history-pages';
import { WINDOW_THRESHOLD } from '../../src/hooks/use-windowed-rows';

vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

/**
 * A small layout engine for happy-dom, which has none: every message row is
 * ROW px tall, spacers are their style height, containers the sum of their
 * children, and the scroller shows VIEW px from its scrollTop.
 */
const ROW = 100;
const VIEW = 600;
let scroller: HTMLDivElement;
let scrollTop = 0;
function height(element: Element): number {
  const html = element as HTMLElement;
  if (html.dataset?.rowKey) return ROW;
  if (html.hasAttribute?.('data-row-spacer')) return Number.parseFloat(html.style.height) || 0;
  let sum = 0;
  for (const child of element.children) sum += height(child);
  return sum;
}
function offset(element: Element): number {
  if (element === scroller || !element.parentElement) return 0;
  const row = element.parentElement.closest('[data-row-key]');
  if (row && row !== element) return offset(row);
  let top = offset(element.parentElement);
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  )
    top += height(sibling);
  return top;
}
function rect(element: Element): DOMRect {
  if (element === scroller) return { top: 0, bottom: VIEW, height: VIEW } as DOMRect;
  const row = element.closest('[data-row-key]') ?? element;
  const top = offset(row) - scrollTop;
  const size = height(row);
  return { top, bottom: top + size, height: size, left: 0, right: 0, width: 0 } as DOMRect;
}

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.callback(
        [
          {
            target,
            borderBoxSize: [{ blockSize: height(target), inlineSize: 0 }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
}

const message = (n: number, text = `message ${n}`): UIMessage => ({
  id: `m${n}`,
  role: n % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text }],
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => message(from + index));

let container: HTMLDivElement;
let root: Root;
let scrollRef: RefObject<HTMLDivElement | null>;
const original = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: FakeResizeObserver });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return rect(this);
  };
  scrollTop = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  scrollRef = createRef<HTMLDivElement>();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  HTMLElement.prototype.getBoundingClientRect = original;
});

function Transcript(props: {
  messages: UIMessage[];
  streaming?: boolean;
  anchorId?: string;
  history?: HistoryControls;
}) {
  return (
    <div
      ref={(element) => {
        if (!element || element === scroller) return;
        scroller = element;
        scrollRef.current = element;
        Object.defineProperties(element, {
          clientHeight: { get: () => VIEW, configurable: true },
          scrollHeight: { get: () => height(element), configurable: true },
          scrollTop: {
            get: () => scrollTop,
            set: (value: number) => {
              scrollTop = Math.max(0, value);
            },
            configurable: true,
          },
        });
      }}
    >
      <MessageList
        messages={props.messages}
        streaming={props.streaming ?? false}
        onRetry={() => {}}
        scrollRef={scrollRef}
        anchorId={props.anchorId}
        history={props.history}
      />
    </div>
  );
}
const render = (props: Parameters<typeof Transcript>[0]) =>
  act(async () => {
    root.render(<Transcript {...props} />);
  });
const frames = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
const rendered = () =>
  [...container.querySelectorAll<HTMLElement>('[data-message-id]')].map(
    (row) => row.dataset.messageId,
  );
/** The rendered message at the top of the view, if the view is covered. */
const inSight = () =>
  [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find((row) => {
    const box = rect(row);
    return box.top <= 0 && box.bottom > 0;
  })?.dataset.messageId;
const scrollTo = async (top: number) => {
  scrollTop = top;
  await act(async () => {
    scroller.dispatchEvent(new Event('scroll'));
  });
  await frames();
};

describe('windowed transcript', () => {
  it('renders every row of an ordinary conversation', async () => {
    await render({ messages: range(0, WINDOW_THRESHOLD) });
    expect(rendered()).toHaveLength(WINDOW_THRESHOLD);
    expect(container.querySelector('[data-windowed]')).toBeNull();
  });

  it('renders the end of a long conversation and streams its last reply', async () => {
    const messages = range(0, 600);
    await render({ messages, streaming: true });
    scrollTop = 600 * ROW;
    await scrollTo(height(scroller) - VIEW);
    const shown = rendered();
    expect(container.querySelector('[data-windowed]')).not.toBeNull();
    expect(shown.length).toBeLessThan(60);
    expect(shown.at(-1)).toBe('m599');
    // The rows not rendered keep their room.
    expect(height(scroller)).toBeGreaterThan(590 * ROW);

    const streamed = [...messages.slice(0, -1), message(599, 'message 599 and more streamed text')];
    await render({ messages: streamed, streaming: true });
    expect(container.querySelector('[data-message-id="m599"]')?.textContent).toContain(
      'more streamed text',
    );
  });

  it('follows the reader and keeps the opened search result rendered', async () => {
    await render({ messages: range(0, 600), anchorId: 'm10' });
    expect(rendered()).toContain('m10');
    await scrollTo(300 * ROW);
    // Estimated heights place row ~250 there; whatever it is, it is rendered.
    const top = Number(inSight()?.slice(1));
    expect(top).toBeGreaterThan(200);
    const shown = rendered();
    expect(shown).toContain('m10');
    expect(shown).not.toContain('m599');
  });

  it('keeps the message in sight where it was when an earlier page arrives', async () => {
    const latest = range(100, 220);
    await render({ messages: latest });
    await scrollTo(50 * ROW + 30);
    const before = rect(container.querySelector('[data-message-id="m150"]')!).top;
    expect(before).toBe(-30);

    // One page earlier: 240 rows, now windowed. m150 does not move.
    await render({ messages: [...range(0, 100), ...latest] });
    await frames();
    const row = container.querySelector('[data-message-id="m150"]');
    expect(row).not.toBeNull();
    expect(container.querySelector('[data-windowed]')).not.toBeNull();
    expect(rect(row!).top).toBe(-30);

    // And again, already windowed.
    await render({ messages: [...range(-100, 0), ...range(0, 100), ...latest] });
    await frames();
    expect(rect(container.querySelector('[data-message-id="m150"]')!).top).toBe(-30);
  });

  it('keeps the focused row rendered when the reader scrolls away', async () => {
    await render({ messages: range(0, 400) });
    await scrollTo(10 * ROW);
    const focusable = document.createElement('button');
    container.querySelector('[data-message-id="m12"]')!.append(focusable);
    await act(async () => focusable.focus());
    await scrollTo(300 * ROW);
    expect(Number(inSight()?.slice(1))).toBeGreaterThan(200);
    expect(rendered()).toContain('m12');
    expect(rendered()).not.toContain('m40');
  });
});

describe('earlier messages', () => {
  const controls = (overrides: Partial<HistoryControls> = {}): HistoryControls => ({
    hasOlder: true,
    gapAfter: null,
    loading: null,
    error: null,
    loadOlder: vi.fn(),
    loadGap: vi.fn(),
    announcement: '',
    ...overrides,
  });
  const button = (name: string) =>
    [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === name);

  it('offers a button that loads them, then marks the start and keeps focus there', async () => {
    const history = controls();
    await render({ messages: range(0, 4), history });
    const load = button('Load earlier messages')!;
    await act(async () => load.focus());
    await act(async () => load.click());
    expect(history.loadOlder).toHaveBeenCalledOnce();

    await render({ messages: range(0, 4), history: controls({ loading: 'older' }) });
    expect(button('Loading earlier messages…')?.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[data-message-rows]')?.getAttribute('aria-busy')).toBe('true');

    const announcement =
      'Loaded 4 messages earlier in the conversation. This is the start of the conversation.';
    await render({ messages: range(0, 4), history: controls({ hasOlder: false, announcement }) });
    const start = [...container.querySelectorAll('p')].find(
      (paragraph) => paragraph.textContent === 'This is the start of the conversation.',
    );
    expect(document.activeElement).toBe(start);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(announcement);
  });

  it('shows nothing for a conversation that is all loaded', async () => {
    await render({ messages: range(0, 4), history: controls({ hasOlder: false }) });
    expect(container.textContent).not.toContain('earlier messages');
    expect(container.textContent).not.toContain('start of the conversation');
  });

  it('shows the gap after an island with a button that continues it', async () => {
    const history = controls({ gapAfter: 2 });
    await render({ messages: range(0, 6), history });
    const gap = container.querySelector('[data-history-gap]')!;
    const rows = [...container.querySelectorAll('[data-row-key]')].map(
      (row) => (row as HTMLElement).dataset.rowKey,
    );
    expect(rows).toEqual(['m0', 'm1', 'history-gap', 'm2', 'm3', 'm4', 'm5']);
    expect(gap.textContent).toContain('Some messages here are not loaded yet.');
    await act(async () => button('Load more messages')!.click());
    expect(history.loadGap).toHaveBeenCalledWith('down');
  });
});
