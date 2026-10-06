import {
  type InstanceSettings,
  MAX_SEARCH_RESULTS,
  SEARCH_PROVIDERS,
  type SearchProviderKind,
} from '@oci/shared';

export type SearchSettings = InstanceSettings['search'];
type Features = InstanceSettings['features'];
export type SearchPatch = Partial<
  Omit<SearchSettings, 'hasCredential' | 'hasFallbackCredential'>
> & {
  apiKey?: string | null;
  fallbackApiKey?: string | null;
};
export type CredentialAction = 'keep' | 'replace' | 'clear';

export interface SearchDraft {
  enabled: boolean;
  provider: SearchProviderKind | null;
  baseUrl: string;
  maxResults: string;
  /** v0.10: tried when the first provider times out or fails with a server error. */
  fallbackProvider: SearchProviderKind | null;
  fallbackBaseUrl: string;
}

/** The fallback provider's key on the page: kept, replaced or removed, and what was typed. */
export interface FallbackKey {
  action: CredentialAction;
  value: string;
}

export const KEEP_FALLBACK_KEY: FallbackKey = { action: 'keep', value: '' };

/**
 * Search runs only when both the chat feature and the search service are on,
 * so the page offers one switch that drives both.
 */
export function searchIsOn(features: Features, search: SearchSettings): boolean {
  return features.webSearch && search.enabled;
}

export function makeDraft(settings: SearchSettings, enabled: boolean): SearchDraft {
  return {
    enabled,
    provider: settings.provider,
    baseUrl: settings.baseUrl ?? '',
    maxResults: String(settings.maxResults),
    fallbackProvider: settings.fallbackProvider ?? null,
    fallbackBaseUrl: settings.fallbackBaseUrl ?? '',
  };
}

/** Whether the stored key belongs to the provider now selected. */
export function keyApplies(saved: SearchSettings, draft: SearchDraft): boolean {
  return saved.hasCredential && saved.provider === draft.provider;
}

/** Whether the stored fallback key belongs to the fallback provider now selected. */
export function fallbackKeyApplies(saved: SearchSettings, draft: SearchDraft): boolean {
  return Boolean(saved.hasFallbackCredential) && saved.fallbackProvider === draft.fallbackProvider;
}

/** Why an address is not usable, or undefined when it is. */
function addressProblem(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Enter an HTTP or HTTPS address.';
    }
  } catch {
    return 'Enter a full address, starting with https://.';
  }
  return undefined;
}

export type DraftErrors = {
  baseUrl?: string;
  maxResults?: string;
  provider?: string;
  apiKey?: string;
  fallbackProvider?: string;
  fallbackBaseUrl?: string;
  fallbackApiKey?: string;
};

/**
 * The search services' messages point to "the Web search page" wherever they
 * are shown (health, a failed reply); here, that is this page (#86).
 */
export function onThisPage(message: string): string {
  return message
    .replace(/\. An administrator needs to check it on the Web search page\./, '. Check it here.')
    .replace(/ on the Web search page\./, ' here.');
}

/** The fallback provider (v0.10) needs its own address or key and a service of its own. */
function validateFallback(
  saved: SearchSettings,
  draft: SearchDraft,
  fallbackKey: FallbackKey,
  errors: DraftErrors,
) {
  if (!draft.fallbackProvider) return;
  const fallback = SEARCH_PROVIDERS[draft.fallbackProvider];
  const baseUrl = draft.fallbackBaseUrl.trim();
  if (draft.fallbackProvider === draft.provider && fallback.needs === 'apiKey') {
    errors.fallbackProvider = `Choose a different service than ${fallback.name} for the fallback.`;
  }
  if (fallback.needs === 'baseUrl') {
    if (!baseUrl) {
      errors.fallbackBaseUrl = `Enter the fallback ${fallback.fieldLabel}, or choose no fallback.`;
    } else if (addressProblem(baseUrl)) {
      errors.fallbackBaseUrl = addressProblem(baseUrl);
    } else if (draft.fallbackProvider === draft.provider && baseUrl === draft.baseUrl.trim()) {
      errors.fallbackBaseUrl = 'The fallback SearXNG must be at a different address.';
    }
  } else {
    const keepsKey = fallbackKeyApplies(saved, draft) && fallbackKey.action === 'keep';
    if (fallbackKey.action === 'replace' && fallbackKey.value.length > 500) {
      errors.fallbackApiKey = 'The key must be 500 characters or fewer.';
    } else if (!keepsKey && !fallbackKey.value.trim()) {
      errors.fallbackApiKey = `Enter the fallback ${fallback.fieldLabel}, or choose no fallback.`;
    }
  }
}

