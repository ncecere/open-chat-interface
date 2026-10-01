import {
  type AdminModel,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type Provider,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  MutationError,
  Row,
  RowList,
} from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { ModelFormDialog } from '~/components/admin/model-form-dialog';
import { LabLogo } from '~/components/model/lab-logo';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

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
          disabled={update.isPending}
          onCheckedChange={(enabled) => update.mutate({ enabled })}
          aria-label={`Enable ${model.displayName}`}
        />

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <LabLogo labId={model.labId} className="size-4" />
            <span className="truncate font-medium">{model.displayName}</span>
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
      </Row>

      <MutationError
        error={update.error}
        message={`Changes to ${model.displayName} could not be saved.`}
        className="px-4 pb-3"
      />

      {expanded && (
        <div className="flex flex-col gap-4 border-t border-[var(--border-subtle)] p-4">
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
        </div>
      )}
    </div>
  );
}

export function AdminModelsPage() {
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
    ]);
  }

  function openCreate() {
    setEditingModel(null);
    setFormOpen(true);
  }

  return (
    <div>
      <AdminPageHeader
        title="Model catalog"
        description="Add upstream models from configured providers, then control how users can access them."
        actions={
          <Button
            variant="primary"
            disabled={!providers.data || providers.data.providers.length === 0}
            onClick={openCreate}
          >
            <Plus />
            Add model
          </Button>
        }
      />

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : models.isError || !data ? (
        <LoadError title="The model catalog could not be loaded." query={models} />
      ) : data.models.length > 0 ? (
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
      ) : (
        <EmptyState icon={Cpu} title="The catalog is empty.">
          Add a provider, then use “Discover models” to choose which ones to expose.
        </EmptyState>
      )}

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
