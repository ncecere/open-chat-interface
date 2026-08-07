import {
  type DiscoveredModel,
  PROVIDER_KINDS,
  type Provider,
  type ProviderKind,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { DiscoverModelsDialog } from '~/components/admin/discover-models-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import {
  Dialog,
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
import { ApiError, api } from '~/lib/api-client';

const KIND_LABELS: Record<ProviderKind, string> = {
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

function AddProviderDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ProviderKind>('openai');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/admin/providers', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to add provider'),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    create.mutate({
      kind,
      label: label.trim() || KIND_LABELS[kind],
      baseUrl: baseUrl.trim() || null,
      apiKey: apiKey.trim() || undefined,
      enabled: true,
    });
  }

  const requiresBaseUrl = kind === 'openai-compatible';

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Add provider</DialogTitle>
        <DialogDescription>
          Credentials are encrypted at rest and never returned to the browser.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Provider type" htmlFor="kind" hint={KIND_HINTS[kind]}>
          <Select
            id="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as ProviderKind)}
          >
            {PROVIDER_KINDS.map((option) => (
              <option key={option} value={option}>
                {KIND_LABELS[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Display name" htmlFor="label" hint="Shown only in this dashboard.">
          <Input
            id="label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={KIND_LABELS[kind]}
          />
        </Field>

        <Field
          label={requiresBaseUrl ? 'Base URL' : 'Base URL (optional)'}
          htmlFor="baseUrl"
          hint={
            requiresBaseUrl
              ? 'For example http://localhost:11434/v1'
              : 'Override the default endpoint.'
          }
        >
          <Input
            id="baseUrl"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            required={requiresBaseUrl}
          />
        </Field>

        <Field label="API key" htmlFor="apiKey" hint="Leave blank for endpoints that need no key.">
          <Input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-..."
            autoComplete="off"
          />
        </Field>

        {error && (
          <p className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            Add provider
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function AdminProvidersPage() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [discoverFor, setDiscoverFor] = useState<Provider | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: () => api.get<{ providers: Provider[] }>('/admin/providers'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/providers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] }),
  });

  const discover = useMutation({
    mutationFn: (id: string) =>
      api.post<{ models: DiscoveredModel[] }>(`/admin/providers/${id}/discover`),
  });

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Providers &amp; Keys</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Configure upstream credentials. Access to a model here does not expose it to users —
            models must be added to the catalog separately.
          </p>
        </div>
        <Button variant="primary" onClick={() => setAddOpen(true)}>
          <Plus />
          Add provider
        </Button>
      </div>

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : data && data.providers.length > 0 ? (
        <div className="mt-8 flex flex-col gap-3">
          {data.providers.map((provider) => (
            <Card key={provider.id}>
              <CardContent className="flex items-center gap-4 p-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-control-hover)]">
                  <KeyRound className="size-4 text-[var(--text-secondary)]" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{provider.label}</p>
                    <Badge variant="neutral">{KIND_LABELS[provider.kind]}</Badge>
                    {!provider.enabled && <Badge variant="warning">disabled</Badge>}
                  </div>
                  <p className="truncate text-xs text-[var(--text-muted)]">
                    {provider.baseUrl ?? 'Default endpoint'}
                    {provider.credentialHint ? ` · key ${provider.credentialHint}` : ' · no key'}
                    {` · ${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}`}
                  </p>
                </div>

                <Button
                  variant="secondary"
                  size="sm"
                  disabled={discover.isPending}
                  onClick={async () => {
                    const result = await discover.mutateAsync(provider.id);
                    setDiscoverFor({ ...provider, modelCount: result.models.length });
                  }}
                >
                  Discover models
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${provider.label}`}
                  onClick={() => remove.mutate(provider.id)}
                >
                  <Trash2 />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="mt-8">
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <KeyRound className="size-8 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-secondary)]">No providers configured yet.</p>
            <p className="max-w-md text-xs text-[var(--text-muted)]">
              Add a provider to make models available. Users cannot select any model until one is
              enabled in the catalog.
            </p>
          </CardContent>
        </Card>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        {addOpen && <AddProviderDialog onClose={() => setAddOpen(false)} />}
      </Dialog>

      <Dialog open={Boolean(discoverFor)} onOpenChange={(open) => !open && setDiscoverFor(null)}>
        {discoverFor && discover.data && (
          <DiscoverModelsDialog
            provider={discoverFor}
            models={discover.data.models}
            onClose={() => setDiscoverFor(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
