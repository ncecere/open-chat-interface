import { afterEach, describe, expect, it, vi } from 'vitest';
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
      'SerpApi search is missing an API credential',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Invalid API key."}', { status: 401 })),
    );
    const failure = searchSerpapi(request());
    await expect(failure).rejects.toThrow('Web search provider returned HTTP 401');
    await expect(failure).rejects.not.toThrow('serpapi-test-key');
  });
});
