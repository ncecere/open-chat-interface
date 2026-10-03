import { SEARCH_PROVIDERS } from '@oci/shared';
import type { FeatureSettings, SearchSettings } from '../settings.js';

/**
 * Why web search cannot run as configured, or null when it can.
 *
 * Search depends on the instance feature, the search switch, a provider and
 * that provider's credential or address. Clients are told it is available only
 * when all of them hold, so the composer never offers a search that would fail.
 */
export function webSearchProblem(
  features: Pick<FeatureSettings, 'webSearch'>,
  search: SearchSettings,
): string | null {
  if (!features.webSearch || !search.enabled) return 'web search is only partly switched on';
  if (!search.provider) return 'no search provider is selected';
  const provider = SEARCH_PROVIDERS[search.provider];
  if (provider.needs === 'baseUrl')
    return search.baseUrl ? null : `${provider.name} needs its address`;
  return search.encryptedApiKey ? null : `${provider.name} needs an API key`;
}

/**
 * Why the fallback provider (v0.10) would not be used, or null when it would
 * be, or when none is configured (then there is nothing to say). It needs a
 * provider of its own and that provider's address or key; SearXNG may be its
 * own fallback only at another address, and a hosted provider never.
 */
export function fallbackSearchProblem(search: SearchSettings): string | null {
  if (!search.fallbackProvider) return null;
  const provider = SEARCH_PROVIDERS[search.fallbackProvider];
  if (search.fallbackProvider === search.provider && provider.needs === 'apiKey')
    return `the fallback must be a different service than ${provider.name}`;
  if (provider.needs === 'baseUrl') {
    if (!search.fallbackBaseUrl) return `the fallback ${provider.name} needs its address`;
    if (search.fallbackProvider === search.provider && search.fallbackBaseUrl === search.baseUrl)
      return `the fallback ${provider.name} must be at another address`;
    return null;
  }
  return search.encryptedFallbackApiKey ? null : `the fallback ${provider.name} needs an API key`;
}
