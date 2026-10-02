import type { SearchProviderKind } from './constants.js';

/**
 * What each web search provider needs, so the administrator is asked for
 * exactly that and nothing else, and the server can tell whether search can
 * run. Hosted providers need an API key and use a fixed endpoint; SearXNG is
 * self-hosted, needs its address and takes no key.
 */
export interface SearchProviderInfo {
  /** Used in sentences, such as "Tavily needs an API key". */
  name: string;
  /** Shown in the provider menu. */
  label: string;
  needs: 'apiKey' | 'baseUrl';
  /** The field's label on the Web search page. */
  fieldLabel: string;
  /** Where to find the value. */
  fieldHint: string;
}

export const SEARCH_PROVIDERS: Record<SearchProviderKind, SearchProviderInfo> = {
  searxng: {
    name: 'SearXNG',
    label: 'SearXNG (self-hosted)',
    needs: 'baseUrl',
    fieldLabel: 'SearXNG address',
    fieldHint:
      'The address of your SearXNG instance, for example https://search.example.edu. JSON output must be enabled in its settings (search.formats).',
  },
  tavily: {
    name: 'Tavily',
    label: 'Tavily',
    needs: 'apiKey',
    fieldLabel: 'Tavily API key',
    fieldHint: 'From app.tavily.com, under API keys. It starts with tvly-.',
  },
  brave: {
    name: 'Brave Search',
    label: 'Brave Search',
    needs: 'apiKey',
    fieldLabel: 'Brave Search API key',
    fieldHint: 'The subscription token from api-dashboard.search.brave.com, under API keys.',
  },
  exa: {
    name: 'Exa',
    label: 'Exa',
    needs: 'apiKey',
    fieldLabel: 'Exa API key',
    fieldHint: 'From dashboard.exa.ai, under API keys.',
  },
  serpapi: {
    name: 'SerpApi',
    label: 'SerpApi (Google results)',
    needs: 'apiKey',
    fieldLabel: 'SerpApi API key',
    fieldHint: 'Your private API key, shown at serpapi.com/manage-api-key.',
  },
};
