import { Chat } from '@ai-sdk/react';
import type { UIMessage, UIMessageChunk } from 'ai';
import { expect, it } from 'vitest';

it('the installed SDK preserves historical identities while replacing streamed snapshots', async () => {
  const history: UIMessage[] = [
    { id: 'old-user', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    { id: 'old-assistant', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] },
  ];
  const snapshots: UIMessage[][] = [];
  const chat = new Chat({
    messages: history,
    transport: {
      reconnectToStream: async () => null,
      sendMessages: async () =>
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: 'live' });
            controller.enqueue({ type: 'text-start', id: 'text' });
            for (let chunk = 0; chunk < 5; chunk++) {
              controller.enqueue({ type: 'text-delta', id: 'text', delta: 'x' });
            }
            controller.enqueue({ type: 'text-end', id: 'text' });
            controller.enqueue({ type: 'finish' });
            controller.close();
          },
        }),
    },
  });
  const unsubscribe = chat['~registerMessagesCallback'](() => snapshots.push(chat.messages));
  try {
    await chat.sendMessage({ text: 'Next question' });
    expect(chat.error).toBeUndefined();
    expect(snapshots.length).toBeGreaterThan(5);
    for (const snapshot of snapshots) {
      expect(snapshot[0]).toBe(history[0]);
      expect(snapshot[1]).toBe(history[1]);
    }
    const live = snapshots
      .map((snapshot) => snapshot.find((message) => message.id === 'live'))
      .filter(Boolean);
    expect(new Set(live).size).toBe(live.length);
    expect(live.at(-1)?.parts).toEqual([{ type: 'text', text: 'xxxxx', state: 'done' }]);
    // The first push uses the producer's object; subsequent replacements are
    // cloned snapshots. Only those replacement snapshots promise immutability.
    expect(live[1]?.parts).not.toEqual(live.at(-1)?.parts);
  } finally {
    unsubscribe();
  }
});
