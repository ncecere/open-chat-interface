// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reasoningTail } from '../../src/components/chat/message-reasoning';
import { MessageRow } from '../../src/components/chat/message-row';

/**
 * While a model thinks, its reasoning shows as a collapsed "Thinking…"
 * disclosure with a small window of the latest lines under it; the full text
 * is one click away, and the window goes once the thinking is over.
 */

vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let reducedMotion = false;
function mockMatchMedia() {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  reducedMotion = false;
  mockMatchMedia();
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
const search = (id: string) =>
  ({
    type: 'tool-web_search',
    toolCallId: id,
    state: 'output-available',
    input: { query: 'hours' },
    output: { results: [] },
  }) as never;

function reply(...parts: unknown[]): UIMessage {
  return { id: 'reply-1', role: 'assistant', parts: parts as UIMessage['parts'] };
}

async function render(message: UIMessage, streaming: boolean) {
  await act(async () =>
    root.render(
      <MessageRow
        message={message}
        streaming={streaming}
        editing={false}
        onEditingChange={() => {}}
      />,
    ),
  );
}

const panels = () => [...container.querySelectorAll<HTMLElement>('[data-reply-group="reasoning"]')];
const header = (panel = panels()[0]!) => panel.querySelector<HTMLButtonElement>('button')!;
const preview = (panel = panels()[0]!) =>
  panel.querySelector<HTMLElement>('[data-reasoning-preview]');
const fullText = (panel = panels()[0]!) => panel.querySelector<HTMLElement>('[data-markdown]');
const NOTE = 'Some models hide parts of their thinking';

/** Long enough that the start falls outside the preview's slice. */
const LONG = [
  'FIRST_THOUGHT starts the reasoning.',
  ...Array.from({ length: 30 }, (_, index) => `Line ${index} weighs one more consideration.`),
  'LATEST_THOUGHT is the newest line.',
].join('\n');

async function clickOn(element: HTMLElement) {
  await act(async () => element.click());
}

describe('reasoning while it streams', () => {
  it('shows a Thinking… header with a decorative window of the latest text, not the full text', async () => {
    await render(reply(step, reasoning(LONG)), true);
    const button = header();
    expect(button.textContent).toBe('Thinking…');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const window = preview();
    expect(window).not.toBeNull();
    expect(window?.getAttribute('aria-hidden')).toBe('true');
    expect(window?.textContent).toContain('LATEST_THOUGHT is the newest line.');
    expect(window?.textContent).not.toContain('FIRST_THOUGHT');
    // Plain text in the flow of the reply: no Markdown, no card, no note.
    expect(fullText()).toBeNull();
    expect(window?.className).not.toMatch(/\b(border|rounded|font-mono)\b/);
    expect(panels()[0]?.textContent).not.toContain(NOTE);
    // No live region per token.
    expect(panels()[0]?.querySelector('[aria-live]')).toBeNull();
  });

  it('follows the newest text as it arrives, without Markdown markers', async () => {
    await render(reply(step, reasoning('Start.')), true);
    expect(preview()?.textContent).toBe('Start.');
    await render(reply(step, reasoning('Start.\n\n## Plan\nUse **bold** and `code`.')), true);
    expect(preview()?.textContent).toBe('Start.\nPlan\nUse bold and code.');
  });

  it('expands to the full reasoning from the header or the window', async () => {
    await render(reply(step, reasoning(LONG)), true);
    await clickOn(header());
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(preview()).toBeNull();
    expect(fullText()?.textContent).toContain('FIRST_THOUGHT');
    expect(fullText()?.textContent).toContain('LATEST_THOUGHT');
    expect(panels()[0]?.textContent).toContain(NOTE);

    await act(() => root.unmount());
    root = createRoot(container);
    await render(reply(step, reasoning(LONG)), true);
    await clickOn(preview()!);
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(fullText()?.textContent).toContain('FIRST_THOUGHT');
  });

  it("keeps the person's choice through further streaming and after it finishes", async () => {
    await render(reply(step, reasoning('One.')), true);
    await clickOn(header());
    await render(reply(step, reasoning('One. Two.')), true);
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(fullText()?.textContent).toBe('One. Two.');
    expect(preview()).toBeNull();
    await render(reply(step, reasoning('One. Two.'), text('Answer')), true);
    expect(header().textContent).toBe('Reasoning');
    expect(header().getAttribute('aria-expanded')).toBe('true');

    // Collapsing while it thinks hides the window too, and it stays collapsed.
    await act(() => root.unmount());
    root = createRoot(container);
    await render(reply(step, reasoning('One.')), true);
    await clickOn(header());
    await clickOn(header());
    expect(header().getAttribute('aria-expanded')).toBe('false');
    await render(reply(step, reasoning('One. Two.')), true);
    expect(preview()).toBeNull();
    expect(fullText()).toBeNull();
    expect(header().textContent).toBe('Thinking…');
  });

  it('collapses to Reasoning once the next part starts or the reply ends', async () => {
    await render(reply(step, reasoning(LONG)), true);
    expect(preview()).not.toBeNull();
    await render(reply(step, reasoning(LONG), text('The answer')), true);
    expect(header().textContent).toBe('Reasoning');
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(preview()).toBeNull();
    expect(fullText()).toBeNull();

    await render(reply(step, reasoning('Only thinking.')), true);
    expect(preview()).not.toBeNull();
    await render(reply(step, reasoning('Only thinking.')), false);
    expect(header().textContent).toBe('Reasoning');
    expect(preview()).toBeNull();
  });

  it('gives each reasoning block of a multi-step reply its own window while it is the latest', async () => {
    await render(
      reply(step, reasoning('Search first.'), search('s1'), step, reasoning('Now')),
      true,
    );
    const [first, second] = panels();
    expect(header(first).textContent).toBe('Reasoning');
    expect(preview(first)).toBeNull();
    expect(header(second).textContent).toBe('Thinking…');
    expect(preview(second)?.textContent).toBe('Now');
  });

  it('animates the indicator only while thinking, and not with reduced motion', async () => {
    await render(reply(step, reasoning('Hmm.')), true);
    const indicator = () => container.querySelector('[data-reply-group="reasoning"] svg')!;
    expect(indicator().getAttribute('class')).toContain('motion-safe:animate-pulse');
    await render(reply(step, reasoning('Hmm.')), false);
    expect(indicator().getAttribute('class')).not.toContain('animate-pulse');

    await act(() => root.unmount());
    reducedMotion = true;
    root = createRoot(container);
    await render(reply(step, reasoning('Hmm.')), true);
    expect(header().textContent).toBe('Thinking…');
    expect(indicator().getAttribute('class')).not.toContain('animate-pulse');
  });
});

describe('reasoning from history', () => {
  it('shows collapsed as Reasoning, without the window', async () => {
    await render(reply(step, reasoning(LONG), text('Answer.')), false);
    expect(header().textContent).toBe('Reasoning');
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(preview()).toBeNull();
    expect(fullText()).toBeNull();
    await clickOn(header());
    expect(fullText()?.textContent).toContain('FIRST_THOUGHT');
    expect(panels()[0]?.textContent).toContain(NOTE);
  });
});

describe('the preview text', () => {
  it('keeps a bounded slice of the end', () => {
    const tail = reasoningTail(`${'x'.repeat(5_000)}\nEND`);
    expect(tail.length).toBeLessThanOrEqual(600);
    expect(tail.endsWith('END')).toBe(true);
  });
});
