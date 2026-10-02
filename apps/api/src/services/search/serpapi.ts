import { normalizeResults, requiredApiKey, searchFetch } from './http.js';
import type { SearchAdapter } from './types.js';

/** Google web results through SerpApi (https://serpapi.com/search-api). */
export const searchSerpapi: SearchAdapter = async ({ query, maxResults, apiKey, signal }) => {
  const credential = requiredApiKey(apiKey, 'SerpApi');
  const endpoint = new URL('https://serpapi.com/search.json');
  endpoint.searchParams.set('engine', 'google');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('safe', 'active');
  endpoint.searchParams.set('api_key', credential);

  const payload = (await searchFetch(endpoint, {
    headers: { accept: 'application/json' },
    signal,
  })) as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  return normalizeResults(
    (payload.organic_results ?? []).map((result) => ({
      title: result.title,
      url: result.link,
      snippet: result.snippet,
    })),
    maxResults,
  );
};
