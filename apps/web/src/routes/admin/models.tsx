import {
  type AdminModel,
  COST_TIERS,
  type CostTier,
  MODEL_CAPABILITIES,
  type ModelCapability,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
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

function ModelRow({ model }: { model: AdminModel }) {
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
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-3 p-4">
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
        </div>

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
                  onChange={(event) => update.mutate({ costTier: event.target.value })}
                >
                  {COST_TIERS.map((tier) => (
                    <option key={tier} value={tier}>
                      {tier}
                    </option>
                  ))}
                </Select>
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
      </CardContent>
    </Card>
  );
}

export function AdminModelsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.get<{ models: AdminModel[] }>('/admin/models'),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold">Model catalog</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Only models listed here are available to users. Add them from a provider on the Providers
        page.
      </p>

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : data && data.models.length > 0 ? (
        <div className="mt-8 flex flex-col gap-2">
          {data.models.map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
        </div>
      ) : (
        <Card className="mt-8">
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <Cpu className="size-8 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-secondary)]">The catalog is empty.</p>
            <p className="max-w-md text-xs text-[var(--text-muted)]">
              Add a provider, then use “Discover models” to choose which ones to expose.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
