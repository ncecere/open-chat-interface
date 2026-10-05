import {
  type InstanceSettings,
  SEARCH_PROVIDER_KINDS,
  SEARCH_PROVIDERS,
  type SearchProviderKind,
  type SearchTestResult,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, Notice, SettingsSection } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { SETUP_STATUS_QUERY_KEY, useSetupCheck } from '~/hooks/use-setup-status';
import { ApiError, api } from '~/lib/api-client';

type SearchSettings = InstanceSettings['search'];
type Features = InstanceSettings['features'];
type SearchPatch = Partial<Omit<SearchSettings, 'hasCredential' | 'hasFallbackCredential'>> & {
  apiKey?: string | null;
  fallbackApiKey?: string | null;
};
type CredentialAction = 'keep' | 'replace' | 'clear';

interface SearchDraft {
  enabled: boolean;
  provider: SearchProviderKind | null;
  baseUrl: string;
  maxResults: string;
  /** v0.10: tried when the first provider times out or fails with a server error. */
  fallbackProvider: SearchProviderKind | null;
  fallbackBaseUrl: string;
}

/** The fallback provider's key on the page: kept, replaced or removed, and what was typed. */
interface FallbackKey {
  action: CredentialAction;
  value: string;
}

const KEEP_FALLBACK_KEY: FallbackKey = { action: 'keep', value: '' };

/**
 * Search runs only when both the chat feature and the search service are on,
 * so the page offers one switch that drives both.
 */
function searchIsOn(features: Features, search: SearchSettings): boolean {
  return features.webSearch && search.enabled;
}

