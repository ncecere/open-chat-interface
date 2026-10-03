import { describe, expect, it } from 'vitest';
import { fallbackSearchProblem, webSearchProblem } from '../../services/search/availability.js';
import type { SearchSettings } from '../../services/settings.js';

const search = (overrides: Partial<SearchSettings> = {}): SearchSettings => ({
  enabled: true,
  provider: 'tavily',
  baseUrl: null,
  encryptedApiKey: 'ciphertext',
  maxResults: 5,
  ...overrides,
});

describe('web search availability', () => {
  it('requires both switches', () => {
    expect(webSearchProblem({ webSearch: false }, search())).toBe(
      'web search is only partly switched on',
    );
    expect(webSearchProblem({ webSearch: true }, search({ enabled: false }))).toBe(
      'web search is only partly switched on',
    );
  });

  it('requires a provider and what that provider needs', () => {
    expect(webSearchProblem({ webSearch: true }, search({ provider: null }))).toBe(
      'no search provider is selected',
    );
    expect(webSearchProblem({ webSearch: true }, search({ encryptedApiKey: null }))).toBe(
      'Tavily needs an API key',
    );
    expect(webSearchProblem({ webSearch: true }, search({ provider: 'searxng' }))).toBe(
      'SearXNG needs its address',
    );
    expect(
      webSearchProblem(
        { webSearch: true },
        search({ provider: 'searxng', baseUrl: 'http://127.0.0.1:1', encryptedApiKey: null }),
      ),
    ).toBeNull();
    expect(webSearchProblem({ webSearch: true }, search())).toBeNull();
    expect(
      webSearchProblem({ webSearch: true }, search({ provider: 'serpapi', encryptedApiKey: null })),
    ).toBe('SerpApi needs an API key');
    expect(webSearchProblem({ webSearch: true }, search({ provider: 'serpapi' }))).toBeNull();
    expect(
      webSearchProblem(
        { webSearch: true },
        search({ provider: 'searchapi', encryptedApiKey: null }),
      ),
    ).toBe('SearchApi needs an API key');
  });
});

describe('fallback provider availability', () => {
  it('has nothing to say when no fallback is configured', () => {
    expect(fallbackSearchProblem(search())).toBeNull();
    expect(fallbackSearchProblem(search({ fallbackProvider: null }))).toBeNull();
  });

  it('requires what the fallback provider needs', () => {
    expect(fallbackSearchProblem(search({ fallbackProvider: 'brave' }))).toBe(
      'the fallback Brave Search needs an API key',
    );
    expect(
      fallbackSearchProblem(search({ fallbackProvider: 'brave', encryptedFallbackApiKey: 'c' })),
    ).toBeNull();
    expect(fallbackSearchProblem(search({ fallbackProvider: 'searxng' }))).toBe(
      'the fallback SearXNG needs its address',
    );
    expect(
      fallbackSearchProblem(
        search({ fallbackProvider: 'searxng', fallbackBaseUrl: 'https://search.example.edu' }),
      ),
    ).toBeNull();
  });

  it('never uses a hosted service, or the same SearXNG, as its own fallback', () => {
    expect(
      fallbackSearchProblem(search({ fallbackProvider: 'tavily', encryptedFallbackApiKey: 'c' })),
    ).toBe('the fallback must be a different service than Tavily');
    const searxng = { provider: 'searxng' as const, baseUrl: 'https://a.example.edu' };
    expect(
      fallbackSearchProblem(
        search({
          ...searxng,
          fallbackProvider: 'searxng',
          fallbackBaseUrl: 'https://a.example.edu',
        }),
      ),
    ).toBe('the fallback SearXNG must be at another address');
    expect(
      fallbackSearchProblem(
        search({
          ...searxng,
          fallbackProvider: 'searxng',
          fallbackBaseUrl: 'https://b.example.edu',
        }),
      ),
    ).toBeNull();
  });
});
