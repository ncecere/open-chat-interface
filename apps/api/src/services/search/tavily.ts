import { SEARCH_PROVIDERS } from '@oci/shared';
import { normalizeResults, requiredApiKey, searchFetch } from './http.js';
import type { SearchAdapter } from './types.js';

const NAME = SEARCH_PROVIDERS.tavily.name;

export const searchTavily: SearchAdapter = async ({ query, maxResults, apiKey, signal }) => {
  const credential = requiredApiKey(apiKey, NAME);
  const payload = (await searchFetch(
    new URL('https://api.tavily.com/search'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: credential,
        query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
      signal,
    },
    NAME,
  )) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return normalizeResults(
    (payload.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.content,
    })),
    maxResults,
  );
};
