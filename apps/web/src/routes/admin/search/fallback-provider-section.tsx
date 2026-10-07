import {
  SEARCH_PROVIDER_KINDS,
  SEARCH_PROVIDERS,
  type SearchProviderKind,
  type SearchTestResult,
} from '@oci/shared';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { SettingsSection } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field, fieldErrorId, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import {
  type DraftErrors,
  type FallbackKey,
  fallbackKeyApplies,
  KEEP_FALLBACK_KEY,
  onThisPage,
  type SearchDraft,
  type SearchSettings,
} from './search-draft';

export function FallbackTestResult({
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
export function FallbackProviderSection({
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
          error={errors.fallbackProvider ?? null}
        >
          <Select
            id="search-fallback-provider"
            aria-describedby={
              errors.fallbackProvider ? fieldErrorId('search-fallback-provider') : undefined
            }
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
            error={errors.fallbackBaseUrl ?? null}
            hint={info.fieldHint}
          >
            <Input
              id="search-fallback-base-url"
              type="url"
              value={draft.fallbackBaseUrl}
              placeholder="https://search2.example.edu"
              disabled={disabled}
              {...invalidFieldProps('search-fallback-base-url', errors.fallbackBaseUrl ?? null)}
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
            error={errors.fallbackApiKey ?? null}
            hint={`${info.fieldHint} Encrypted and never shown again.`}
          >
            <Input
              id="search-fallback-api-key"
              type="password"
              value={fallbackKey.value}
              maxLength={501}
              autoComplete="new-password"
              disabled={disabled}
              {...invalidFieldProps('search-fallback-api-key', errors.fallbackApiKey ?? null)}
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
