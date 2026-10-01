import type { DiscoveredModel, Provider } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { EmptyState, LoadError, MutationError, Row, RowList } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { DiscoverModelsDialog } from '~/components/admin/discover-models-dialog';
import { PROVIDER_KIND_LABELS, ProviderFormDialog } from '~/components/admin/provider-form-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { api } from '~/lib/api-client';

/** Anchor for links that point people at a provider's "Discover models" action. */
export const PROVIDERS_SECTION_ID = 'providers';

/**
 * Upstream credentials, shown at the top of Providers & models. Connecting a
 * provider exposes nothing on its own; "Discover models" adds chosen models to
 * the catalog below it on the same page.
 */
export function ProvidersSection() {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<{ provider: Provider | null } | null>(null);
  const [discoverFor, setDiscoverFor] = useState<Provider | null>(null);
  const [deleteFor, setDeleteFor] = useState<Provider | null>(null);

  const providers = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: () => api.get<{ providers: Provider[] }>('/admin/providers'),
  });
  const { data, isLoading } = providers;

  const discover = useMutation({
    mutationFn: (provider: Provider) =>
      api.post<{ models: DiscoveredModel[] }>(`/admin/providers/${provider.id}/discover`),
    onSuccess: (result, provider) =>
      setDiscoverFor({ ...provider, modelCount: result.models.length }),
  });

  async function deleteProvider(provider: Provider) {
    await api.delete(`/admin/providers/${provider.id}`);
    // Deleting a provider removes its catalog models too.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }),
      queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] }),
      queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
    ]);
  }

  return (
    <section
      id={PROVIDERS_SECTION_ID}
      aria-labelledby="providers-heading"
      className="flex scroll-mt-6 flex-col gap-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="providers-heading" className="text-base font-semibold text-[var(--text-primary)]">
            Providers
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
            Upstream credentials. Connecting a provider does not expose its models to anyone — use
            Discover models to add the ones you want to the catalog below.
          </p>
        </div>
        <EditOnly>
          <Button variant="secondary" onClick={() => setFormFor({ provider: null })}>
            <Plus />
            Add provider
          </Button>
        </EditOnly>
      </div>

      <MutationError
        error={discover.error}
        message={`Models could not be discovered${discover.variables ? ` for ${discover.variables.label}` : ''}.`}
      />

      {isLoading ? (
        <div className="py-8" role="status" aria-label="Loading providers">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : providers.isError || !data ? (
        <LoadError title="Providers could not be loaded." query={providers} />
      ) : data.providers.length > 0 ? (
        <RowList>
          {data.providers.map((provider) => (
            // Actions wrap below the details on narrow screens, so the name
            // and endpoint are never squeezed out by the buttons.
            <Row key={provider.id} className="flex-wrap gap-y-2 sm:flex-nowrap">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-control-hover)]">
                <KeyRound className="size-4 text-[var(--text-secondary)]" />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="min-w-0 truncate font-medium">{provider.label}</p>
                  <Badge variant="neutral">{PROVIDER_KIND_LABELS[provider.kind]}</Badge>
                  {!provider.enabled && <Badge variant="warning">disabled</Badge>}
                </div>
                <p className="truncate text-xs text-[var(--text-muted)]">
                  {provider.baseUrl ?? 'Default endpoint'}
                  {provider.credentialHint ? ` · key ${provider.credentialHint}` : ' · no key'}
                  {` · ${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}`}
                </p>
              </div>

              <EditOnly>
                <div className="flex w-full items-center justify-end gap-1 sm:w-auto">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={discover.isPending}
                    onClick={() => discover.mutate(provider)}
                  >
                    {discover.isPending && discover.variables?.id === provider.id && <Spinner />}
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
                    onClick={() => setDeleteFor(provider)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </EditOnly>
            </Row>
          ))}
        </RowList>
      ) : (
        <EmptyState icon={KeyRound} title="No providers configured yet.">
          Add a provider, then discover its models. Users cannot select any model until one is
          enabled in the catalog.
        </EmptyState>
      )}

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && (
          <ProviderFormDialog provider={formFor.provider} onClose={() => setFormFor(null)} />
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteFor)}
        onOpenChange={(open) => !open && setDeleteFor(null)}
        title={`Delete ${deleteFor?.label ?? 'provider'}?`}
        description={
          deleteFor
            ? `Its stored key and ${deleteFor.modelCount} catalog model${deleteFor.modelCount === 1 ? '' : 's'} will be removed, and users will no longer be able to select them. This action cannot be undone.`
            : ''
        }
        confirmLabel="Delete provider"
        pendingLabel="Deleting…"
        errorMessage="The provider could not be deleted."
        onConfirm={() => (deleteFor ? deleteProvider(deleteFor) : Promise.resolve())}
      />

      <Dialog open={Boolean(discoverFor)} onOpenChange={(open) => !open && setDiscoverFor(null)}>
        {discoverFor && discover.data && (
          <DiscoverModelsDialog
            provider={discoverFor}
            models={discover.data.models}
            onClose={() => setDiscoverFor(null)}
          />
        )}
      </Dialog>
    </section>
  );
}
