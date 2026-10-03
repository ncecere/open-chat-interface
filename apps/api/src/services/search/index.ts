import { SEARCH_PROVIDERS, type SearchProviderKind } from '@oci/shared';
import { decryptSecret } from '../../lib/crypto.js';
import { providerError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { observeWebSearch } from '../observability/events.js';
import { getSetting, type SearchSettings } from '../settings.js';
import { fallbackSearchProblem } from './availability.js';
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
 * Time limits for one search, retries and fallback included. The `web_search`
 * tool call is cut off at 30 seconds (services/tools/registry.ts), so the
 * whole search must end well before that, leaving room for reading settings,
 * shaping the results and the audit write.
 *
 * - One attempt may take 15 seconds. Hosted providers usually answer in one to
 *   five; 15 still covers a slow one without waiting out the whole budget.
 * - All attempts together take at most 25 seconds. A first attempt that timed
 *   out leaves about 10 for the retry; a connection that failed at once leaves
 *   the retry a full 15.
 * - With a fallback provider configured (v0.10), each attempt at the first
 *   provider may take 8 seconds and both together at most 17, so the
 *   fallback always has at least 8 of the 25.
 * - There is no retry when less than 2 seconds would remain: it could not
 *   succeed and would only replace a clear failure with a later one.
 */
export const SEARCH_ATTEMPT_TIMEOUT_MS = 15_000;
export const SEARCH_TOTAL_TIMEOUT_MS = 25_000;
export const SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS = 8_000;
export const SEARCH_PRIMARY_BUDGET_WITH_FALLBACK_MS = 17_000;
const SEARCH_RETRY_DELAY_MS = 250;
const SEARCH_MIN_RETRY_MS = 2_000;
const SEARCH_MAX_ATTEMPTS = 2;

export function normalizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

export interface SearchProviderConfig {
  provider: SearchProviderKind;
  baseUrl: string | null;
  apiKey: string | null;
  maxResults: number;
}

interface RunSearchOptions {
  signal?: AbortSignal;
  /** When every attempt must have ended (epoch ms); 25 seconds from now by default. */
  deadline?: number;
  /** The longest one attempt may take; SEARCH_ATTEMPT_TIMEOUT_MS by default. */
  attemptTimeoutMs?: number;
  /** For logs only: which configured provider this is. */
  slot?: 'primary' | 'fallback';
}

/**
 * One search against a provider with explicit settings. A timeout, network
 * failure or server error is retried once within the time limit; the second
 * failure is reported as it is (it names the provider). `signal` is the
 * caller's: when it aborts, the search stops and is not retried.
 */
export async function runSearch(
  query: string,
  config: SearchProviderConfig,
  options: RunSearchOptions = {},
): Promise<SearchResult[]> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) throw validationFailed('A search query is required');
  const adapter = adapters[config.provider];
  if (!adapter) throw providerError('The configured web search provider is unsupported');
  const deadline = options.deadline ?? Date.now() + SEARCH_TOTAL_TIMEOUT_MS;
  const attemptLimit = options.attemptTimeoutMs ?? SEARCH_ATTEMPT_TIMEOUT_MS;
  const slot = options.slot ?? 'primary';

  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(attemptLimit, deadline - started)));
    try {
      const results = await adapter({
        query: normalizedQuery,
        maxResults: Math.min(Math.max(config.maxResults, 1), 20),
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      if (attempt > 1) {
        logger.info({ provider: config.provider, slot, attempt }, 'Web search succeeded on retry');
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
          slot,
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

/** Which provider answered a search, for the tool result and the grounding note. */
export interface WebSearchAnswer {
  results: SearchResult[];
  /** The answering provider's name, such as "Brave Search". */
  provider: string;
  /** True when the fallback answered because the first provider failed. */
  fallback: boolean;
}

/**
 * A search with a fallback (v0.10). The first provider is tried, with its one
 * retry; when it still fails with a timeout, network or server error and a
 * fallback is configured, the fallback is tried in the time that remains. An
 * error the administrator must fix (a refused key, a quota, an invalid
 * response) is reported as it is, without trying the fallback. When both
 * fail, the error names both.
 */
export async function searchWithFallback(
  query: string,
  primary: SearchProviderConfig,
  fallback: SearchProviderConfig | null,
  options: { signal?: AbortSignal } = {},
): Promise<WebSearchAnswer> {
  const start = Date.now();
  const deadline = start + SEARCH_TOTAL_TIMEOUT_MS;
  const primaryName = SEARCH_PROVIDERS[primary.provider]?.name ?? primary.provider;
  try {
    const results = await runSearch(query, primary, {
      signal: options.signal,
      deadline: fallback ? start + SEARCH_PRIMARY_BUDGET_WITH_FALLBACK_MS : deadline,
      ...(fallback && { attemptTimeoutMs: SEARCH_PRIMARY_ATTEMPT_WITH_FALLBACK_MS }),
    });
    observeWebSearch(primary.provider, 'primary', 'answered', Date.now() - start);
    return { results, provider: primaryName, fallback: false };
  } catch (error) {
    observeWebSearch(primary.provider, 'primary', 'failed', Date.now() - start);
    if (
      !fallback ||
      !isTransientSearchFailure(error) ||
      options.signal?.aborted ||
      deadline - Date.now() < SEARCH_MIN_RETRY_MS
    ) {
      throw error;
    }
    const fallbackName = SEARCH_PROVIDERS[fallback.provider]?.name ?? fallback.provider;
    const fallbackStart = Date.now();
    logger.warn(
      { provider: primary.provider, fallbackProvider: fallback.provider },
      'Web search falling back to the second provider',
    );
    try {
      const results = await runSearch(query, fallback, {
        signal: options.signal,
        deadline,
        slot: 'fallback',
      });
      observeWebSearch(fallback.provider, 'fallback', 'answered', Date.now() - fallbackStart);
      return { results, provider: fallbackName, fallback: true };
    } catch (fallbackError) {
      observeWebSearch(fallback.provider, 'fallback', 'failed', Date.now() - fallbackStart);
      const first = error instanceof Error ? error.message : `${primaryName} failed.`;
      const second =
        fallbackError instanceof Error ? fallbackError.message : `${fallbackName} failed.`;
      throw providerError(`${first} The fallback provider failed too: ${second}`);
    }
  }
}

/** Decrypts a stored web search key; null when none is stored. */
function decryptSearchKey(encrypted: string | null | undefined, which: string): string | null {
  if (!encrypted) return null;
  try {
    return decryptSecret(encrypted);
  } catch {
    throw providerError(`The ${which} could not be decrypted. Enter it again.`);
  }
}

/** Decrypts the stored web search key; null when none is stored. */
export function storedSearchKey(settings: Pick<SearchSettings, 'encryptedApiKey'>): string | null {
  return decryptSearchKey(settings.encryptedApiKey, 'web search API key');
}

/** Decrypts the stored fallback provider's key; null when none is stored. */
export function storedFallbackSearchKey(
  settings: Pick<SearchSettings, 'encryptedFallbackApiKey'>,
): string | null {
  return decryptSearchKey(settings.encryptedFallbackApiKey, 'fallback web search API key');
}

/**
 * The fallback provider's settings, or null when none is configured or it
 * lacks what it needs (then it is simply not used; the Web search page and
 * the setup checklist say why).
 */
function fallbackConfig(settings: SearchSettings): SearchProviderConfig | null {
  if (fallbackSearchProblem(settings) !== null || !settings.fallbackProvider) return null;
  const needs = SEARCH_PROVIDERS[settings.fallbackProvider].needs;
  return {
    provider: settings.fallbackProvider,
    baseUrl: needs === 'baseUrl' ? (settings.fallbackBaseUrl ?? null) : null,
    apiKey: needs === 'apiKey' ? storedFallbackSearchKey(settings) : null,
    maxResults: settings.maxResults,
  };
}

/** A search with the instance's saved settings, as conversations use it. */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSearchAnswer> {
  const [features, settings] = await Promise.all([getSetting('features'), getSetting('search')]);
  if (!features.webSearch || !settings.enabled || !settings.provider) {
    throw validationFailed('Web search is disabled on this instance');
  }
  return searchWithFallback(
    query,
    {
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: storedSearchKey(settings),
      maxResults: settings.maxResults,
    },
    fallbackConfig(settings),
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
