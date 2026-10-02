import { describe, expect, it } from 'vitest';
import { latestTurnReplies, pathThrough } from '../../services/chat/reply-path.js';

type Row = { id: string; role: string; supersededAt: Date | null };
const replaced = new Date('2026-01-01T00:00:00Z');
const row = (id: string, role: string, superseded = false): Row => ({
  id,
  role,
  supersededAt: superseded ? replaced : null,
});
const ids = (rows: Row[] | null) => rows?.map((entry) => entry.id) ?? null;

// u1 was retried twice (a1, a1b replaced; a1c active); u2 has one reply.
const conversation = [
  row('u1', 'user'),
  row('a1', 'assistant', true),
  row('a1b', 'assistant', true),
  row('a1c', 'assistant'),
  row('u2', 'user'),
  row('a2', 'assistant'),
];

describe('pathThrough', () => {
  it('follows the active path through a user message or an active reply', () => {
    expect(ids(pathThrough(conversation, 'u2'))).toEqual(['u1', 'a1c', 'u2']);
    expect(ids(pathThrough(conversation, 'a2'))).toEqual(['u1', 'a1c', 'u2', 'a2']);
    expect(ids(pathThrough(conversation, 'a1c'))).toEqual(['u1', 'a1c']);
  });

  it('lets a selected replaced reply stand in for its turn, before or after the active one', () => {
    expect(ids(pathThrough(conversation, 'a1'))).toEqual(['u1', 'a1']);
    expect(ids(pathThrough(conversation, 'a1b'))).toEqual(['u1', 'a1b']);
    const switchedBack = [row('u1', 'user'), row('a1', 'assistant'), row('a1b', 'assistant', true)];
    expect(ids(pathThrough(switchedBack, 'a1b'))).toEqual(['u1', 'a1b']);
  });

  it('keeps a reply that precedes any user message, and reports an unknown selection', () => {
    expect(ids(pathThrough([row('a0', 'assistant')], 'a0'))).toEqual(['a0']);
    expect(pathThrough(conversation, 'missing')).toBeNull();
  });
});

describe('latestTurnReplies', () => {
  it('lists every reply to the latest turn only when it has alternatives', () => {
    expect(ids(latestTurnReplies(conversation))).toEqual([]);
    expect(ids(latestTurnReplies(conversation.slice(0, 4)))).toEqual(['a1', 'a1b', 'a1c']);
    expect(ids(latestTurnReplies([...conversation, row('a2b', 'assistant', true)]))).toEqual([
      'a2',
      'a2b',
    ]);
  });

  it('is empty without a user turn or once a new prompt awaits its reply', () => {
    expect(latestTurnReplies([row('a0', 'assistant'), row('a1', 'assistant')])).toEqual([]);
    expect(latestTurnReplies([...conversation.slice(0, 4), row('u2', 'user')])).toEqual([]);
  });
});
