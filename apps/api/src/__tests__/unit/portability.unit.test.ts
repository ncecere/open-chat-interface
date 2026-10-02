import { describe, expect, it } from 'vitest';
import {
  detectConversationSource,
  mapChatGptConversation,
  mapClaudeConversation,
} from '../../services/portability/import-mappers.js';
import { isSafeEntryName } from '../../services/portability/import-reader.js';
import { NameAllocator, safeEntrySegment } from '../../services/portability/zip-writer.js';

const text = (role: string, value: string, extra: Record<string, unknown> = {}) => ({
  author: { role },
  content: { content_type: 'text', parts: [value] },
  recipient: 'all',
  metadata: {},
  ...extra,
});

describe('ChatGPT mapping', () => {
  it('without current_node, follows the heaviest leaf, then the most recent', () => {
    const result = mapChatGptConversation({
      id: 'c',
      title: 'Leaves',
      mapping: {
        u: {
          id: 'u',
          parent: null,
          children: ['light', 'heavy', 'late'],
          message: text('user', 'Q'),
        },
        light: {
          id: 'light',
          parent: 'u',
          children: [],
          message: text('assistant', 'light', { weight: 0.5 }),
        },
        heavy: {
          id: 'heavy',
          parent: 'u',
          children: [],
          message: text('assistant', 'heavy', { weight: 1, create_time: 10 }),
        },
        late: {
          id: 'late',
          parent: 'u',
          children: [],
          message: text('assistant', 'late', { weight: 1, create_time: 20 }),
        },
      },
    });
    expect(result.conversation?.messages.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'Q' }],
      [{ type: 'text', text: 'late' }],
    ]);
  });

  it('survives a parent cycle and null fields', () => {
    const result = mapChatGptConversation({
      id: 'cycle',
      title: null,
      create_time: null,
      current_node: 'b',
      mapping: {
        a: { id: 'a', parent: 'b', children: ['b'], message: text('user', 'loop') },
        b: { id: 'b', parent: 'a', children: ['a'], message: text('assistant', 'round') },
        n: { id: 'n', parent: null, children: [], message: null },
      },
    });
    expect(result.conversation?.title).toBe('Imported conversation');
    expect(result.conversation?.messages).toHaveLength(2);
    expect(result.conversation?.createdAt).toBeNull();
  });

  it('reports an empty or malformed conversation instead of throwing', () => {
    expect(mapChatGptConversation({ id: 'x', mapping: {} }).reason).toBe('empty');
    expect(mapChatGptConversation({ title: 'no id', mapping: {} }).reason).toBe('invalid');
    expect(mapChatGptConversation(null).reason).toBe('invalid');
  });

  it('keeps only code the user saw, as a fenced block', () => {
    const result = mapChatGptConversation({
      id: 'code',
      current_node: 'a',
      mapping: {
        u: { id: 'u', parent: null, children: ['a'], message: text('user', 'Show code') },
        a: {
          id: 'a',
          parent: 'u',
          children: [],
          message: {
            author: { role: 'assistant' },
            recipient: 'all',
            content: { content_type: 'code', language: 'ts', text: 'let x = 1;' },
          },
        },
      },
    });
    expect(result.conversation?.messages[1]?.parts).toEqual([
      { type: 'text', text: '```ts\nlet x = 1;\n```' },
    ]);
  });
});

describe('Claude mapping', () => {
  it('uses array order when messages carry no parent links', () => {
    const result = mapClaudeConversation({
      uuid: 'u',
      name: 'Plain',
      current_leaf_message_uuid: 'b',
      chat_messages: [
        { uuid: 'a', sender: 'human', text: 'one' },
        { uuid: 'b', sender: 'assistant', text: 'two' },
        { uuid: 'c', sender: 'assistant', text: 'three' },
      ],
    });
    // Consecutive replies merge into one, so they are not read as regenerations.
    expect(result.conversation?.messages.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'one' }],
      [
        { type: 'text', text: 'two' },
        { type: 'text', text: 'three' },
      ],
    ]);
  });
});

describe('format detection', () => {
  it('tells the two exports apart by shape', () => {
    expect(detectConversationSource({ mapping: {} })).toBe('chatgpt');
    expect(detectConversationSource({ uuid: 'x', chat_messages: [] })).toBe('claude');
    expect(detectConversationSource({ uuid: 'x' })).toBeNull();
    expect(detectConversationSource([])).toBeNull();
  });
});

describe('archive path safety', () => {
  it('rejects traversal, absolute and drive paths', () => {
    for (const name of [
      '../a.json',
      'a/../../b',
      '/etc/passwd',
      'C:\\x.json',
      '..\\x',
      'a\u0000b',
    ]) {
      expect(isSafeEntryName(name)).toBe(false);
    }
    for (const name of ['conversations.json', 'a/b/c.json', 'notes..json']) {
      expect(isSafeEntryName(name)).toBe(true);
    }
  });

  it('writes attachment names as single safe segments, disambiguating repeats', () => {
    expect(safeEntrySegment('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeEntrySegment('...')).toBe('file');
    const names = new NameAllocator();
    expect(names.allocate('a.txt')).toBe('a.txt');
    expect(names.allocate('A.txt')).toBe('A (2).txt');
    expect(names.allocate('a.txt')).toBe('a (3).txt');
  });
});
