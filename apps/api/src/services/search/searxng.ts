import { SEARCH_PROVIDERS } from '@oci/shared';
import { providerError } from '../../lib/errors.js';
import { normalizeResults, searchFetch } from './http.js';
import type { SearchAdapter } from './types.js';

const NAME = SEARCH_PROVIDERS.searxng.name;

export const searchSearxng: SearchAdapter = async ({ query, maxResults, baseUrl, signal }) => {
  if (!baseUrl) throw providerError(`${NAME} needs its address. Add it on the Web search page.`);

  let endpoint: URL;
  try {
    endpoint = new URL('/search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    throw providerError(`${NAME} has an invalid address. Correct it on the Web search page.`);
  }

  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('language', 'en');

  const payload = (await searchFetch(
    endpoint,
    {
      headers: { accept: 'application/json' },
      signal,
    },
    NAME,
    'searxng',
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
