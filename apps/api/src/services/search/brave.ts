import { normalizeResults, requiredApiKey, searchFetch } from './http.js';
import type { SearchAdapter } from './types.js';

export const searchBrave: SearchAdapter = async ({ query, maxResults, apiKey, signal }) => {
  const credential = requiredApiKey(apiKey, 'Brave');
  const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('count', String(maxResults));
  endpoint.searchParams.set('safesearch', 'moderate');

  const payload = (await searchFetch(endpoint, {
    headers: {
      accept: 'application/json',
      'x-subscription-token': credential,
    },
    signal,
  })) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };

  return normalizeResults(
    (payload.web?.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.description,
    })),
    maxResults,
  );
};
