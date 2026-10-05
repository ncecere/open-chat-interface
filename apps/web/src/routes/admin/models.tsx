import {
  type AdminModel,
  effectiveOutputTokens,
  FALLBACK_CONTEXT_WINDOW,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type Provider,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Cpu, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EditableFieldset, EditOnly, useAdminAccess } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  MutationError,
  Notice,
  Row,
  RowList,
} from '~/components/admin/admin-ui';
import { CapacityLimitsButton } from '~/components/admin/capacity-limits';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { EmbeddingsSection } from '~/components/admin/embeddings-section';
import { ModelFormDialog } from '~/components/admin/model-form-dialog';
import { LabLogo } from '~/components/model/lab-logo';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { SETUP_STATUS_QUERY_KEY, useSetupCheck } from '~/hooks/use-setup-status';
import { DEFAULT_MODELS_TAB, type ModelsTab, validateModelsSearch } from '~/lib/admin-search';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import { ProvidersSection } from '~/routes/admin/providers';

const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  vision: 'Vision',
  reasoning: 'Reasoning',
  effort_control: 'Effort',
  tool_calling: 'Tools',
  image_generation: 'Images',
  pdf_comprehension: 'PDF',
  fast: 'Fast',
  web_search: 'Search',
};

/**
 * The limits OCI budgets conversations with, and where an unset one comes
 * from. Edited in the model form.
 */
function ModelLimits({ model }: { model: AdminModel }) {
  const tokens = (value: number) => `${value.toLocaleString('en-US')} tokens`;
  const output = effectiveOutputTokens(model.contextWindow, model.maxOutputTokens);
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-[var(--text-secondary)]">Context window</dt>
      <dd className="text-[var(--text-muted)]">
        {model.contextWindow === null
          ? `Not set; OCI assumes ${tokens(FALLBACK_CONTEXT_WINDOW)}`
          : tokens(model.contextWindow)}
      </dd>
      <dt className="text-[var(--text-secondary)]">Max output</dt>
      <dd className="text-[var(--text-muted)]">
        {model.maxOutputTokens === null
          ? `Not set; OCI reserves ${tokens(output)}`
          : tokens(model.maxOutputTokens)}
      </dd>
    </dl>
  );
}

