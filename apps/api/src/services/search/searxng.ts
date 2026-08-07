import { providerError } from '../../lib/errors.js';
import { normalizeResults, searchFetch } from './http.js';
import type { SearchAdapter } from './types.js';

export const searchSearxng: SearchAdapter = async ({ query, maxResults, baseUrl, signal }) => {
  if (!baseUrl) throw providerError('SearXNG search requires a base URL');

  let endpoint: URL;
  try {
    endpoint = new URL('/search', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    throw providerError('SearXNG search has an invalid base URL');
  }

  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('language', 'en');

  const payload = (await searchFetch(endpoint, {
    headers: { accept: 'application/json' },
    signal,
  })) as {
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
