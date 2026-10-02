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
