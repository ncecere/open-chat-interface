import { type AppError, providerError } from '../../lib/errors.js';

/**
 * Failures worth one more attempt, and then the fallback provider: the
 * provider did not answer in time, could not be reached or failed with a
 * server error (HTTP 5xx, since v0.10). A refused key, a rate limit, another
 * HTTP error or an invalid response would fail the same way again (and is
 * the administrator's to fix), so they are never retried or passed on.
 */
const transientFailures = new WeakSet<Error>();

function transient(error: AppError): AppError {
  transientFailures.add(error);
  return error;
}

export function isTransientSearchFailure(error: unknown): boolean {
  return error instanceof Error && transientFailures.has(error);
}

export function validateSearchEndpoint(endpoint: URL): URL {
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw providerError('Web search provider URL must use HTTP or HTTPS');
  }
  if (endpoint.username || endpoint.password) {
    throw providerError('Web search provider URL cannot contain credentials');
  }
  return endpoint;
}

/**
 * What a refusal (HTTP 401 or 403) means. A hosted provider refuses a key; a
 * self-hosted SearXNG has none, and a 403 from it almost always means its
 * JSON output is off (`search.formats` without `json`), so it says that
 * rather than send an administrator after a key the form does not have
 * (#143).
 */
export type SearchRefusal = 'apiKey' | 'searxng';

function refusalMessage(provider: string, status: number, refusal: SearchRefusal): string {
  if (refusal === 'apiKey')
    return `${provider} rejected the web search API key (HTTP ${status}). An administrator needs to check it on the Web search page.`;
  return status === 403
    ? `${provider} refused the search (HTTP 403). Its JSON output is probably not enabled: an administrator needs to add json to search.formats in its settings.yml.`
    : `${provider} refused the search (HTTP ${status}). It may be behind a proxy that asks for a sign-in; an administrator needs to make it reachable without one.`;
}

/**
 * Calls a search provider. Failures name the provider and say what went wrong
 * in words people can act on; they reach the conversation and the Web search
 * page's test, so they never include the query or a credential.
 */
export async function searchFetch(
  endpoint: URL,
  init: RequestInit,
  provider: string,
  refusal: SearchRefusal = 'apiKey',
): Promise<unknown> {
  const trustedEndpoint = validateSearchEndpoint(endpoint);
  let response: Response;

  try {
    // Endpoints are fixed provider URLs or an administrator-managed SearXNG
    // origin. User input is confined to URLSearchParams and cannot set origin.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    response = await fetch(trustedEndpoint, init);
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw transient(providerError(`${provider} did not answer in time.`));
    }
    throw transient(providerError(`${provider} could not be reached.`));
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw providerError(refusalMessage(provider, response.status, refusal));
    }
    if (response.status === 429) {
      throw providerError(
        `${provider} refused the search because a rate limit or quota was reached (HTTP 429).`,
      );
    }
    const failure = providerError(`${provider} returned an error (HTTP ${response.status}).`);
    throw response.status >= 500 ? transient(failure) : failure;
  }

  try {
    return await response.json();
  } catch {
    throw providerError(`${provider} returned a response that is not valid search results.`);
  }
}

export function requiredApiKey(apiKey: string | null, provider: string): string {
  if (!apiKey) throw providerError(`${provider} needs an API key. Add it on the Web search page.`);
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