function ModelRow({
  model,
  onEdit,
  onRemove,
}: {
  model: AdminModel;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const { canEdit } = useAdminAccess();
  const [expanded, setExpanded] = useState(false);
  const [displayName, setDisplayName] = useState(model.displayName);

  // Follow the server value whenever it changes, including after a refetch.
  useEffect(() => setDisplayName(model.displayName), [model.displayName]);

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/admin/models/${model.id}`, patch),
    // Refetch on failure too, so every control shows what the server holds.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] }),
        queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
      ]),
    onError: () => setDisplayName(model.displayName),
  });

  function toggleCapability(capability: ModelCapability) {
    const next = model.capabilities.includes(capability)
      ? model.capabilities.filter((entry) => entry !== capability)
      : [...model.capabilities, capability];
    update.mutate({ capabilities: next });
  }

  function toggleRole(role: UserRole) {
    const next = model.visibleToRoles.includes(role)
      ? model.visibleToRoles.filter((entry) => entry !== role)
      : [...model.visibleToRoles, role];
    update.mutate({ visibleToRoles: next });
  }

  return (
    <div>
      <Row className="gap-3">
        <Switch
          checked={model.enabled}
          disabled={update.isPending || !canEdit}
          onCheckedChange={(enabled) => update.mutate({ enabled })}
          aria-label={`Enable ${model.displayName}`}
        />

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <LabLogo labId={model.labId} className="size-4" />
            <span className="min-w-0 truncate font-medium">{model.displayName}</span>
            {model.isDefault && <Badge variant="accent">default</Badge>}
          </div>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {model.providerLabel} · {model.upstreamModelId}
          </p>
        </button>

        <div className="hidden items-center gap-1 lg:flex">
          {model.capabilities.slice(0, 4).map((capability) => (
            <Badge key={capability} variant="soft">
              {CAPABILITY_LABELS[capability]}
            </Badge>
          ))}
        </div>

        <CapacityLimitsButton target={{ kind: 'model', id: model.id, name: model.displayName }} />

        <EditOnly>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${model.displayName}`}
            onClick={onEdit}
          >
            <Pencil />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${model.displayName}`}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </EditOnly>
      </Row>

      <MutationError
        error={update.error}
        message={`Changes to ${model.displayName} could not be saved.`}
        className="px-4 pb-3"
      />

      {expanded && (
        <EditableFieldset className="flex flex-col gap-4 border-t border-[var(--border-subtle)] p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" htmlFor={`name-${model.id}`}>
              <Input
                id={`name-${model.id}`}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={() => {
                  const next = displayName.trim();
                  if (next && next !== model.displayName) {
                    update.mutate({ displayName: next });
                  } else {
                    setDisplayName(model.displayName);
                  }
                }}
              />
            </Field>
          </div>

          <ModelLimits model={model} />

          <div>
            <p className="mb-2 text-sm text-[var(--text-secondary)]">Capabilities</p>
            <div className="flex flex-wrap gap-1.5">
              {MODEL_CAPABILITIES.map((capability) => {
                const active = model.capabilities.includes(capability);
                return (
                  <button
                    key={capability}
                    type="button"
                    aria-pressed={active}
                    disabled={update.isPending}
                    onClick={() => toggleCapability(capability)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      active
                        ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                        : 'bg-[var(--bg-control-alt)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {CAPABILITY_LABELS[capability]}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm text-[var(--text-secondary)]">Visible to roles</p>
            <div className="flex flex-wrap gap-1.5">
              {USER_ROLES.map((role) => {
                const active = model.visibleToRoles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    aria-pressed={active}
                    disabled={update.isPending}
                    onClick={() => toggleRole(role)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors',
                      active
                        ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                        : 'bg-[var(--bg-control-alt)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {role}
                  </button>
                );
              })}
            </div>
          </div>
        </EditableFieldset>
      )}
    </div>
  );
}

/**
 * Chooses the model a new conversation starts on.
 *
 * The flag lives on the model row (the server clears it from every other model
 * in the same write), but the choice sits with the catalog it is made from.
 * Only models someone could actually use are offered: enabled, on an enabled
 * provider.
 */
function DefaultModelSelector({
  models,
  providers,
}: {
  models: AdminModel[];
  providers: Provider[] | undefined;
}) {
  const queryClient = useQueryClient();
  const check = useSetupCheck('default-model');
  const [saved, setSaved] = useState(false);

  const enabledProviders = new Set(
    (providers ?? []).filter((provider) => provider.enabled).map((provider) => provider.id),
  );
  const selectable = models.filter(
    (model) => model.enabled && enabledProviders.has(model.providerId),
  );
  const current = models.find((model) => model.isDefault);
  const currentSelectable = current && selectable.some((model) => model.id === current.id);

  const save = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/models/${id}`, { isDefault: true }),
    onSuccess: () => setSaved(true),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
      ]),
  });

  return (
    <div className="flex flex-col gap-3">
      {selectable.length === 0 ? (
        <p className="text-[var(--text-muted)] text-sm">
          Enable a model on an enabled provider to choose the default.
        </p>
      ) : (
        <Field
          label="Default model"
          htmlFor="default-model"
          hint="Used when someone starts a conversation without choosing a model."
        >
          <Select
            id="default-model"
            value={currentSelectable ? current.id : ''}
            disabled={save.isPending}
            placeholder="Select a model"
            onChange={(id) => {
              setSaved(false);
              save.mutate(id);
            }}
            options={selectable.map((model) => ({
              value: model.id,
              label: `${model.displayName} · ${model.providerLabel}`,
            }))}
            className="sm:max-w-96"
          />
        </Field>
      )}

      <div aria-live="polite">
        <MutationError error={save.error} message="The default model could not be saved." />
        {saved && !save.isPending && (
          <p className="flex items-center gap-1.5 text-[var(--success)] text-sm">
            <Check className="size-4" aria-hidden="true" />
            Default model saved.
          </p>
        )}
      </div>

      {check?.status === 'attention' && (
        <Notice tone="warning" title="The default model needs attention">
          {check.detail}
        </Notice>
      )}
    </div>
  );
}