export function validateDraft(
  saved: SearchSettings,
  draft: SearchDraft,
  credentialAction: CredentialAction,
  apiKey: string,
  fallbackKey: FallbackKey = KEEP_FALLBACK_KEY,
) {
  const errors: DraftErrors = {};
  const provider = draft.provider ? SEARCH_PROVIDERS[draft.provider] : null;
  const baseUrl = draft.baseUrl.trim();
  const maxResults = Number(draft.maxResults);

  if (draft.enabled && !provider) {
    errors.provider = 'Choose a provider before enabling search.';
  }

  if (provider?.needs === 'baseUrl') {
    if (baseUrl) {
      const problem = addressProblem(baseUrl);
      if (problem) errors.baseUrl = problem;
    } else if (draft.enabled) {
      errors.baseUrl = `Enter the ${provider.fieldLabel} to enable search.`;
    }
  }

  if (provider?.needs === 'apiKey') {
    const keepsKey = keyApplies(saved, draft) && credentialAction === 'keep';
    if (credentialAction === 'replace' && apiKey.length > 500) {
      errors.apiKey = 'The key must be 500 characters or fewer.';
    } else if (draft.enabled && !keepsKey && !apiKey.trim()) {
      errors.apiKey = `Enter the ${provider.fieldLabel} to enable search.`;
    }
  }

  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    errors.maxResults = 'Maximum results must be a positive whole number.';
  } else if (maxResults > MAX_SEARCH_RESULTS) {
    errors.maxResults = `Maximum results can be at most ${MAX_SEARCH_RESULTS}.`;
  }

  validateFallback(saved, draft, fallbackKey, errors);
  return errors;
}

export function changedSearchSettings(
  saved: SearchSettings,
  savedEnabled: boolean,
  draft: SearchDraft,
  credentialAction: CredentialAction,
  apiKey: string,
  fallbackKey: FallbackKey = KEEP_FALLBACK_KEY,
): SearchPatch {
  const patch: SearchPatch = {};
  const needs = draft.provider ? SEARCH_PROVIDERS[draft.provider].needs : null;
  const baseUrl = needs === 'baseUrl' ? draft.baseUrl.trim() || null : null;
  const maxResults = Number(draft.maxResults);

  if (savedEnabled !== draft.enabled) patch.enabled = draft.enabled;
  if (saved.provider !== draft.provider) patch.provider = draft.provider;
  if (saved.baseUrl !== baseUrl) patch.baseUrl = baseUrl;
  if (Number.isInteger(maxResults) && saved.maxResults !== maxResults) {
    patch.maxResults = maxResults;
  }

  if (needs === 'apiKey') {
    if (credentialAction === 'clear' && keyApplies(saved, draft)) patch.apiKey = null;
    if (credentialAction === 'replace' && apiKey.trim()) patch.apiKey = apiKey.trim();
  }

  const fallbackNeeds = draft.fallbackProvider
    ? SEARCH_PROVIDERS[draft.fallbackProvider].needs
    : null;
  const fallbackBaseUrl = fallbackNeeds === 'baseUrl' ? draft.fallbackBaseUrl.trim() || null : null;
  if ((saved.fallbackProvider ?? null) !== draft.fallbackProvider) {
    patch.fallbackProvider = draft.fallbackProvider;
  }
  if ((saved.fallbackBaseUrl ?? null) !== fallbackBaseUrl) patch.fallbackBaseUrl = fallbackBaseUrl;
  if (fallbackNeeds === 'apiKey') {
    if (fallbackKey.action === 'clear' && fallbackKeyApplies(saved, draft)) {
      patch.fallbackApiKey = null;
    }
    if (fallbackKey.action === 'replace' && fallbackKey.value.trim()) {
      patch.fallbackApiKey = fallbackKey.value.trim();
    }
  }

  return patch;
}

/** The fallback provider's own address or key, as the test sends it. */
export function fallbackTestTarget(draft: SearchDraft, fallbackKey: FallbackKey) {
  if (!draft.fallbackProvider) return undefined;
  const needs = SEARCH_PROVIDERS[draft.fallbackProvider].needs;
  return {
    provider: draft.fallbackProvider,
    ...(needs === 'baseUrl' ? { baseUrl: draft.fallbackBaseUrl.trim() || null } : {}),
    ...(needs === 'apiKey' && fallbackKey.action === 'replace' && fallbackKey.value.trim()
      ? { apiKey: fallbackKey.value.trim() }
      : {}),
  };
}
