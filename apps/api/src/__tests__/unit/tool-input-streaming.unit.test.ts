import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  jsonSchema,
  streamText,
  tool,
} from 'ai';
import { describe, expect, it } from 'vitest';

/**
 * A tool call's arguments reach the browser as they are written (v0.9 live
 * artifacts): an OpenAI-compatible provider streaming function-call arguments
 * in pieces must come out of OCI's stream as `tool-input-start`, one
 * `tool-input-delta` per piece and then `tool-input-available`, in the SSE
 * frames the conversation reads (and the Redis capture copies verbatim).
 */

const ARGUMENT_PIECES = [
  '{"title":"Sign-',
  'Up Page","kind":"html","content":"<!doctype html>\\n',
  '<form>',
  '</form>"}',
];

/** A provider's chat completion stream with one function call, its arguments in pieces. */
function providerStream(): Response {
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'gpt-oss' };
  const chunks = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'create_artifact', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    ...ARGUMENT_PIECES.map((piece) => ({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] },
          finish_reason: null,
        },
      ],
    })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function frames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
}

describe('streamed tool input', () => {
  it('reaches the response as start, one delta per piece, then the full input', async () => {
    const model = createOpenAICompatible({
      name: 'test',
      baseURL: 'http://provider.test/v1',
      fetch: async () => providerStream(),
    })('gpt-oss');
    const result = streamText({
      model,
      prompt: 'Make a sign-up page',
      tools: {
        create_artifact: tool({
          inputSchema: jsonSchema<{ title: string; kind: string; content: string }>({
            type: 'object',
            properties: {
              title: { type: 'string' },
              kind: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['title', 'kind', 'content'],
          }),
          execute: async ({ title }) => ({ artifactId: 'a1', title, kind: 'html', version: 1 }),
        }),
      },
    });
    // The same composition as the chat route: a UI message stream served as SSE.
    const response = createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => writer.merge(result.toUIMessageStream({ sendStart: false })),
      }),
    });
    const events = frames(await response.text());
    const types = events.map((event) => event.type);

    const start = types.indexOf('tool-input-start');
    const available = types.indexOf('tool-input-available');
    const deltas = events.filter((event) => event.type === 'tool-input-delta');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(events[start]).toMatchObject({ toolCallId: 'call_1', toolName: 'create_artifact' });
    expect(deltas.map((event) => event.inputTextDelta)).toEqual(ARGUMENT_PIECES);
    // Every piece arrives before the call is complete, and the output after it.
    expect(types.lastIndexOf('tool-input-delta')).toBeLessThan(available);
    expect(types.indexOf('tool-input-delta')).toBeGreaterThan(start);
    expect(events[available]).toMatchObject({
      input: { title: 'Sign-Up Page', kind: 'html', content: '<!doctype html>\n<form></form>' },
    });
    expect(types.indexOf('tool-output-available')).toBeGreaterThan(available);
  });
});
