import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  regenerationContext,
  textFromParts,
  textParts,
} from '../../services/chat/message-parts.js';

const userTurn = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
});

describe('unit: chat preparation', () => {
  it.each([undefined, null, 1, 'text', {}, { type: 'text', text: 'not an array' }])(
    'ignores non-array parts: %j',
    (parts) => {
      expect(textParts(parts)).toEqual([]);
      expect(textFromParts(parts)).toBe('');
    },
  );

  it('copies only string-valued text parts without untrusted metadata', () => {
    const parts = [
      null,
      'text',
      42,
      {},
      { type: 'text', text: 12 },
      { type: 'text', text: null },
      { type: 'file', text: 'not text' },
      { type: 'tool-result', text: 'not context' },
      { type: 'text', text: 'first', injected: true },
      { type: 'text', text: '' },
      { type: 'text', text: 'last' },
    ];
    expect(textParts(parts)).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: '' },
      { type: 'text', text: 'last' },
    ]);
    expect(textFromParts(parts)).toBe('first\n\nlast');
    expect(textParts(parts)[0]).not.toBe(parts[8]);
  });

  it('regenerates through the stored user turn without rewriting later history', () => {
    const stored = [
      userTurn('earlier', 'earlier'),
      {
        ...userTurn('target', 'original'),
        parts: [
          { type: 'text', text: 'original', metadata: 'server-only' },
          { type: 'data-attachment', data: { id: 'upload' } },
        ],
      },
      { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
      userTurn('later', 'later'),
    ];
    const snapshot = structuredClone(stored);
    const result = regenerationContext(stored, userTurn('target', 'original'), []);

    expect(result.contextMessages).toEqual(stored.slice(0, 2));
    expect(result.contextMessages).not.toBe(stored);
    expect(result.promptMessageId).toBe('target');
    expect(result.latest).toEqual(userTurn('target', 'original'));
    expect(stored).toEqual(snapshot);
  });

  it('rejects attachments before examining the regeneration target', () => {
    expect(() => regenerationContext([], userTurn('missing', 'text'), ['upload'])).toThrow(
      'Attachments cannot be added while regenerating a response',
    );
  });

  it.each(['missing', 'assistant'])('rejects a %s target', (id) => {
    const stored = [{ id: 'assistant', role: 'assistant', parts: [] }];
    expect(() => regenerationContext(stored, userTurn(id, 'text'), [])).toThrow(
      'The regeneration target must be a user message in this thread',
    );
  });

  it('rejects changed regeneration text', () => {
    expect(() =>
      regenerationContext([userTurn('target', 'original')], userTurn('target', 'changed'), []),
    ).toThrow('The stored user message cannot be changed during regeneration');
  });

  it('preserves text comparison semantics across part boundaries', () => {
    const stored = [
      {
        id: 'target',
        role: 'user',
        parts: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    ];
    const result = regenerationContext(stored, userTurn('target', 'first\nsecond'), []);
    expect(result.latest.parts).toEqual(stored[0]?.parts);
  });
});
