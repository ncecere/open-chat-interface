import { SEARCH_PROVIDERS } from '@oci/shared';
import { normalizeResults, requiredApiKey, searchFetch } from './http.js';
import type { SearchAdapter } from './types.js';

const NAME = SEARCH_PROVIDERS.searchapi.name;

/**
 * Google web results through SearchApi (https://www.searchapi.io/docs/google).
 * The key travels in the Authorization header, never in the URL.
 */
export const searchSearchapi: SearchAdapter = async ({ query, maxResults, apiKey, signal }) => {
  const credential = requiredApiKey(apiKey, NAME);
  const endpoint = new URL('https://www.searchapi.io/api/v1/search');
  endpoint.searchParams.set('engine', 'google');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('safe', 'active');

  const payload = (await searchFetch(
    endpoint,
    { headers: { accept: 'application/json', authorization: `Bearer ${credential}` }, signal },
    NAME,
  )) as {
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
