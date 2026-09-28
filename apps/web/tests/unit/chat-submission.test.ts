import type { UIMessage } from 'ai';
import { expect, it } from 'vitest';
import {
  confirmedAttachmentIds,
  confirmPromptId,
  readChatSubmission,
} from '../../src/lib/chat-submission';

it('reads the serialized submission rather than a later composer queue', () => {
  expect(
    readChatSubmission(
      JSON.stringify({
        messages: [{ id: 'local', role: 'user', parts: [] }],
        attachmentIds: ['a'],
      }),
    ),
  ).toEqual({ clientMessageId: 'local', attachmentIds: ['a'] });
  for (const value of [
    undefined,
    'invalid',
    'null',
    '{}',
    JSON.stringify({ messages: [{ id: 'x', role: 'assistant' }], attachmentIds: ['a'] }),
    JSON.stringify({ messages: [{ id: 'x', role: 'user' }], attachmentIds: [4] }),
  ])
    expect(readChatSubmission(value)).toBeNull();
});

it('only persisted user attachment references confirm allocation, not assistant output', () => {
  const data = (id: unknown) => ({ type: 'data-attachment' as const, data: { id } });
  const messages: UIMessage[] = [
    {
      id: 'u',
      role: 'user',
      parts: [data('a'), data('a'), data(3), { type: 'data-attachment', data: null }],
    },
    { id: 'a', role: 'assistant', parts: [data('next-turn-file')] },
  ];
  expect(confirmedAttachmentIds(messages)).toEqual(['a']);
});

it('confirms the prompt ID without modifying its content or historical message identities', () => {
  const messages: UIMessage[] = [
    { id: 'past', role: 'assistant', parts: [{ type: 'text', text: 'Past' }] },
    {
      id: 'local',
      role: 'user',
      parts: [{ type: 'text', text: 'Question' }],
      metadata: { note: 'preserve' },
    },
  ];
  const confirmed = confirmPromptId(messages, 'local', 'stored');
  expect(confirmed[0]).toBe(messages[0]);
  expect(confirmed[1]).toEqual({ ...messages[1], id: 'stored' });
  expect(confirmed[1]?.parts).toBe(messages[1]?.parts);
  expect(messages[1]?.id).toBe('local');
  expect(confirmPromptId(confirmed, 'stored', 'stored')).toBe(confirmed);
});
