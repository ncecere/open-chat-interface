import { SEARCH_PROVIDERS } from '@oci/shared';
import { normalizeResults, requiredApiKey, searchFetch } from './http.js';
import type { SearchAdapter } from './types.js';

const NAME = SEARCH_PROVIDERS.exa.name;

export const searchExa: SearchAdapter = async ({ query, maxResults, apiKey, signal }) => {
  const credential = requiredApiKey(apiKey, NAME);
  const payload = (await searchFetch(
    new URL('https://api.exa.ai/search'),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': credential,
      },
      body: JSON.stringify({
        query,
        numResults: maxResults,
        contents: { text: { maxCharacters: 2_000 } },
      }),
      signal,
    },
    NAME,
  )) as {
    results?: Array<{
      title?: string;
      url?: string;
      text?: string;
      highlights?: string[];
    }>;
  };

  return normalizeResults(
    (payload.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.text ?? result.highlights?.join(' '),
    })),
    maxResults,
  );
};
