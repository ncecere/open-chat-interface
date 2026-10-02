import type { SearchProviderKind } from '@oci/shared';
import { decryptSecret } from '../../lib/crypto.js';
import { providerError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getSetting, type SearchSettings } from '../settings.js';
import { searchBrave } from './brave.js';
import { searchExa } from './exa.js';
import { isTransientSearchFailure } from './http.js';
import { searchSearchapi } from './searchapi.js';
import { searchSearxng } from './searxng.js';
import { searchSerpapi } from './serpapi.js';
import { searchTavily } from './tavily.js';
import type { SearchAdapter, SearchResult } from './types.js';

const adapters = {
  searxng: searchSearxng,
  tavily: searchTavily,
  brave: searchBrave,
  exa: searchExa,
  serpapi: searchSerpapi,
  searchapi: searchSearchapi,
} satisfies Record<SearchProviderKind, SearchAdapter>;

/**
 * Time limits for one search, retry included. The `web_search` tool call is cut
 * off at 30 seconds (services/tools/registry.ts), so the whole search must end
 * well before that, leaving room for reading settings, shaping the results and
 * the audit write.
 *
 * - One attempt may take 15 seconds. Hosted providers usually answer in one to
 *   five; 15 still covers a slow one without waiting out the whole budget.
 * - All attempts together take at most 25 seconds. A first attempt that timed
 *   out leaves about 10 for the retry; a connection that failed at once leaves
 *   the retry a full 15.
 * - There is no retry when less than 2 seconds would remain: it could not
 *   succeed and would only replace a clear failure with a later one.
 */
export const SEARCH_ATTEMPT_TIMEOUT_MS = 15_000;
export const SEARCH_TOTAL_TIMEOUT_MS = 25_000;
const SEARCH_RETRY_DELAY_MS = 250;
const SEARCH_MIN_RETRY_MS = 2_000;
const SEARCH_MAX_ATTEMPTS = 2;

export function normalizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

/**
 * One search against a provider with explicit settings. A timeout or network
 * failure is retried once within the overall time limit; the second failure is
 * reported as it is (it names the provider). `signal` is the caller's: when it
 * aborts, the search stops and is not retried.
 */
export async function runSearch(
  query: string,
  config: {
    provider: SearchProviderKind;
    baseUrl: string | null;
    apiKey: string | null;
    maxResults: number;
  },
  options: { signal?: AbortSignal } = {},
): Promise<SearchResult[]> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) throw validationFailed('A search query is required');
  const adapter = adapters[config.provider];
  if (!adapter) throw providerError('The configured web search provider is unsupported');
  const deadline = Date.now() + SEARCH_TOTAL_TIMEOUT_MS;

  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const timeout = AbortSignal.timeout(Math.min(SEARCH_ATTEMPT_TIMEOUT_MS, deadline - started));
    try {
      const results = await adapter({
        query: normalizedQuery,
        maxResults: Math.min(Math.max(config.maxResults, 1), 20),
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      if (attempt > 1) {
        logger.info({ provider: config.provider, attempt }, 'Web search succeeded on retry');
      }
      return results;
    } catch (error) {
      const retry =
        attempt < SEARCH_MAX_ATTEMPTS &&
        isTransientSearchFailure(error) &&
        !options.signal?.aborted &&
        deadline - Date.now() - SEARCH_RETRY_DELAY_MS >= SEARCH_MIN_RETRY_MS;
      // Never the query or the key: only which provider failed, how and when.
      logger.warn(
        {
          provider: config.provider,
          attempt,
          durationMs: Date.now() - started,
          retrying: retry,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'Web search failed',
      );
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, SEARCH_RETRY_DELAY_MS));
    }
  }
}

/** Decrypts the stored web search key; null when none is stored. */
export function storedSearchKey(settings: Pick<SearchSettings, 'encryptedApiKey'>): string | null {
  if (!settings.encryptedApiKey) return null;
  try {
    return decryptSecret(settings.encryptedApiKey);
  } catch {
    throw providerError('The web search API key could not be decrypted. Enter it again.');
  }
}

/** A search with the instance's saved settings, as conversations use it. */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const [features, settings] = await Promise.all([getSetting('features'), getSetting('search')]);
  if (!features.webSearch || !settings.enabled || !settings.provider) {
    throw validationFailed('Web search is disabled on this instance');
  }
  return runSearch(
    query,
    {
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: storedSearchKey(settings),
      maxResults: settings.maxResults,
    },
    { signal },
  );
}

export function buildGroundingContext(results: SearchResult[], failure?: string): string {
  if (failure) {
    return [
      `Web search failed: ${failure}`,
      'Answer from general knowledge and say clearly that current sources could not be checked.',
    ].join('\n');
  }
  if (results.length === 0) {
    return [
      'Web search returned no results.',
      'Answer from general knowledge and state that no current sources were found.',
    ].join('\n');
  }

  const sources = results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\nURL: ${result.url}\nExcerpt: ${result.snippet || '(No excerpt provided)'}`,
    )
    .join('\n\n');

  return [
    'Use the following current web search results as grounding context.',
    'Cite factual claims with markdown links to the supplied source URLs.',
    'Do not invent sources or claim that an excerpt says more than it does.',
    '',
    sources,
  ].join('\n');
}

export type { SearchResult } from './types.js';
