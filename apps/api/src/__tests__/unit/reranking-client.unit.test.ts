import {
  providerCanRerank,
  RERANK_TIMEOUT_MS,
  rerankEndpoint,
  rerankingSettingsSchema,
} from '@oci/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../lib/errors.js';
import {
  MAX_RERANK_RESPONSE_BYTES,
  parseRerankResponse,
  type RerankRequest,
  rerank,
} from '../../services/reranking/client.js';
import {
  isRerankingActive,
  normalizeRerankingSettings,
  rerankUsageSlug,
} from '../../services/reranking/config.js';
import { rerankCostMicros } from '../../services/reranking/usage.js';

const KEY = 'sk-very-secret-rerank-key';

function request(overrides: Partial<RerankRequest> = {}): RerankRequest {
  return {
    endpoint: 'https://gateway.example/v1/rerank',
    apiKey: KEY,
    provider: 'Gateway',
    model: 'bge-reranker-v2-m3',
    query: 'how do I reset my password?',
    documents: ['cafeteria hours', 'reset your password in Settings', 'parking permits'],
    ...overrides,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fetch = vi.fn(handler);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** Runs `rerank` and returns the error it throws, checking it never leaks the key. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).message).not.toContain(KEY);
  expect((error as AppError).status).toBe(502);
  return error as AppError;
}

/** A body that only ends (with an error) when the request's signal aborts. */
function endlessBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['));
      signal?.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rerank client', () => {
  it('posts the Cohere-compatible request with the bearer key', async () => {
    const fetch = stubFetch(() =>
      json({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
          { index: 2, relevance_score: 0.4 },
        ],
      }),
    );
    const result = await rerank(request());
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://gateway.example/v1/rerank');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'bge-reranker-v2-m3',
      query: 'how do I reset my password?',
      documents: ['cafeteria hours', 'reset your password in Settings', 'parking permits'],
      top_n: 3,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Best first, whatever order the server listed them in.
    expect(result).toEqual({
      ranking: [
        { index: 1, score: 0.9 },
        { index: 2, score: 0.4 },
        { index: 0, score: 0.1 },
      ],
      tokens: 0,
    });
  });

  it('sends no Authorization header without a key, and caps top_n at the documents sent', async () => {
    const fetch = stubFetch(() => json({ results: [{ index: 0, relevance_score: 1 }] }));
    await rerank(request({ apiKey: null, topN: 10 }));
    const init = fetch.mock.calls[0]![1];
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(init.body as string).top_n).toBe(3);
    await rerank(request({ topN: 2 }));
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string).top_n).toBe(2);
  });

  it('sends nothing for no documents', async () => {
    const fetch = stubFetch(() => json({ results: [] }));
    expect(await rerank(request({ documents: [] }))).toEqual({ ranking: [], tokens: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts the Cohere v2, Jina and vLLM shape with documents and usage', async () => {
    stubFetch(() =>
      json({
        id: 'r-1',
        model: 'jina-reranker-v2-base-multilingual',
        usage: { total_tokens: 42 },
        results: [
          { index: 2, document: { text: 'parking permits' }, relevance_score: 0.3 },
          { index: 1, document: { text: 'reset' }, relevance_score: 0.8 },
        ],
      }),
    );
    expect(await rerank(request())).toEqual({
      ranking: [
        { index: 1, score: 0.8 },
        { index: 2, score: 0.3 },
      ],
      tokens: 42,
    });
  });

  it('reads tokens from Cohere and LiteLLM metadata', async () => {
    const results = [{ index: 0, relevance_score: 0.5 }];
    stubFetch(() =>
      json({ results, meta: { billed_units: { input_tokens: 7, search_units: 1 } } }),
    );
    expect((await rerank(request())).tokens).toBe(7);
    stubFetch(() => json({ results, meta: { tokens: { input_tokens: 9 } } }));
    expect((await rerank(request())).tokens).toBe(9);
    stubFetch(() => json({ results, usage: { total_tokens: -3 }, meta: 'none' }));
    expect((await rerank(request())).tokens).toBe(0);
  });

  it("accepts Hugging Face TEI's bare list of scores", async () => {
    stubFetch(() =>
      json([
        { index: 0, score: 0.2 },
        { index: 2, score: 0.7 },
      ]),
    );
    expect((await rerank(request())).ranking).toEqual([
      { index: 2, score: 0.7 },
      { index: 0, score: 0.2 },
    ]);
  });

  it('refuses anything that is not reranking results', async () => {
    for (const body of [
      'not json',
      JSON.stringify({ data: [] }),
      JSON.stringify({ results: [{ index: 3, relevance_score: 1 }] }),
      JSON.stringify({ results: [{ index: -1, relevance_score: 1 }] }),
      JSON.stringify({ results: [{ index: 0.5, relevance_score: 1 }] }),
      JSON.stringify({ results: [{ index: '0', relevance_score: 1 }] }),
      JSON.stringify({ results: [{ index: 0, relevance_score: 'high' }] }),
      JSON.stringify({ results: [{ index: 0 }] }),
      JSON.stringify({ results: ['first'] }),
      JSON.stringify(null),
    ]) {
      stubFetch(() => new Response(body, { status: 200 }));
      const error = await failure(rerank(request()));
      expect(error.message).toBe('Gateway returned a response that is not reranking results.');
    }
    stubFetch(() => new Response(null, { status: 200 }));
    expect((await failure(rerank(request()))).message).toContain('not reranking results');
  });

  it('keeps the first score of a repeated index and orders ties by position', () => {
    expect(
      parseRerankResponse(
        {
          results: [
            { index: 2, relevance_score: 0.5 },
            { index: 0, relevance_score: 0.5 },
            { index: 2, relevance_score: 0.9 },
          ],
        },
        3,
      ),
    ).toEqual([
      { index: 0, score: 0.5 },
      { index: 2, score: 0.5 },
    ]);
  });

  it('names the provider for each HTTP error, never the key', async () => {
    const cases: Array<[number, string]> = [
      [401, 'Gateway rejected the API key for reranking (HTTP 401).'],
      [403, 'Gateway rejected the API key for reranking (HTTP 403).'],
      [404, 'Gateway has no reranking endpoint at https://gateway.example/v1/rerank (HTTP 404).'],
      [429, 'Gateway refused to rerank because a rate limit was reached (HTTP 429).'],
      [500, 'Gateway returned an error while reranking (HTTP 500).'],
    ];
    for (const [status, message] of cases) {
      stubFetch(() => json({ error: `bad key ${KEY}` }, { status }));
      expect((await failure(rerank(request()))).message).toBe(message);
    }
  });

  it('reports an unreachable provider', async () => {
    stubFetch(() => {
      throw new TypeError(`fetch failed for ${KEY}`);
    });
    expect((await failure(rerank(request()))).message).toBe(
      'Gateway could not be reached for reranking.',
    );
    // A body that breaks part-way is reported the same way.
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('socket hang up'));
            },
          }),
        ),
    );
    expect((await failure(rerank(request()))).message).toBe(
      'Gateway could not be reached for reranking.',
    );
  });

  it('gives up after the timeout, waiting for an answer or for its body', async () => {
    expect(RERANK_TIMEOUT_MS).toBe(5_000);
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    expect((await failure(rerank(request({ timeoutMs: 50 })))).message).toBe(
      'Gateway did not rerank within 0.05 s.',
    );
    expect(Date.now() - started).toBeLessThan(2_000);

    stubFetch((_url, init) => new Response(endlessBody(init.signal)));
    expect((await failure(rerank(request({ timeoutMs: 50 })))).message).toBe(
      'Gateway did not rerank within 0.05 s.',
    );
  });

  it('limits the size of the response, declared or streamed', async () => {
    expect(MAX_RERANK_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
    const big = JSON.stringify({
      results: [{ index: 0, relevance_score: 1, pad: 'x'.repeat(4096) }],
    });
    stubFetch(() => new Response(big, { headers: { 'content-length': String(big.length) } }));
    expect((await failure(rerank(request({ maxResponseBytes: 2048 })))).message).toBe(
      'Gateway returned a reranking response larger than 2 KB.',
    );
    // No declared length: counted while reading.
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let chunk = 0; chunk < 4; chunk += 1) {
                controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
              }
              controller.close();
            },
          }),
        ),
    );
    expect((await failure(rerank(request({ maxResponseBytes: 2048 })))).message).toContain(
      'larger than 2 KB',
    );
    // Within the limit, it is read in full.
    stubFetch(() => new Response(big));
    expect((await rerank(request())).ranking).toEqual([{ index: 0, score: 1 }]);
  });
});

