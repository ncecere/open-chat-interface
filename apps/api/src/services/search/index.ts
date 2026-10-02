import type { SearchProviderKind } from '@oci/shared';
import { decryptSecret } from '../../lib/crypto.js';
import { providerError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getSetting, type SearchSettings } from '../settings.js';
import { searchBrave } from './brave.js';
import { searchExa } from './exa.js';
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

export function normalizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

/** One search against a provider with explicit settings. */
export async function runSearch(
  query: string,
  config: {
    provider: SearchProviderKind;
    baseUrl: string | null;
    apiKey: string | null;
    maxResults: number;
  },
): Promise<SearchResult[]> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) throw validationFailed('A search query is required');
  const adapter = adapters[config.provider];
  if (!adapter) throw providerError('The configured web search provider is unsupported');
  try {
    return await adapter({
      query: normalizedQuery,
      maxResults: Math.min(Math.max(config.maxResults, 1), 20),
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    // Never the query or the key: only which provider failed and how.
    logger.warn(
      { provider: config.provider, error: error instanceof Error ? error.message : 'unknown' },
      'Web search failed',
    );
    throw error;
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
export async function searchWeb(query: string): Promise<SearchResult[]> {
  const [features, settings] = await Promise.all([getSetting('features'), getSetting('search')]);
  if (!features.webSearch || !settings.enabled || !settings.provider) {
    throw validationFailed('Web search is disabled on this instance');
  }
  return runSearch(query, {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: storedSearchKey(settings),
    maxResults: settings.maxResults,
  });
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
