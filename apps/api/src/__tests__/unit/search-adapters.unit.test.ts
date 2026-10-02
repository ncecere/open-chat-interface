import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchSearchapi } from '../../services/search/searchapi.js';
import { searchSerpapi } from '../../services/search/serpapi.js';

const request = (overrides: Partial<Parameters<typeof searchSerpapi>[0]> = {}) => ({
  query: 'library opening hours',
  maxResults: 2,
  baseUrl: null,
  apiKey: 'serpapi-test-key',
  signal: AbortSignal.timeout(5_000),
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('SerpApi search', () => {
  it('asks Google through SerpApi with safe search and maps organic results', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            organic_results: [
              {
                title: 'Library hours',
                link: 'https://lib.example.edu/hours',
                snippet: 'Open  8–22',
              },
              { title: 'No link' },
              { title: 'Duplicate', link: 'https://lib.example.edu/hours' },
              { title: 'Map', link: 'https://lib.example.edu/map', snippet: 'Floor plans' },
              { title: 'Third', link: 'https://lib.example.edu/third' },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetch);

    await expect(searchSerpapi(request())).resolves.toEqual([
      { title: 'Library hours', url: 'https://lib.example.edu/hours', snippet: 'Open 8–22' },
      { title: 'Map', url: 'https://lib.example.edu/map', snippet: 'Floor plans' },
    ]);
    const url = new URL(String((fetch.mock.calls[0] as unknown as [URL])[0]));
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search.json');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      engine: 'google',
      q: 'library opening hours',
      safe: 'active',
      api_key: 'serpapi-test-key',
    });
  });

  it('needs an API key and reports a refused key without echoing it', async () => {
    await expect(searchSerpapi(request({ apiKey: null }))).rejects.toThrow(
      'SerpApi needs an API key. Add it on the Web search page.',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Invalid API key."}', { status: 401 })),
    );
    const failure = searchSerpapi(request());
    await expect(failure).rejects.toThrow('SerpApi rejected the web search API key (HTTP 401)');
    await expect(failure).rejects.not.toThrow('serpapi-test-key');
  });
});

describe('SearchApi search', () => {
  it('sends the key in a header, never the URL, and maps organic results', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            organic_results: [
              {
                title: 'Library hours',
                link: 'https://lib.example.edu/hours',
                snippet: 'Open 8–22',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetch);

    await expect(searchSearchapi(request({ apiKey: 'searchapi-key' }))).resolves.toEqual([
      { title: 'Library hours', url: 'https://lib.example.edu/hours', snippet: 'Open 8–22' },
    ]);
    const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(target));
    expect(url.origin + url.pathname).toBe('https://www.searchapi.io/api/v1/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      engine: 'google',
      q: 'library opening hours',
      safe: 'active',
    });
    expect(String(target)).not.toContain('searchapi-key');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer searchapi-key');
  });

  it('names SearchApi when its key is missing or rejected', async () => {
    await expect(searchSearchapi(request({ apiKey: null }))).rejects.toThrow(
      'SearchApi needs an API key.',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Invalid API key."}', { status: 401 })),
    );
    await expect(searchSearchapi(request())).rejects.toThrow(
      'SearchApi rejected the web search API key (HTTP 401)',
    );
  });
});
