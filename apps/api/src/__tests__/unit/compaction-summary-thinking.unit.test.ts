import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CompactionPlan } from '../../services/chat/compaction-span.js';
import { summarize, type Tally } from '../../services/chat/compaction-summary.js';
import { createLanguageModel } from '../../services/providers/registry.js';

/**
 * Summaries for a model that thinks (#202), against a fake OpenAI-compatible
 * gateway over HTTP. The gateway behaves like the LiteLLM alias
 * `claude-haiku-4.5-thinking` in front of Bedrock: thinking is switched on at
 * the gateway with a fixed budget the application cannot see, and a request
 * whose `max_tokens` is not above that budget is refused with the error
 * Anthropic gives. A model without thinking accepts any limit.
 */
const THINKING_BUDGET = 8000;
let server: Server;
let baseUrl: string;
const requests: Array<{ model: string; max_tokens?: number }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { model: string; max_tokens?: number };
      requests.push(parsed);
      const thinks = parsed.model.endsWith('-thinking');
      if (thinks && (parsed.max_tokens ?? 0) <= THINKING_BUDGET) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message:
                'litellm.BadRequestError: BedrockException - The model returned the following errors: `max_tokens` must be greater than `thinking.budget_tokens`.',
              type: 'invalid_request_error',
              code: '400',
            },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'summary-test',
          object: 'chat.completion',
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '## Topic and goal\nOwls.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  requests.length = 0;
});

const plan: CompactionPlan = {
  previous: null,
  summarized: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'List three facts about owls.' }] },
    {
      id: 'm2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Owls fly silently, hear well and turn their heads.' }],
    },
  ],
  firstKeptMessageId: 'm3',
  messagesSummarized: 2,
  tokensSummarized: 100,
};

function model(upstreamId: string, capabilities: string[]) {
  return {
    slug: upstreamId,
    languageModel: createLanguageModel(
      { kind: 'openai-compatible', label: 'Fake gateway', apiKey: 'test', baseUrl },
      upstreamId,
    ),
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    capabilities,
    supportedEfforts: [],
  };
}

const tally = (): Tally => ({
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  started: false,
  complete: true,
});

describe('summaries for a model that thinks (#202)', () => {
  it('sends an output limit above the gateway’s thinking budget, so the summary is made', async () => {
    const counts = tally();
    const summary = await summarize(
      plan,
      model('claude-haiku-4.5-thinking', ['reasoning', 'tool_calling', 'vision']),
      null,
      counts,
    );
    expect(summary).toBe('## Topic and goal\nOwls.');
    expect(counts).toMatchObject({ calls: 1, inputTokens: 40, outputTokens: 12 });
    // The model's whole output limit, as its replies are sent with.
    expect(requests).toEqual([
      expect.objectContaining({ model: 'claude-haiku-4.5-thinking', max_tokens: 16_000 }),
    ]);
  });

  it('keeps the small summary limit for a model that does not think', async () => {
    await summarize(plan, model('gpt-4.1-mini', ['tool_calling']), null, tally());
    expect(requests).toEqual([
      expect.objectContaining({ model: 'gpt-4.1-mini', max_tokens: 4096 }),
    ]);
  });
});
