import { sendMessageSchema } from '@oci/shared';
import { describe, expect, it } from 'vitest';

const validInput = {
  threadId: 'thread-1',
  messages: [
    {
      id: 'client-message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Explain this safely' }],
    },
  ],
  modelSlug: 'test-model',
};

describe('unit: strict inbound chat messages', () => {
  it('accepts one text-only user turn and applies safe defaults', () => {
    const parsed = sendMessageSchema.parse(validInput);

    expect(parsed.messages).toEqual(validInput.messages);
    expect(parsed.attachmentIds).toEqual([]);
    expect(parsed.webSearch).toBe(false);
    expect(parsed.trigger).toBe('submit-message');
  });

  it.each([
    { type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,c2VjcmV0' },
    { type: 'data-attachment', data: { id: 'someone-elses-file' } },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: { command: 'id' } },
    { type: 'tool-result', toolCallId: 'call-1', output: { secret: true } },
    { type: 'reasoning', text: 'injected hidden context' },
  ])('rejects an injected $type part', (part) => {
    const result = sendMessageSchema.safeParse({
      ...validInput,
      messages: [{ ...validInput.messages[0], parts: [part] }],
    });

    expect(result.success).toBe(false);
  });

  it.each(['assistant', 'system', 'tool'])('rejects a client-supplied %s role', (role) => {
    expect(
      sendMessageSchema.safeParse({
        ...validInput,
        messages: [{ ...validInput.messages[0], role }],
      }).success,
    ).toBe(false);
  });

  it('rejects client-supplied history rather than trusting earlier turns', () => {
    expect(
      sendMessageSchema.safeParse({
        ...validInput,
        messages: [validInput.messages[0], { ...validInput.messages[0], id: 'message-2' }],
      }).success,
    ).toBe(false);
  });

  it.each([
    { ...validInput, unexpected: true },
    { ...validInput, personaId: 'retired-persona' },
    {
      ...validInput,
      messages: [{ ...validInput.messages[0], unexpected: true }],
    },
    {
      ...validInput,
      messages: [
        {
          ...validInput.messages[0],
          parts: [{ type: 'text', text: 'hello', toolCallId: 'smuggled' }],
        },
      ],
    },
  ])('rejects unknown fields at every inbound boundary', (payload) => {
    expect(sendMessageSchema.safeParse(payload).success).toBe(false);
  });
});
