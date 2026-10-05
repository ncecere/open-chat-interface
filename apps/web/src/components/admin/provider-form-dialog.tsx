import { PROVIDER_KINDS, type Provider, type ProviderKind } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { ApiError, api } from '~/lib/api-client';

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'openai-compatible': 'OpenAI-compatible',
};

const KIND_HINTS: Record<ProviderKind, string> = {
  openai: 'Official OpenAI API.',
  anthropic: 'Official Anthropic API.',
  google: 'Google Generative Language API.',
  'openai-compatible': 'Ollama, vLLM, LM Studio, LiteLLM, OpenRouter, or any compatible gateway.',
};

type CredentialAction = 'keep' | 'replace' | 'clear';

export function ProviderFormDialog({
  provider,
  onClose,
}: {
  provider: Provider | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? 'openai');
  const [label, setLabel] = useState(provider?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [apiKey, setApiKey] = useState('');
  const [credentialAction, setCredentialAction] = useState<CredentialAction>(
    provider?.hasCredential ? 'keep' : 'replace',
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      provider
        ? api.patch(`/admin/providers/${provider.id}`, body)
        : api.post('/admin/providers', body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] }),
        queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
      ]);
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'The provider could not be saved.'),
  });

  const requiresBaseUrl = kind === 'openai-compatible';
  const trimmedBaseUrl = baseUrl.trim();

  function credentialField(): { apiKey?: string | null } {
    if (credentialAction === 'clear') return { apiKey: null };
    if (credentialAction === 'replace' && apiKey.trim()) return { apiKey: apiKey.trim() };
    return {};
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (requiresBaseUrl && !trimmedBaseUrl) {
      setError('OpenAI-compatible providers require a base URL.');
      return;
    }

    save.mutate(
      provider
        ? {
            kind,
            label: label.trim(),
            baseUrl: trimmedBaseUrl || null,
            enabled,
            ...credentialField(),
          }
        : {
            kind,
            label: label.trim() || PROVIDER_KIND_LABELS[kind],
            baseUrl: trimmedBaseUrl || null,
            enabled,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          },
    );
  }

  const kindLocked = Boolean(provider && provider.modelCount > 0);

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{provider ? 'Edit provider' : 'Add provider'}</DialogTitle>
        <DialogDescription>
          Credentials are encrypted at rest and never returned to the browser.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          label="Provider type"
          htmlFor="provider-kind"
          hint={
            kindLocked
              ? `Locked while ${provider?.modelCount} catalog model${provider?.modelCount === 1 ? '' : 's'} use this provider.`
              : KIND_HINTS[kind]
          }
        >
          <Select
            id="provider-kind"
            value={kind}
            disabled={kindLocked}
            onChange={(next) => setKind(next as ProviderKind)}
            options={PROVIDER_KINDS.map((option) => ({
              value: option,
              label: PROVIDER_KIND_LABELS[option],
            }))}
          />
        </Field>

        <Field label="Display name" htmlFor="provider-label" hint="Shown only in this dashboard.">
          <Input
            id="provider-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={PROVIDER_KIND_LABELS[kind]}
            required={Boolean(provider)}
          />
        </Field>

        <Field
          label={requiresBaseUrl ? 'Base URL' : 'Base URL (optional)'}
          htmlFor="provider-base-url"
          hint={
            requiresBaseUrl
              ? 'For example http://localhost:11434/v1'
              : 'Override the default endpoint.'
          }
        >
          <Input
            id="provider-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            required={requiresBaseUrl}
          />
        </Field>

        {provider?.hasCredential ? (
          <Field
            label="API key"
            htmlFor="provider-api-key"
            hint={`A key ending in ${provider.credentialHint ?? '••••'} is stored. Existing keys are never displayed.`}
          >
            <div className="flex flex-col gap-2">
              <Select
                id="provider-credential-action"
                aria-label="API key action"
                value={credentialAction}
                onChange={(next) => setCredentialAction(next as CredentialAction)}
                options={[
                  { value: 'keep', label: 'Keep the stored key' },
                  { value: 'replace', label: 'Replace the key' },
                  { value: 'clear', label: 'Remove the key' },
                ]}
              />
              {credentialAction === 'replace' && (
                <Input
                  id="provider-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                  required
                />
              )}
            </div>
          </Field>
        ) : (
          <Field
            label="API key"
            htmlFor="provider-api-key"
            hint={
              kind === 'openai-compatible'
                ? 'Leave blank for endpoints that need no key.'
                : 'Required while the provider is enabled.'
            }
          >
            <Input
              id="provider-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              required={kind !== 'openai-compatible' && enabled}
            />
          </Field>
        )}

        <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
          <div>
            <label htmlFor="provider-enabled" className="text-sm font-medium">
              Enabled
            </label>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Disabling stops new requests without removing the catalog models.
            </p>
          </div>
          <Switch id="provider-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {provider ? 'Save changes' : 'Add provider'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
