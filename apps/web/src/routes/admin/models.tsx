import {
  type AdminModel,
  COST_TIERS,
  type CostTier,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type Provider,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader, EmptyState, Row, RowList } from '~/components/admin/admin-ui';
import { ModelFormDialog } from '~/components/admin/model-form-dialog';
import { LabLogo } from '~/components/model/lab-logo';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
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

const COST_LABELS: Record<CostTier, string> = {
  free: 'Free',
  low: '$',
  medium: '$$',
  high: '$$$',
  premium: '$$$$',
};

function ModelRow({ model, onEdit }: { model: AdminModel; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] });
  };

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/admin/models/${model.id}`, patch),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/models/${model.id}`),
    onSuccess: invalidate,
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
            <span className="text-xs font-semibold text-[var(--success)]">
              {COST_LABELS[model.costTier]}
            </span>
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
          aria-label={model.isDefault ? 'Default model' : 'Make default'}
          onClick={() => update.mutate({ isDefault: true })}
        >
          <Star className={cn(model.isDefault && 'fill-[var(--accent)] text-[var(--accent)]')} />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${model.displayName}`}
          onClick={() => remove.mutate()}
        >
          <Trash2 />
        </Button>
      </Row>

      {expanded && (
        <div className="flex flex-col gap-4 border-t border-[var(--border-subtle)] p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" htmlFor={`name-${model.id}`}>
              <Input
                id={`name-${model.id}`}
                defaultValue={model.displayName}
                onBlur={(event) => {
                  const displayName = event.target.value.trim();
                  if (displayName && displayName !== model.displayName) {
                    update.mutate({ displayName });
                  }
                }}
              />
            </Field>

            <Field label="Cost tier" htmlFor={`cost-${model.id}`}>
              <Select
                id={`cost-${model.id}`}
                value={model.costTier}
                onChange={(costTier) => update.mutate({ costTier })}
                options={COST_TIERS.map((tier) => ({ value: tier, label: tier }))}
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
  const [formOpen, setFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<AdminModel | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.get<{ models: AdminModel[] }>('/admin/models'),
  });
  const providers = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: () => api.get<{ providers: Provider[] }>('/admin/providers'),
  });

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
      ) : data && data.models.length > 0 ? (
        <RowList>
          {data.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              onEdit={() => {
                setEditingModel(model);
                setFormOpen(true);
              }}
            />
          ))}
        </RowList>
      ) : (
        <EmptyState icon={Cpu} title="The catalog is empty.">
          Add a provider, then use “Discover models” to choose which ones to expose.
        </EmptyState>
      )}

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