function makeDraft(settings: SearchSettings, enabled: boolean): SearchDraft {
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
function keyApplies(saved: SearchSettings, draft: SearchDraft): boolean {
  return saved.hasCredential && saved.provider === draft.provider;
}

/** Whether the stored fallback key belongs to the fallback provider now selected. */
function fallbackKeyApplies(saved: SearchSettings, draft: SearchDraft): boolean {
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

type DraftErrors = {
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

function validateDraft(
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
    errors.maxResults = 'Max results must be a positive whole number.';
  }

  validateFallback(saved, draft, fallbackKey, errors);
  return errors;
}

function changedSearchSettings(
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
function fallbackTestTarget(draft: SearchDraft, fallbackKey: FallbackKey) {
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

function LoadingSearchSettings() {
  return (
    <div
      className="flex items-center gap-3 text-sm text-[var(--text-muted)]"
      role="status"
      aria-busy="true"
      aria-label="Loading search settings"
    >
      <Spinner />
      Loading search settings…
    </div>
  );
}

function SearchAvailability() {
  const check = useSetupCheck('web-search');
  if (check?.status === 'complete') {
    return <Notice title="Web search is available">{check.detail}</Notice>;
  }
  if (check?.status === 'attention') {
    return (
      <Notice tone="warning" title="Web search is not available">
        {check.detail}
      </Notice>
    );
  }
  return null;
}

function SearchSettingsForm({ settings }: { settings: InstanceSettings }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(settings.search);
  const [features, setFeatures] = useState(settings.features);
  const savedEnabled = searchIsOn(features, saved);
  const [draft, setDraft] = useState(() => makeDraft(settings.search, savedEnabled));
  const [credentialAction, setCredentialAction] = useState<CredentialAction>('keep');
  const [apiKey, setApiKey] = useState('');
  const [fallbackKey, setFallbackKey] = useState<FallbackKey>(KEEP_FALLBACK_KEY);
  const [showValidation, setShowValidation] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const validation = validateDraft(saved, draft, credentialAction, apiKey, fallbackKey);
  const providerInfo = draft.provider ? SEARCH_PROVIDERS[draft.provider] : null;
  const savedKeyApplies = keyApplies(saved, draft);
  const isValid = Object.keys(validation).length === 0;
  const patch = changedSearchSettings(
    saved,
    savedEnabled,
    draft,
    credentialAction,
    apiKey,
    fallbackKey,
  );
  const fallbackInfo = draft.fallbackProvider ? SEARCH_PROVIDERS[draft.fallbackProvider] : null;
  const fallbackTarget = fallbackTestTarget(draft, fallbackKey);
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);

  const test = useMutation({
    mutationFn: () =>
      api.post<SearchTestResult>('/admin/settings/search/test', {
        provider: draft.provider,
        ...(providerInfo?.needs === 'baseUrl' ? { baseUrl: draft.baseUrl.trim() || null } : {}),
        ...(providerInfo?.needs === 'apiKey' && credentialAction === 'replace' && apiKey.trim()
          ? { apiKey: apiKey.trim() }
          : {}),
        // v0.10: the fallback provider is tested too, on its own.
        ...(fallbackTarget ? { fallback: fallbackTarget } : {}),
      }),
  });

  const save = useMutation({
    mutationFn: (search: SearchPatch) =>
      api.patch<{ ok: boolean }>('/admin/settings', {
        search,
        // The switch also sets the chat feature. The server replaces the
        // stored features object, so every other feature is sent unchanged.
        ...(search.enabled !== undefined && {
          features: { ...features, webSearch: search.enabled },
        }),
      }),
    onSuccess: (_response, changes) => {
      const {
        apiKey: credential,
        fallbackApiKey: fallbackCredential,
        ...settingsChanges
      } = changes;
      const next: SearchSettings = {
        ...saved,
        ...settingsChanges,
        hasCredential:
          credential === null ? false : typeof credential === 'string' ? true : saved.hasCredential,
        // A key belongs to one provider: the server drops it when the fallback changes.
        hasFallbackCredential:
          typeof fallbackCredential === 'string'
            ? true
            : fallbackCredential === null || changes.fallbackProvider !== undefined
              ? false
              : saved.hasFallbackCredential,
      };
      const nextFeatures =
        changes.enabled === undefined ? features : { ...features, webSearch: changes.enabled };
      setSaved(next);
      setFeatures(nextFeatures);
      setDraft(makeDraft(next, searchIsOn(nextFeatures, next)));
      setCredentialAction('keep');
      setApiKey('');
      setFallbackKey(KEEP_FALLBACK_KEY);
      setShowValidation(false);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, search: next, features: nextFeatures } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY });
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save search settings.',
      );
    },
  });

  function beginEdit() {
    setSuccessMessage(false);
    setErrorMessage(null);
    test.reset();
  }

  return (
    <form
      className="flex flex-col gap-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setShowValidation(true);
        if (isValid && hasChanges) save.mutate(patch);
      }}
    >
      <SettingsSection
        title="Web search"
        description="Choose the service used to ground model responses with current web results."
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <label htmlFor="search-enabled" className="text-sm font-medium">
                Enable web search
              </label>
              <p id="search-enabled-description" className="mt-1 text-xs text-[var(--text-muted)]">
                Lets people ground responses with current web results, using the provider below.
              </p>
            </div>
            <Switch
              id="search-enabled"
              checked={draft.enabled}
              disabled={save.isPending}
              aria-describedby="search-enabled-description"
              onCheckedChange={(enabled) => {
                beginEdit();
                setDraft((current) => ({ ...current, enabled }));
              }}
            />
          </div>

          <SearchAvailability />

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Provider"
              htmlFor="search-provider"
              hint={showValidation ? validation.provider : undefined}
            >
              <Select
                id="search-provider"
                value={draft.provider ?? 'off'}
                disabled={save.isPending}
                onChange={(next) => {
                  beginEdit();
                  const provider = next === 'off' ? null : (next as SearchProviderKind);
                  // Each provider needs its own address or key; nothing carries over.
                  setApiKey('');
                  setCredentialAction('keep');
                  setDraft((current) => ({
                    ...current,
                    provider,
                    baseUrl: provider === saved.provider ? (saved.baseUrl ?? '') : '',
                    enabled: provider === null ? false : current.enabled,
                  }));
                }}
                options={[
                  { value: 'off', label: 'Off / no provider' },
                  ...SEARCH_PROVIDER_KINDS.map((provider) => ({
                    value: provider,
                    label: SEARCH_PROVIDERS[provider].label,
                  })),
                ]}
              />
            </Field>

            <Field
              label="Maximum results"
              htmlFor="search-max-results"
              hint={
                showValidation && validation.maxResults
                  ? validation.maxResults
                  : 'Maximum results requested for each search.'
              }
            >
              <Input
                id="search-max-results"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={draft.maxResults}
                disabled={save.isPending}
                aria-invalid={showValidation && Boolean(validation.maxResults)}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, maxResults: event.target.value }));
                }}
              />
            </Field>
          </div>

          {providerInfo?.needs === 'baseUrl' && (
            <Field
              label={providerInfo.fieldLabel}
              htmlFor="search-base-url"
              hint={
                showValidation && validation.baseUrl ? validation.baseUrl : providerInfo.fieldHint
              }
            >
              <Input
                id="search-base-url"
                type="url"
                value={draft.baseUrl}
                placeholder="https://search.example.edu"
                disabled={save.isPending}
                aria-invalid={showValidation && Boolean(validation.baseUrl)}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, baseUrl: event.target.value }));
                }}
              />
            </Field>
          )}
        </div>
      </SettingsSection>

      {providerInfo?.needs === 'apiKey' && (
        <SettingsSection
          title="API key"
          description="Keys are encrypted by the server and are never shown again."
        >
          <div className="flex flex-col gap-4">
            {savedKeyApplies && credentialAction !== 'replace' && (
              <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <KeyRound
                    className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{providerInfo.fieldLabel} saved</p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Leave it unchanged to keep using it.
                    </p>
                  </div>
                </div>
                {credentialAction === 'keep' && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        beginEdit();
                        setCredentialAction('replace');
                      }}
                    >
                      Replace
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        beginEdit();
                        setApiKey('');
                        setCredentialAction('clear');
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            )}

            {(!savedKeyApplies || credentialAction === 'replace') && (
              <Field
                label={savedKeyApplies ? `New ${providerInfo.fieldLabel}` : providerInfo.fieldLabel}
                htmlFor="search-api-key"
                hint={
                  showValidation && validation.apiKey ? validation.apiKey : providerInfo.fieldHint
                }
              >
                <Input
                  id="search-api-key"
                  type="password"
                  value={apiKey}
                  maxLength={501}
                  autoComplete="new-password"
                  disabled={save.isPending}
                  aria-invalid={showValidation && Boolean(validation.apiKey)}
                  onChange={(event) => {
                    beginEdit();
                    setApiKey(event.target.value);
                    setCredentialAction('replace');
                  }}
                />
              </Field>
            )}

            {credentialAction === 'clear' && (
              <div role="alert" className="rounded-lg bg-[var(--warning)]/10 p-3 text-sm">
                <p className="font-medium">The saved key will be removed when you save.</p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="mt-1 h-auto p-0"
                  onClick={() => {
                    beginEdit();
                    setCredentialAction('keep');
                  }}
                >
                  Keep the saved key
                </Button>
              </div>
            )}
          </div>
        </SettingsSection>
      )}

      <FallbackProviderSection
        saved={saved}
        draft={draft}
        fallbackKey={fallbackKey}
        errors={showValidation ? validation : {}}
        disabled={save.isPending}
        onDraftChange={(change) => {
          beginEdit();
          setDraft((current) => ({ ...current, ...change }));
        }}
        onFallbackKeyChange={(next) => {
          beginEdit();
          setFallbackKey(next);
        }}
      />

      <EditOnly>
        <div className="flex min-h-9 flex-col gap-3 border-t border-[var(--border-subtle)] pt-6 sm:flex-row sm:items-center sm:justify-end">
          <div className="sm:mr-auto" aria-live="polite">
            {errorMessage && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {errorMessage}
              </p>
            )}
            {successMessage && (
              <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                <CheckCircle2 className="size-4" /> Search settings saved.
              </p>
            )}
            {test.data?.ok && providerInfo && (
              <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                <CheckCircle2 className="size-4" /> {providerInfo.name} works: a test search
                returned {test.data.results} {test.data.results === 1 ? 'result' : 'results'}.
              </p>
            )}
            {(test.data?.ok === false || test.error) && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {onThisPage(
                  test.data?.message ??
                    (test.error instanceof ApiError
                      ? test.error.message
                      : 'The test could not run.'),
                )}
              </p>
            )}
            {test.data?.fallback && fallbackInfo && (
              <FallbackTestResult name={fallbackInfo.name} result={test.data.fallback} />
            )}
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={!draft.provider || test.isPending || save.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending && <Spinner />}
            {test.isPending ? 'Testing…' : 'Test search'}
          </Button>
          <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
            {save.isPending && <Spinner />}
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

