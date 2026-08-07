import { providerError } from '../../lib/errors.js';

export function validateSearchEndpoint(endpoint: URL): URL {
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw providerError('Web search provider URL must use HTTP or HTTPS');
  }
  if (endpoint.username || endpoint.password) {
    throw providerError('Web search provider URL cannot contain credentials');
  }
  return endpoint;
}

export async function searchFetch(endpoint: URL, init: RequestInit): Promise<unknown> {
  const trustedEndpoint = validateSearchEndpoint(endpoint);
  let response: Response;

  try {
    // Endpoints are fixed provider URLs or an administrator-managed SearXNG
    // origin. User input is confined to URLSearchParams and cannot set origin.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    response = await fetch(trustedEndpoint, init);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw providerError('Web search timed out');
    }
    throw providerError('Web search provider could not be reached');
  }

  if (!response.ok) {
    throw providerError(`Web search provider returned HTTP ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw providerError('Web search provider returned an invalid response');
  }
}

export function requiredApiKey(apiKey: string | null, provider: string): string {
  if (!apiKey) throw providerError(`${provider} search is missing an API credential`);
  return apiKey;
}

export function normalizeResults(results: SearchResultCandidate[], maxResults: number) {
  const seen = new Set<string>();

  return results
    .flatMap((result) => {
      const title = result.title?.trim();
      const url = result.url?.trim();
      if (!title || !url || seen.has(url)) return [];

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return [];
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];

      seen.add(url);
      return [
        {
          title: title.slice(0, 300),
          url,
          snippet: (result.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 2_000),
        },
      ];
    })
    .slice(0, maxResults);
}

export interface SearchResultCandidate {
  title?: string;
  url?: string;
  snippet?: string;
}
