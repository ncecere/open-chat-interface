import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { settledParts } from '../../services/chat/settled-parts.js';

describe('the parts saved when a reply ends', () => {
  it('drops a tool call whose input never finished, and closes streaming text', () => {
    // A reply stopped while the model was writing an artifact (#60).
    const parts = [
      { type: 'text', text: 'Here is the essay', state: 'streaming' },
      {
        type: 'tool-create_artifact',
        toolCallId: 'c1',
        state: 'input-streaming',
        input: { title: 'Ess' },
      },
    ] as unknown as UIMessage['parts'];
    expect(settledParts(parts)).toEqual([
      { type: 'text', text: 'Here is the essay', state: 'done' },
    ]);
  });

  it('keeps finished parts as they are', () => {
    const parts = [
      { type: 'text', text: 'Done', state: 'done' },
      {
        type: 'tool-web_search',
        toolCallId: 's1',
        state: 'output-available',
        input: {},
        output: {},
      },
    ] as unknown as UIMessage['parts'];
    expect(settledParts(parts)).toEqual(parts);
  });
});