function FallbackTestResult({
  name,
  result,
}: {
  name: string;
  result: NonNullable<SearchTestResult['fallback']>;
}) {
  return result.ok ? (
    <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
      <CheckCircle2 className="size-4" /> Fallback {name} works: a test search returned{' '}
      {result.results} {result.results === 1 ? 'result' : 'results'}.
    </p>
  ) : (
    <p role="alert" className="text-sm text-[var(--danger)]">
      Fallback: {onThisPage(result.message ?? `${name} test search failed.`)}
    </p>
  );
}

/**
 * The optional fallback provider (v0.10): its own provider, and the address
 * or key that provider needs, stored like the first provider's (keys
 * encrypted and never shown again).
 */
function FallbackProviderSection({
  saved,
  draft,
  fallbackKey,
  errors,
  disabled,
  onDraftChange,
  onFallbackKeyChange,
}: {
  saved: SearchSettings;
  draft: SearchDraft;
  fallbackKey: FallbackKey;
  errors: DraftErrors;
  disabled: boolean;
  onDraftChange: (change: Partial<SearchDraft>) => void;
  onFallbackKeyChange: (key: FallbackKey) => void;
}) {
  const info = draft.fallbackProvider ? SEARCH_PROVIDERS[draft.fallbackProvider] : null;
  const savedKey = fallbackKeyApplies(saved, draft);
  return (
    <SettingsSection
      title="Fallback provider"
      description="Optional. Used only when the provider above does not answer in time or fails with a server or network error, after one retry. A refused key or a used-up quota is not passed on."
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Fallback provider"
          htmlFor="search-fallback-provider"
          hint={errors.fallbackProvider}
        >
          <Select
            id="search-fallback-provider"
            value={draft.fallbackProvider ?? 'none'}
            disabled={disabled}
            onChange={(next) => {
              const provider = next === 'none' ? null : (next as SearchProviderKind);
              // Each provider needs its own address or key; nothing carries over.
              onFallbackKeyChange(KEEP_FALLBACK_KEY);
              onDraftChange({
                fallbackProvider: provider,
                fallbackBaseUrl:
                  provider === saved.fallbackProvider ? (saved.fallbackBaseUrl ?? '') : '',
              });
            }}
            options={[
              { value: 'none', label: 'None' },
              ...SEARCH_PROVIDER_KINDS.map((provider) => ({
                value: provider,
                label: SEARCH_PROVIDERS[provider].label,
              })),
            ]}
          />
        </Field>

        {info?.needs === 'baseUrl' && (
          <Field
            label={`Fallback ${info.fieldLabel}`}
            htmlFor="search-fallback-base-url"
            hint={errors.fallbackBaseUrl ?? info.fieldHint}
          >
            <Input
              id="search-fallback-base-url"
              type="url"
              value={draft.fallbackBaseUrl}
              placeholder="https://search2.example.edu"
              disabled={disabled}
              aria-invalid={Boolean(errors.fallbackBaseUrl)}
              onChange={(event) => onDraftChange({ fallbackBaseUrl: event.target.value })}
            />
          </Field>
        )}

        {info?.needs === 'apiKey' && savedKey && fallbackKey.action !== 'replace' && (
          <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <KeyRound
                className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">Fallback {info.fieldLabel} saved</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {fallbackKey.action === 'clear'
                    ? 'It will be removed when you save, and the fallback will not be used.'
                    : 'Leave it unchanged to keep using it.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {fallbackKey.action === 'keep' ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    aria-label="Replace fallback key"
                    onClick={() => onFallbackKeyChange({ action: 'replace', value: '' })}
                  >
                    Replace
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label="Remove fallback key"
                    onClick={() => onFallbackKeyChange({ action: 'clear', value: '' })}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onFallbackKeyChange(KEEP_FALLBACK_KEY)}
                >
                  Keep the saved key
                </Button>
              )}
            </div>
          </div>
        )}

        {info?.needs === 'apiKey' && (!savedKey || fallbackKey.action === 'replace') && (
          <Field
            label={savedKey ? `New fallback ${info.fieldLabel}` : `Fallback ${info.fieldLabel}`}
            htmlFor="search-fallback-api-key"
            hint={errors.fallbackApiKey ?? `${info.fieldHint} Encrypted and never shown again.`}
          >
            <Input
              id="search-fallback-api-key"
              type="password"
              value={fallbackKey.value}
              maxLength={501}
              autoComplete="new-password"
              disabled={disabled}
              aria-invalid={Boolean(errors.fallbackApiKey)}
              onChange={(event) =>
                onFallbackKeyChange({ action: 'replace', value: event.target.value })
              }
            />
          </Field>
        )}
      </div>
    </SettingsSection>
  );
}

export function AdminSearchPage() {
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<InstanceSettings>('/admin/settings'),
  });

  return (
    <div>
      <AdminPageHeader
        title="Web search"
        description="Configure web search grounding and its upstream provider."
      />

      {settings.isLoading ? (
        <LoadingSearchSettings />
      ) : settings.isError || !settings.data ? (
        <div>
          <p role="alert" className="text-sm text-[var(--danger)]">
            {settings.error instanceof ApiError
              ? settings.error.message
              : 'Unable to load search settings.'}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            disabled={settings.isFetching}
            onClick={() => settings.refetch()}
          >
            {settings.isFetching && <Spinner />} Try again
          </Button>
        </div>
      ) : (
        <SearchSettingsForm settings={settings.data} />
      )}
    </div>
  );
}
