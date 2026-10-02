import type { SearchProviderKind } from '@oci/shared';
import { decryptSecret } from '../../lib/crypto.js';
import { providerError, validationFailed } from '../../lib/errors.js';
import { getSetting } from '../settings.js';
import { searchBrave } from './brave.js';
import { searchExa } from './exa.js';
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
} satisfies Record<SearchProviderKind, SearchAdapter>;

export function normalizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

export async function searchWeb(query: string): Promise<SearchResult[]> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) throw validationFailed('A search query is required');

  const [features, settings] = await Promise.all([getSetting('features'), getSetting('search')]);
  if (!features.webSearch || !settings.enabled || !settings.provider) {
    throw validationFailed('Web search is disabled on this instance');
  }

  const adapter = adapters[settings.provider];
  if (!adapter) throw providerError('The configured web search provider is unsupported');

  let apiKey: string | null = null;
  if (settings.encryptedApiKey) {
    try {
      apiKey = decryptSecret(settings.encryptedApiKey);
    } catch {
      throw providerError('The web search credential could not be decrypted');
    }
  }

  const timeout = AbortSignal.timeout(12_000);
  return adapter({
    query: normalizedQuery,
    maxResults: Math.min(Math.max(settings.maxResults, 1), 20),
    baseUrl: settings.baseUrl,
    apiKey,
    signal: timeout,
  });
}

export function buildGroundingContext(results: SearchResult[]): string {
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