describe('reranking settings and endpoints', () => {
  it('appends /rerank to the base URL path, keeping any query', () => {
    expect(rerankEndpoint('https://host/v1')).toBe('https://host/v1/rerank');
    expect(rerankEndpoint(' https://host/v1/ ')).toBe('https://host/v1/rerank');
    expect(rerankEndpoint('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/rerank');
    expect(rerankEndpoint('https://host/api?version=2')).toBe('https://host/api/rerank?version=2');
    expect(rerankEndpoint('https://api.cohere.com/v2')).toBe('https://api.cohere.com/v2/rerank');
    for (const invalid of [null, '', '   ', 'ftp://host/v1', 'host/v1', 'https://']) {
      expect(rerankEndpoint(invalid)).toBeNull();
    }
  });

  it('offers OpenAI-compatible providers, and OpenAI gateways with a base URL', () => {
    expect(providerCanRerank({ kind: 'openai-compatible', baseUrl: 'http://tei/v1' })).toBe(true);
    expect(providerCanRerank({ kind: 'openai', baseUrl: 'https://litellm/v1' })).toBe(true);
    expect(providerCanRerank({ kind: 'openai', baseUrl: null })).toBe(false);
    expect(providerCanRerank({ kind: 'openai', baseUrl: ' ' })).toBe(false);
    expect(providerCanRerank({ kind: 'anthropic', baseUrl: 'https://x/v1' })).toBe(false);
    expect(providerCanRerank({ kind: 'google', baseUrl: 'https://x/v1' })).toBe(false);
  });

  it('fills in defaults and recognises a usable setting', () => {
    const empty = normalizeRerankingSettings(undefined);
    expect(empty).toEqual({
      enabled: false,
      providerId: null,
      modelId: null,
      searchPriceMicros: null,
    });
    expect(rerankingSettingsSchema.parse(empty)).toEqual(empty);
    expect(isRerankingActive(empty)).toBe(false);
    expect(isRerankingActive({ ...empty, enabled: true, providerId: 'p' })).toBe(false);
    expect(
      isRerankingActive(
        normalizeRerankingSettings({ enabled: true, providerId: 'p', modelId: 'm' }),
      ),
    ).toBe(true);
    expect(rerankUsageSlug('bge-reranker-v2-m3')).toBe('rerank:bge-reranker-v2-m3');
  });

  it('prices one search at a thousandth of the price, rounded up', () => {
    expect(rerankCostMicros(null)).toBe(0);
    expect(rerankCostMicros(0)).toBe(0);
    expect(rerankCostMicros(2_000_000)).toBe(2_000);
    expect(rerankCostMicros(1)).toBe(1);
  });
});
