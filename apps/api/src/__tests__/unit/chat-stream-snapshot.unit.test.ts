import { describe, expect, it } from 'vitest';
import { parseStoredSnapshot, ReplaySnapshot } from '../../services/chat-stream-snapshot.js';

const sse = (chunk: Record<string, unknown>) => `data: ${JSON.stringify(chunk)}\n\n`;
const parse = (frame: string) => JSON.parse(frame.slice(6, -2));

function snapshotOf(chunks: Array<Record<string, unknown> | string>) {
  const snapshot = new ReplaySnapshot();
  for (const chunk of chunks) snapshot.observe(typeof chunk === 'string' ? chunk : sse(chunk));
  return snapshot;
}

describe('ReplaySnapshot', () => {
  it('merges the deltas of each part and keeps everything else in order', () => {
    const snapshot = snapshotOf([
      { type: 'start', messageId: 'm1' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Think ' },
      { type: 'reasoning-delta', id: 'r1', delta: 'hard.' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hel' },
      { type: 'data-context-window', data: { limited: true } },
      { type: 'text-delta', id: 't1', delta: 'lo', providerMetadata: { p: { n: 1 } } },
      { type: 'text-end', id: 't1' },
      'data: [DONE]\n\n',
    ]);
    expect(snapshot.size).toBe(11);
    const frames = snapshot.frames();
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
    expect(frames.slice(0, -1).map(parse)).toEqual([
      { type: 'start', messageId: 'm1' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Think hard.' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello', providerMetadata: { p: { n: 1 } } },
      { type: 'data-context-window', data: { limited: true } },
      { type: 'text-end', id: 't1' },
    ]);
  });

  it('starts a new delta when a part id is used again in a later step', () => {
    const frames = snapshotOf([
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'one' },
      { type: 'text-end', id: '0' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'two' },
    ])
      .frames()
      .map(parse);
    expect(frames.filter((chunk) => chunk.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: '0', delta: 'one' },
      { type: 'text-delta', id: '0', delta: 'two' },
    ]);
  });

  it('keeps an artifact draft as one delta, and drops it once the full input arrives', () => {
    const writing = snapshotOf([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'create_artifact' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"title":' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '"Plan","con' },
    ]);
    expect(writing.frames().map(parse)).toEqual([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'create_artifact' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"title":"Plan","con' },
    ]);
    writing.observe(
      sse({
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'create_artifact',
        input: { title: 'Plan', content: 'x' },
      }),
    );
    expect(writing.frames().map((frame) => parse(frame).type)).toEqual([
      'tool-input-start',
      'tool-input-available',
    ]);
    // A failed input keeps its draft for the client to show.
    const failed = snapshotOf([
      { type: 'tool-input-start', toolCallId: 'c2', toolName: 'create_artifact' },
      { type: 'tool-input-delta', toolCallId: 'c2', inputTextDelta: '{"bro' },
      {
        type: 'tool-input-error',
        toolCallId: 'c2',
        toolName: 'create_artifact',
        input: {},
        errorText: 'x',
      },
    ]);
    expect(failed.frames()).toHaveLength(3);
  });

  it('keeps frames it cannot read as they are', () => {
    const frames = snapshotOf([
      'data: {broken\n\n',
      'data: [1,2]\n\n',
      'event: x\n\n',
      sse({ type: 'text-delta' }),
    ]).frames();
    expect(frames).toEqual([
      'data: {broken\n\n',
      'data: [1,2]\n\n',
      'event: x\n\n',
      sse({ type: 'text-delta' }),
    ]);
  });
});

describe('parseStoredSnapshot', () => {
  it('accepts only a positive sequence with string frames', () => {
    expect(parseStoredSnapshot(JSON.stringify({ sequence: 3, frames: ['a'] }))).toEqual({
      sequence: 3,
      frames: ['a'],
    });
    for (const bad of [
      null,
      '',
      'not json',
      'null',
      '[]',
      JSON.stringify({ sequence: 0, frames: [] }),
      JSON.stringify({ sequence: 1.5, frames: [] }),
      JSON.stringify({ sequence: '2', frames: [] }),
      JSON.stringify({ sequence: 2, frames: 'a' }),
      JSON.stringify({ sequence: 2, frames: [1] }),
    ])
      expect(parseStoredSnapshot(bad)).toBeNull();
  });
});
