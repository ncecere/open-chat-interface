import { once } from 'node:events';
import type { Server } from 'node:http';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFixtureProvider,
  FIXTURE_MODEL,
  RESPONSE_MARKDOWN,
  STREAM_CHUNKS,
} from './provider.js';
import { validateDatabaseUrl } from './server.js';

describe('browser fixture database safety', () => {
  it('requires an explicit URL, independent of DATABASE_URL', () => {
    expect(() => validateDatabaseUrl(undefined)).toThrow('Explicit TEST_DATABASE_URL');
  });

  it.each([
    'postgres://user:password@example.com/db',
    'postgres://user:password@127.0.0.1/db?host=example.com',
    'postgres://user:password@127.0.0.1/db?port=5432',
    'postgres://user:password@127.0.0.1/db#fragment',
    'https://127.0.0.1/db',
    'postgres://127.0.0.1/',
    'not a url',
  ])('rejects unsafe or ambiguous URL %s', (url) => {
    expect(() => validateDatabaseUrl(url)).toThrow();
  });

  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts loopback %s', (host) => {
    expect(validateDatabaseUrl(`postgres://user:password@${host}:55441/test`)).toContain(host);
  });
});

describe('local OpenAI-compatible fixture provider', () => {
  let server: Server;
  let baseUrl: string;
  beforeEach(async () => {
    server = createFixtureProvider({ initialDelayMs: 1, chunkDelayMs: 1 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  const complete = (base: string, body: unknown, signal?: AbortSignal) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  it('returns deterministic non-streaming markdown with synthetic usage', async () => {
    const response = await complete(baseUrl, { model: FIXTURE_MODEL, stream: false });
    const body = (await response.json()) as {
      choices: [{ message: { content: string }; finish_reason: string }];
      usage: { total_tokens: number };
    };
    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe(RESPONSE_MARKDOWN);
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(5_512);
    expect(Buffer.byteLength(RESPONSE_MARKDOWN)).toBeGreaterThan(18_000);
    expect(Buffer.byteLength(RESPONSE_MARKDOWN)).toBeLessThan(24_000);
  });

  it('sends role, 100 text deltas, finish, usage, and DONE in that order', async () => {
    const response = await complete(baseUrl, { model: FIXTURE_MODEL, stream: true });
    const frames = (await response.text()).trim().split('\n\n');
    expect(frames.pop()).toBe('data: [DONE]');
    const chunks = frames.map((frame) => JSON.parse(frame.slice('data: '.length)));
    expect(chunks).toHaveLength(STREAM_CHUNKS + 3);
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(
      chunks
        .slice(1, 101)
        .map((chunk) => chunk.choices[0].delta.content)
        .join(''),
    ).toBe(RESPONSE_MARKDOWN);
    expect(chunks[101].choices[0].finish_reason).toBe('stop');
    expect(chunks[102].choices).toEqual([]);
    expect(chunks[102].usage.total_tokens).toBe(5_512);
  });

  it('works through the actual OpenAI-compatible AI SDK', async () => {
    const provider = createOpenAICompatible({
      name: 'fixture',
      baseURL: `${baseUrl}/v1`,
      apiKey: 'local-fixture-not-a-real-key',
      includeUsage: true,
    });
    const result = streamText({ model: provider(FIXTURE_MODEL), prompt: 'Local test only.' });
    let text = '';
    for await (const part of result.textStream) text += part;
    expect(text).toBe(RESPONSE_MARKDOWN);
    expect(await result.finishReason).toBe('stop');
    expect((await result.usage).outputTokens).toBe(5_000);
  });

  it('rejects unknown models and invalid stream flags', async () => {
    expect((await complete(baseUrl, { model: 'external-model' })).status).toBe(400);
    expect((await complete(baseUrl, { model: FIXTURE_MODEL, stream: 'true' })).status).toBe(400);
  });

  it('cleans timers and records cancellation without exposing request content', async () => {
    const abort = new AbortController();
    const response = await complete(baseUrl, { model: FIXTURE_MODEL, stream: true }, abort.signal);
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    await expect
      .poll(async () => {
        const stats = (await (await fetch(`${baseUrl}/stats`)).json()) as Record<string, number>;
        return { active: stats.activeStreams, cancelled: stats.cancelledStreams };
      })
      .toEqual({ active: 0, cancelled: 1 });
    const stats = (await (await fetch(`${baseUrl}/stats`)).json()) as Record<string, number>;
    expect(Object.values(stats).every((value) => typeof value === 'number')).toBe(true);
  });
});
