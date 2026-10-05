import { APICallError, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import {
  retryAfterMs,
  retryableStatus,
  type Throttle,
  withProviderRetries,
} from '../../services/providers/retry.js';

/** Retrying a provider's "not now" before the first output only (v0.11 design, item 15). */

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const refusal = (status: number, headers: Record<string, string> = {}) =>
  new APICallError({
    message: 'Rate limited',
    url: 'http://stub/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    isRetryable: status === 429 || status >= 500,
  });

type Chunk = Record<string, unknown> & { type: string };
const finish = { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } };
const stream = (chunks: Chunk[]) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
const text = (value: string): Chunk[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: value },
  { type: 'text-end', id: 't' },
  finish,
];

/** A model answering each request with the next scripted reply. */
function scripted(replies: Array<Error | Chunk[]>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: (async () => {
      const reply = replies[Math.min(call++, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return { stream: stream(reply) };
    }) as never,
  });
}

async function run(model: ReturnType<typeof withProviderRetries>) {
  const result = streamText({ model, prompt: 'hi', maxRetries: 0, onError: () => {} });
  let output = '';
  const errors: unknown[] = [];
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') output += part.text;
    if (part.type === 'error') errors.push(part.error);
  }
  return { output, errors };
}

describe('provider retries', () => {
  it('waits as long as Retry-After asks, then succeeds; extra requests are counted', async () => {
    const sleep = vi.fn(async () => {});
    const throttles: Throttle[] = [];
    const extra = vi.fn();
    const model = withProviderRetries(
      scripted([refusal(429, { 'retry-after': '3' }), text('hello')]),
      { sleep, onThrottle: (t) => throttles.push(t), onExtraRequest: extra },
    );
    expect(await run(model)).toEqual({ output: 'hello', errors: [] });
    expect(sleep).toHaveBeenCalledWith(3_000, undefined);
    expect(throttles).toEqual([{ status: 429, retryAfterMs: 3_000, retrying: true }]);
    expect(extra).toHaveBeenCalledTimes(1);
  });

  it('retries an overload that arrives as the stream’s first event', async () => {
    const sleep = vi.fn(async () => {});
    const model = withProviderRetries(
      scripted([
        [
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: 'r' },
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        ],
        text('after overload'),
      ]),
      { sleep },
    );
    expect(await run(model)).toEqual({ output: 'after overload', errors: [] });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('never retries once output has started', async () => {
    const sleep = vi.fn(async () => {});
    const doStream = vi.fn();
    const model = withProviderRetries(
      new MockLanguageModelV4({
        doStream: (async () => {
          doStream();
          return {
            stream: stream([
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'partial ' },
              { type: 'error', error: { type: 'overloaded_error' } },
            ]),
          };
        }) as never,
      }),
      { sleep },
    );
    const result = await run(model);
    expect(result.output).toBe('partial ');
    expect(result.errors).toHaveLength(1);
    expect(doStream).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the retry limit, or when the wait would pass the budget', async () => {
    const sleep = vi.fn(async () => {});
    const throttles: Throttle[] = [];
    const always = withProviderRetries(scripted([refusal(503)]), {
      sleep,
      onThrottle: (t) => throttles.push(t),
      policy: { maxRetries: 2, baseDelayMs: 10 },
    });
    const failed = await run(always);
    expect(failed.output).toBe('');
    expect(failed.errors).toHaveLength(1);
    expect(throttles.map((t) => t.retrying)).toEqual([true, true, false]);

    sleep.mockClear();
    const tooLong = withProviderRetries(scripted([refusal(429, { 'retry-after': '120' })]), {
      sleep,
      policy: { budgetMs: 60_000 },
    });
    expect((await run(tooLong)).errors).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('passes other errors through at once', async () => {
    const sleep = vi.fn(async () => {});
    const model = withProviderRetries(scripted([refusal(400)]), { sleep });
    expect((await run(model)).errors).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops waiting when the reply is stopped', async () => {
    const abort = new AbortController();
    const model = withProviderRetries(scripted([refusal(429, { 'retry-after': '30' })]), {
      signal: abort.signal,
    });
    const pending = run(model);
    setTimeout(() => abort.abort(new Error('user-stop')), 20);
    const result = await pending;
    expect(result.output).toBe('');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('reports the first request and its first output once, retries included (service objectives)', async () => {
    const sleep = vi.fn(async () => {});
    const first = vi.fn();
    const output = vi.fn();
    const model = withProviderRetries(scripted([refusal(503), text('one'), text('two')]), {
      sleep,
      onFirstRequest: first,
      onFirstOutput: output,
    });
    expect(await run(model)).toEqual({ output: 'one', errors: [] });
    // A later request of the same reply (a tool step) reports nothing.
    expect(await run(model)).toEqual({ output: 'two', errors: [] });
    expect(first).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
  });

  it('reports no first output when the provider never produced one', async () => {
    const output = vi.fn();
    const model = withProviderRetries(scripted([refusal(400)]), { onFirstOutput: output });
    const result = await run(model);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(output).not.toHaveBeenCalled();
  });

  it('reads Retry-After in every form, and classifies refusals', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(retryAfterMs(refusal(429, { 'retry-after-ms': '1500' }), now)).toBe(1_500);
    expect(retryAfterMs(refusal(429, { 'Retry-After': '2' }), now)).toBe(2_000);
    expect(
      retryAfterMs(refusal(429, { 'retry-after': 'Sun, 04 Oct 2026 12:00:05 GMT' }), now),
    ).toBe(5_000);
    expect(retryAfterMs(refusal(429, { 'retry-after': 'soon' }), now)).toBeNull();
    expect(retryAfterMs(refusal(429), now)).toBeNull();
    expect(retryAfterMs(new Error('x'), now)).toBeNull();
    expect(retryableStatus(refusal(429))).toBe(429);
    expect(retryableStatus(refusal(400))).toBeNull();
    expect(retryableStatus({ type: 'overloaded_error' })).toBe(529);
    expect(retryableStatus({ error: { type: 'rate_limit_error' } })).toBe(429);
    expect(retryableStatus({ error: { code: 'server_error' } })).toBe(503);
    expect(retryableStatus({ code: 502 })).toBe(502);
    expect(retryableStatus('boom')).toBeNull();
    expect(retryableStatus(null)).toBeNull();
  });
});
