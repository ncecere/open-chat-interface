import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamText } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLanguageModel } from '../../services/providers/registry.js';
import { reasoningCallSettings } from '../../services/reasoning.js';

let server: Server;
let baseUrl: string;
const requests: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        [
          `data: ${JSON.stringify({
            id: 'reasoning-test',
            object: 'chat.completion.chunk',
            model: 'reasoning-test',
            choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
          })}`,
          `data: ${JSON.stringify({
            id: 'reasoning-test',
            object: 'chat.completion.chunk',
            model: 'reasoning-test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}`,
          'data: [DONE]',
          '',
        ].join('\n\n'),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function callWithEffort(effort: 'instant' | 'high') {
  const model = createLanguageModel(
    {
      kind: 'openai-compatible',
      label: 'Test Gateway',
      apiKey: 'test',
      baseUrl,
    },
    'reasoning-test',
  );
  const result = streamText({
    model,
    prompt: 'test',
    ...reasoningCallSettings(effort, 'openai-compatible'),
  });
  await result.consumeStream();
  return requests.at(-1);
}

describe('openai-compatible reasoning wire format', () => {
  it('sends the selected high level to the gateway', async () => {
    expect(await callWithEffort('high')).toMatchObject({ reasoning_effort: 'high' });
  });

  it('sends instant as explicit none rather than provider default', async () => {
    expect(await callWithEffort('instant')).toMatchObject({ reasoning_effort: 'none' });
  });
});
