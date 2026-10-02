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
type SearchPatch = Partial<Omit<SearchSettings, 'hasCredential'>> & {
  apiKey?: string | null;
};
type CredentialAction = 'keep' | 'replace' | 'clear';

interface SearchDraft {
  enabled: boolean;
  provider: SearchProviderKind | null;
  baseUrl: string;
  maxResults: string;
}

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
  };
}

/** Whether the stored key belongs to the provider now selected. */
function keyApplies(saved: SearchSettings, draft: SearchDraft): boolean {
  return saved.hasCredential && saved.provider === draft.provider;
}

function validateDraft(
  saved: SearchSettings,
  draft: SearchDraft,
  credentialAction: CredentialAction,
  apiKey: string,
) {
  const errors: { baseUrl?: string; maxResults?: string; provider?: string; apiKey?: string } = {};
  const provider = draft.provider ? SEARCH_PROVIDERS[draft.provider] : null;
  const baseUrl = draft.baseUrl.trim();
  const maxResults = Number(draft.maxResults);

  if (draft.enabled && !provider) {
    errors.provider = 'Choose a provider before enabling search.';
  }

  if (provider?.needs === 'baseUrl') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          errors.baseUrl = 'Enter an HTTP or HTTPS address.';
        }
      } catch {
        errors.baseUrl = 'Enter a full address, starting with https://.';
      }
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

  return errors;
}

function changedSearchSettings(
  saved: SearchSettings,
  savedEnabled: boolean,
  draft: SearchDraft,
  credentialAction: CredentialAction,
  apiKey: string,
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

  return patch;
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
  const [showValidation, setShowValidation] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const validation = validateDraft(saved, draft, credentialAction, apiKey);
  const providerInfo = draft.provider ? SEARCH_PROVIDERS[draft.provider] : null;
  const savedKeyApplies = keyApplies(saved, draft);
  const isValid = Object.keys(validation).length === 0;
  const patch = changedSearchSettings(saved, savedEnabled, draft, credentialAction, apiKey);
  const hasChanges = Object.keys(patch).length > 0;

  const test = useMutation({
    mutationFn: () =>
      api.post<SearchTestResult>('/admin/settings/search/test', {
        provider: draft.provider,
        ...(providerInfo?.needs === 'baseUrl' ? { baseUrl: draft.baseUrl.trim() || null } : {}),
        ...(providerInfo?.needs === 'apiKey' && credentialAction === 'replace' && apiKey.trim()
          ? { apiKey: apiKey.trim() }
          : {}),
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
      const { apiKey: credential, ...settingsChanges } = changes;
      const next: SearchSettings = {
        ...saved,
        ...settingsChanges,
        hasCredential:
          credential === null ? false : typeof credential === 'string' ? true : saved.hasCredential,
      };
      const nextFeatures =
        changes.enabled === undefined ? features : { ...features, webSearch: changes.enabled };
      setSaved(next);
      setFeatures(nextFeatures);
      setDraft(makeDraft(next, searchIsOn(nextFeatures, next)));
      setCredentialAction('keep');
      setApiKey('');
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
                {test.data?.message ??
                  (test.error instanceof ApiError ? test.error.message : 'The test could not run.')}
              </p>
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
