import { describe, expect, it } from 'vitest';

type Part = { type: string; text?: string };
type Message = { role: 'user' | 'assistant'; parts: Part[] };

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

function reasoningOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Mirrors what the message list decides while a run is active.
 *
 * The bug this covers: the indicator previously keyed off the last message
 * still being the user's, so it vanished the moment an empty assistant row was
 * created — which is exactly when a model is thinking and the wait is longest.
 */
function waitingState(messages: Message[], streaming: boolean) {
  const last = messages.at(-1);
  const lastIsAssistant = last?.role === 'assistant';
  const text = lastIsAssistant && last ? textOf(last) : '';
  const reasoning = lastIsAssistant && last ? reasoningOf(last) : '';
  const hasVisibleContent = Boolean(text || reasoning);

  return {
    showIndicator: streaming && !hasVisibleContent,
    label: reasoning ? 'Thinking' : 'Working on it',
  };
}

const user: Message = { role: 'user', parts: [{ type: 'text', text: 'hello' }] };

describe('streaming feedback', () => {
  it('shows the indicator immediately after sending', () => {
    expect(waitingState([user], true).showIndicator).toBe(true);
  });

  it('keeps showing it while an empty assistant message waits on the model', () => {
    // The row exists but has nothing in it yet. This is the case that used to
    // go silent for the entire time a model spent reasoning.
    const messages: Message[] = [user, { role: 'assistant', parts: [] }];
    expect(waitingState(messages, true).showIndicator).toBe(true);
  });

  it('keeps showing it when only empty parts have arrived', () => {
    const messages: Message[] = [user, { role: 'assistant', parts: [{ type: 'text', text: '' }] }];
    expect(waitingState(messages, true).showIndicator).toBe(true);
  });

  it('hides it once answer text begins streaming', () => {
    const messages: Message[] = [
      user,
      { role: 'assistant', parts: [{ type: 'text', text: 'The answer' }] },
    ];
    expect(waitingState(messages, true).showIndicator).toBe(false);
  });

  it('hides it once reasoning begins, since the panel then shows progress', () => {
    const messages: Message[] = [
      user,
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'Considering' }] },
    ];
    expect(waitingState(messages, true).showIndicator).toBe(false);
  });

  it('names the wait differently once reasoning is what is happening', () => {
    const thinking: Message[] = [
      user,
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'Considering' }] },
    ];
    expect(waitingState(thinking, true).label).toBe('Thinking');
    // A provider that reveals no reasoning still gets an honest label.
    expect(waitingState([user], true).label).toBe('Working on it');
  });

  it('shows nothing when no run is active', () => {
    const messages: Message[] = [user, { role: 'assistant', parts: [] }];
    expect(waitingState(messages, false).showIndicator).toBe(false);
  });
});

/** Mirrors the reasoning panel's default open state. */
function panelOpen(choice: boolean | null, streaming: boolean, answerStarted: boolean): boolean {
  return choice ?? (streaming && !answerStarted);
}

describe('reasoning panel disclosure', () => {
  it('opens itself while reasoning is the only thing happening', () => {
    expect(panelOpen(null, true, false)).toBe(true);
  });

  it('closes once the answer starts, which is what the reader wants', () => {
    expect(panelOpen(null, true, true)).toBe(false);
  });

  it('stays closed on a finished message', () => {
    expect(panelOpen(null, false, true)).toBe(false);
  });

  it('respects an explicit choice over the default', () => {
    expect(panelOpen(false, true, false)).toBe(false);
    expect(panelOpen(true, false, true)).toBe(true);
  });
});
