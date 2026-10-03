import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() },
}));

import {
  runSearch,
  SEARCH_ATTEMPT_TIMEOUT_MS,
  SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS,
  SEARCH_PRIMARY_BUDGET_WITH_FALLBACK_MS,
  SEARCH_TOTAL_TIMEOUT_MS,
  searchWithFallback,
} from '../../services/search/index.js';

const QUERY = 'library opening hours';
const KEY = 'brave-secret-key';
const config = { provider: 'brave' as const, baseUrl: null, apiKey: KEY, maxResults: 3 };

const timedOut = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
const unreachable = () => Promise.reject(new TypeError('fetch failed'));
const answered = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        web: { results: [{ title: 'Hours', url: 'https://lib.example.edu/hours' }] },
      }),
      { status: 200 },
    ),
  );

let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => vi.unstubAllGlobals());

function expectLogsWithoutSecrets() {
  const logged = JSON.stringify([...mocks.warn.mock.calls, ...mocks.info.mock.calls]);
  expect(logged).not.toContain(QUERY);
  expect(logged).not.toContain(KEY);
}

describe('web search retry', () => {
  it('stays inside the 30-second tool call limit, retry included', () => {
    expect(SEARCH_ATTEMPT_TIMEOUT_MS).toBeLessThan(SEARCH_TOTAL_TIMEOUT_MS);
    expect(SEARCH_TOTAL_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
  });

  it('retries once after a timeout and returns the second answer', async () => {
    fetch.mockImplementationOnce(timedOut).mockImplementationOnce(answered);

    await expect(runSearch(QUERY, config)).resolves.toEqual([
      { title: 'Hours', url: 'https://lib.example.edu/hours', snippet: '' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'brave', attempt: 1, retrying: true }),
      'Web search failed',
    );
    expect(mocks.info).toHaveBeenCalledWith(
      { provider: 'brave', slot: 'primary', attempt: 2 },
      'Web search succeeded on retry',
    );
    expectLogsWithoutSecrets();
  });

  it('retries a network failure too', async () => {
    fetch.mockImplementationOnce(unreachable).mockImplementationOnce(answered);
    await expect(runSearch(QUERY, config)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second failure with the provider-named message', async () => {
    fetch.mockImplementationOnce(timedOut).mockImplementationOnce(unreachable);

    await expect(runSearch(QUERY, config)).rejects.toThrow('Brave Search could not be reached.');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 2, retrying: false }),
      'Web search failed',
    );
    expectLogsWithoutSecrets();
  });

  it.each([
    [401, 'Brave Search rejected the web search API key (HTTP 401)'],
    [403, 'Brave Search rejected the web search API key (HTTP 403)'],
    [429, 'Brave Search refused the search because a rate limit or quota was reached (HTTP 429)'],
    [404, 'Brave Search returned an error (HTTP 404)'],
  ])('does not retry HTTP %i', async (status, message) => {
    fetch.mockImplementation(() => Promise.resolve(new Response('{}', { status })));
    await expect(runSearch(QUERY, config)).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 504])('retries a server error (HTTP %i) once', async (status) => {
    fetch
      .mockImplementationOnce(() => Promise.resolve(new Response('{}', { status })))
      .mockImplementationOnce(answered);
    await expect(runSearch(QUERY, config)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a response that is not search results', async () => {
    fetch.mockImplementation(() => Promise.resolve(new Response('<html>', { status: 200 })));
    await expect(runSearch(QUERY, config)).rejects.toThrow(
      'Brave Search returned a response that is not valid search results.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the caller stopped the search', async () => {
    const caller = new AbortController();
    fetch.mockImplementation(() => {
      caller.abort();
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    });
    await expect(runSearch(QUERY, config, { signal: caller.signal })).rejects.toThrow(
      'Brave Search did not answer in time.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives the retry only the time left in the overall limit', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    fetch
      .mockImplementationOnce(() => {
        now += SEARCH_ATTEMPT_TIMEOUT_MS;
        return timedOut();
      })
      .mockImplementationOnce(answered);

    await runSearch(QUERY, config);
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([
      SEARCH_ATTEMPT_TIMEOUT_MS,
      SEARCH_TOTAL_TIMEOUT_MS - SEARCH_ATTEMPT_TIMEOUT_MS,
    ]);
  });

  it('does not retry when too little of the overall limit is left', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetch.mockImplementation(() => {
      now += SEARCH_TOTAL_TIMEOUT_MS - 1_000;
      return timedOut();
    });

    await expect(runSearch(QUERY, config)).rejects.toThrow('Brave Search did not answer in time.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('web search fallback', () => {
  const fallback = {
    provider: 'searxng' as const,
    baseUrl: 'https://search.example.edu',
    apiKey: null,
    maxResults: 3,
  };
  const searxngAnswered = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ results: [{ title: 'Fallback', url: 'https://fallback.test/' }] }),
        { status: 200 },
      ),
    );

  it('leaves the fallback at least one full attempt inside the overall limit', () => {
    expect(2 * SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS).toBeLessThanOrEqual(
      SEARCH_PRIMARY_BUDGET_WITH_FALLBACK_MS,
    );
    expect(SEARCH_TOTAL_TIMEOUT_MS - SEARCH_PRIMARY_BUDGET_WITH_FALLBACK_MS).toBeGreaterThanOrEqual(
      SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS,
    );
  });

  it('answers from the first provider when it works', async () => {
    fetch.mockImplementationOnce(answered);
    await expect(searchWithFallback(QUERY, config, fallback)).resolves.toEqual({
      results: [{ title: 'Hours', url: 'https://lib.example.edu/hours', snippet: '' }],
      provider: 'Brave Search',
      fallback: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shortens the first provider's attempts and gives the fallback the rest", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    fetch
      .mockImplementationOnce(() => {
        now += SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS;
        return timedOut();
      })
      .mockImplementationOnce(() => {
        now += SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS;
        return timedOut();
      })
      .mockImplementationOnce(searxngAnswered);

    await expect(searchWithFallback(QUERY, config, fallback)).resolves.toMatchObject({
      provider: 'SearXNG',
      fallback: true,
    });
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([
      SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS,
      SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS,
      SEARCH_TOTAL_TIMEOUT_MS - 2 * SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS,
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { provider: 'brave', fallbackProvider: 'searxng' },
      'Web search falling back to the second provider',
    );
    expectLogsWithoutSecrets();
  });

  it('keeps the full time limits when no fallback is configured', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    fetch.mockImplementationOnce(answered);
    await searchWithFallback(QUERY, config, null);
    expect(timeouts.mock.calls[0]?.[0]).toBe(SEARCH_ATTEMPT_TIMEOUT_MS);
  });

  it.each([
    [401, 'Brave Search rejected the web search API key (HTTP 401)'],
    [429, 'Brave Search refused the search because a rate limit or quota was reached (HTTP 429)'],
  ])('does not fall back on HTTP %i', async (status, message) => {
    fetch.mockImplementation(() => Promise.resolve(new Response('{}', { status })));
    await expect(searchWithFallback(QUERY, config, fallback)).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('names both providers when both fail', async () => {
    fetch.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    await expect(searchWithFallback(QUERY, config, fallback)).rejects.toThrow(
      'Brave Search could not be reached. The fallback provider failed too: SearXNG could not be reached.',
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not fall back when the caller stopped the search', async () => {
    const caller = new AbortController();
    fetch.mockImplementation(() => {
      caller.abort();
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    });
    await expect(
      searchWithFallback(QUERY, config, fallback, { signal: caller.signal }),
    ).rejects.toThrow('Brave Search did not answer in time.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when too little of the overall limit is left', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetch.mockImplementation(() => {
      now += SEARCH_TOTAL_TIMEOUT_MS - 1_000;
      return timedOut();
    });
    await expect(searchWithFallback(QUERY, config, fallback)).rejects.toThrow(
      'Brave Search did not answer in time.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
