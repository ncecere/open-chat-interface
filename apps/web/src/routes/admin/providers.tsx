import type { DiscoveredModel, Provider } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader, EmptyState, Row, RowList } from '~/components/admin/admin-ui';
import { DiscoverModelsDialog } from '~/components/admin/discover-models-dialog';
import { PROVIDER_KIND_LABELS, ProviderFormDialog } from '~/components/admin/provider-form-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';

export function AdminProvidersPage() {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<{ provider: Provider | null } | null>(null);
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
      <AdminPageHeader
        title="Providers & Keys"
        description="Configure upstream credentials. Access to a model here does not expose it to users — models must be added to the catalog separately."
        actions={
          <Button variant="primary" onClick={() => setFormFor({ provider: null })}>
            <Plus />
            Add provider
          </Button>
        }
      />

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : data && data.providers.length > 0 ? (
        <RowList>
          {data.providers.map((provider) => (
            <Row key={provider.id}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-control-hover)]">
                <KeyRound className="size-4 text-[var(--text-secondary)]" />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{provider.label}</p>
                  <Badge variant="neutral">{PROVIDER_KIND_LABELS[provider.kind]}</Badge>
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
                aria-label={`Edit ${provider.label}`}
                onClick={() => setFormFor({ provider })}
              >
                <Pencil />
              </Button>

              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${provider.label}`}
                onClick={() => remove.mutate(provider.id)}
              >
                <Trash2 />
              </Button>
            </Row>
          ))}
        </RowList>
      ) : (
        <EmptyState icon={KeyRound} title="No providers configured yet.">
          Add a provider to make models available. Users cannot select any model until one is
          enabled in the catalog.
        </EmptyState>
      )}

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && (
          <ProviderFormDialog provider={formFor.provider} onClose={() => setFormFor(null)} />
        )}
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
