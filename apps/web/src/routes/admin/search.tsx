import { type InstanceSettings, SEARCH_PROVIDER_KINDS, type SearchProviderKind } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader, SettingsSection } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';

type SearchSettings = InstanceSettings['search'];
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

const PROVIDER_LABELS: Record<SearchProviderKind, string> = {
  searxng: 'SearXNG',
  tavily: 'Tavily',
  brave: 'Brave Search',
  exa: 'Exa',
};

function makeDraft(settings: SearchSettings): SearchDraft {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    baseUrl: settings.baseUrl ?? '',
    maxResults: String(settings.maxResults),
  };
}

function validateDraft(draft: SearchDraft, credentialAction: CredentialAction, apiKey: string) {
  const errors: { baseUrl?: string; maxResults?: string; provider?: string; apiKey?: string } = {};
  const baseUrl = draft.baseUrl.trim();
  const maxResults = Number(draft.maxResults);

  if (draft.enabled && draft.provider === null) {
    errors.provider = 'Choose a provider before enabling search.';
  }

  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.baseUrl = 'Enter an HTTP or HTTPS URL.';
      }
    } catch {
      errors.baseUrl = 'Enter a valid absolute URL.';
    }
  }

  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    errors.maxResults = 'Max results must be a positive whole number.';
  }

  if (credentialAction === 'replace' && apiKey.length > 500) {
    errors.apiKey = 'The credential must be 500 characters or fewer.';
  }

  return errors;
}

function changedSearchSettings(
  saved: SearchSettings,
  draft: SearchDraft,
  credentialAction: CredentialAction,
  apiKey: string,
): SearchPatch {
  const patch: SearchPatch = {};
  const baseUrl = draft.baseUrl.trim() || null;
  const maxResults = Number(draft.maxResults);

  if (saved.enabled !== draft.enabled) patch.enabled = draft.enabled;
  if (saved.provider !== draft.provider) patch.provider = draft.provider;
  if (saved.baseUrl !== baseUrl) patch.baseUrl = baseUrl;
  if (Number.isInteger(maxResults) && saved.maxResults !== maxResults) {
    patch.maxResults = maxResults;
  }

  if (credentialAction === 'clear' && saved.hasCredential) patch.apiKey = null;
  if (credentialAction === 'replace' && apiKey.trim()) patch.apiKey = apiKey.trim();

  return patch;
}

function LoadingSearchSettings() {
  return (
    <div
      className="flex max-w-3xl items-center gap-3 text-sm text-[var(--text-muted)]"
      role="status"
      aria-busy="true"
      aria-label="Loading search settings"
    >
      <Spinner />
      Loading search settings…
    </div>
  );
}

function SearchSettingsForm({ initialSettings }: { initialSettings: SearchSettings }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialSettings);
  const [draft, setDraft] = useState(() => makeDraft(initialSettings));
  const [credentialAction, setCredentialAction] = useState<CredentialAction>('keep');
  const [apiKey, setApiKey] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const validation = validateDraft(draft, credentialAction, apiKey);
  const isValid = Object.keys(validation).length === 0;
  const patch = changedSearchSettings(saved, draft, credentialAction, apiKey);
  const hasChanges = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: (search: SearchPatch) => api.patch<{ ok: boolean }>('/admin/settings', { search }),
    onSuccess: (_response, changes) => {
      const { apiKey: credential, ...settingsChanges } = changes;
      const next: SearchSettings = {
        ...saved,
        ...settingsChanges,
        hasCredential:
          credential === null ? false : typeof credential === 'string' ? true : saved.hasCredential,
      };
      setSaved(next);
      setDraft(makeDraft(next));
      setCredentialAction('keep');
      setApiKey('');
      setShowValidation(false);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, search: next } : current,
      );
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
  }

  return (
    <form
      className="flex max-w-3xl flex-col gap-8"
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
                Makes the configured search provider available to supported models.
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
                aria-invalid={showValidation && Boolean(validation.provider)}
                onChange={(event) => {
                  beginEdit();
                  const provider =
                    event.target.value === 'off'
                      ? null
                      : (event.target.value as SearchProviderKind);
                  setDraft((current) => ({
                    ...current,
                    provider,
                    enabled: provider === null ? false : current.enabled,
                  }));
                }}
              >
                <option value="off">Off / no provider</option>
                {SEARCH_PROVIDER_KINDS.map((provider) => (
                  <option key={provider} value={provider}>
                    {PROVIDER_LABELS[provider]}
                  </option>
                ))}
              </Select>
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

          <Field
            label="Base URL (optional)"
            htmlFor="search-base-url"
            hint={
              showValidation && validation.baseUrl
                ? validation.baseUrl
                : 'Override the provider’s default endpoint, for example for a self-hosted SearXNG instance.'
            }
          >
            <Input
              id="search-base-url"
              type="url"
              value={draft.baseUrl}
              placeholder="https://search.example.com"
              disabled={save.isPending}
              aria-invalid={showValidation && Boolean(validation.baseUrl)}
              onChange={(event) => {
                beginEdit();
                setDraft((current) => ({ ...current, baseUrl: event.target.value }));
              }}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        title="API credential"
        description="Credentials are encrypted by the server and are never returned to this page."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <KeyRound
                className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {saved.hasCredential ? 'Credential configured' : 'No credential configured'}
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {saved.hasCredential
                    ? 'Leave it unchanged to keep the stored credential.'
                    : 'SearXNG may not require a credential; hosted providers generally do.'}
                </p>
              </div>
            </div>
            {saved.hasCredential && credentialAction === 'keep' && (
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
                  Clear
                </Button>
              </div>
            )}
          </div>

          {(credentialAction === 'replace' || !saved.hasCredential) && (
            <Field
              label={saved.hasCredential ? 'Replacement credential' : 'API credential (optional)'}
              htmlFor="search-api-key"
              hint={
                showValidation && validation.apiKey
                  ? validation.apiKey
                  : 'A blank field is never sent and does not clear a stored credential.'
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
              <p className="font-medium">The stored credential will be cleared when you save.</p>
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
                Keep existing credential
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

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
        </div>
        <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
          {save.isPending && <Spinner />}
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
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
        title="Search"
        description="Configure web search grounding and its upstream provider."
      />

      {settings.isLoading ? (
        <LoadingSearchSettings />
      ) : settings.isError || !settings.data ? (
        <div className="max-w-3xl">
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
        <SearchSettingsForm initialSettings={settings.data.search} />
      )}
    </div>
  );
}