const TABS: readonly PillTab<ModelsTab>[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'embeddings', label: 'Embeddings' },
];

export function AdminModelsPage() {
  const navigate = useNavigate();
  const tab = validateModelsSearch(useSearch({ strict: false })).tab ?? DEFAULT_MODELS_TAB;
  const setTab = (next: ModelsTab) =>
    void navigate({
      to: '/admin/models',
      search: { tab: next === DEFAULT_MODELS_TAB ? undefined : next },
      replace: true,
    });
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<AdminModel | null>(null);
  const [removeFor, setRemoveFor] = useState<AdminModel | null>(null);

  const models = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.get<{ models: AdminModel[] }>('/admin/models'),
  });
  const { data, isLoading } = models;
  const providers = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: () => api.get<{ providers: Provider[] }>('/admin/providers'),
  });

  async function removeModel(model: AdminModel) {
    await api.delete(`/admin/models/${model.id}`);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }),
      queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] }),
      queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
    ]);
  }

  function openCreate() {
    setEditingModel(null);
    setFormOpen(true);
  }

  return (
    <div>
      <AdminPageHeader
        title="Providers & Models"
        description="Connect upstream providers, choose which of their models join the catalog, and control who can use each one."
      />

      <div className="flex flex-col gap-8 pb-10">
        <PillTabs
          tabs={TABS}
          active={tab}
          onChange={setTab}
          label="Providers and models"
          controls="models-panel"
        />

        <div
          id="models-panel"
          role="tabpanel"
          aria-label={TABS.find((entry) => entry.id === tab)?.label ?? 'Providers'}
        >
          {tab === 'providers' ? (
            <ProvidersSection />
          ) : tab === 'embeddings' ? (
            <EmbeddingsSection />
          ) : (
            <section aria-labelledby="catalog-heading" className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2
                    id="catalog-heading"
                    className="text-base font-semibold text-[var(--text-primary)]"
                  >
                    Model catalog
                  </h2>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
                    Models people can choose from. Disable one to hide it without removing it.
                  </p>
                </div>
                <EditOnly>
                  <Button
                    variant="secondary"
                    disabled={!providers.data || providers.data.providers.length === 0}
                    onClick={openCreate}
                  >
                    <Plus />
                    Add model
                  </Button>
                </EditOnly>
              </div>

              {isLoading ? (
                <div className="py-8" role="status" aria-label="Loading the model catalog">
                  <Spinner className="mx-auto size-6" />
                </div>
              ) : models.isError || !data ? (
                <LoadError title="The model catalog could not be loaded." query={models} />
              ) : data.models.length > 0 ? (
                <>
                  <EditableFieldset>
                    <DefaultModelSelector
                      models={data.models}
                      providers={providers.data?.providers}
                    />
                  </EditableFieldset>
                  <RowList>
                    {data.models.map((model) => (
                      <ModelRow
                        key={model.id}
                        model={model}
                        onEdit={() => {
                          setEditingModel(model);
                          setFormOpen(true);
                        }}
                        onRemove={() => setRemoveFor(model)}
                      />
                    ))}
                  </RowList>
                </>
              ) : (
                <EmptyState icon={Cpu} title="The catalog is empty.">
                  Use <span className="font-medium">Discover models</span> on the{' '}
                  <Link
                    to="/admin/models"
                    search={{}}
                    className="text-[var(--accent-bright)] hover:underline"
                  >
                    Providers
                  </Link>{' '}
                  tab to choose which models to offer.
                </EmptyState>
              )}
            </section>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(removeFor)}
        onOpenChange={(open) => !open && setRemoveFor(null)}
        title={`Remove ${removeFor?.displayName ?? 'model'}?`}
        description="It will disappear from the catalog and users will no longer be able to select it. The provider and its key are not affected. This action cannot be undone."
        confirmLabel="Remove model"
        pendingLabel="Removing…"
        errorMessage="The model could not be removed."
        onConfirm={() => (removeFor ? removeModel(removeFor) : Promise.resolve())}
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        {formOpen && providers.data && (
          <ModelFormDialog
            model={editingModel}
            providers={providers.data.providers}
            onClose={() => setFormOpen(false)}
          />
        )}
      </Dialog>
    </div>
  );
}
