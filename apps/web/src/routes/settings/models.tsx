import type { CatalogModel, ModelCapability } from '@oci/shared';
import { Brain, Eye, FileText, Image, Wrench, Zap } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { useModels } from '~/hooks/use-models';

const CAPABILITY_META: Partial<Record<ModelCapability, { label: string; icon: typeof Eye }>> = {
  vision: { label: 'Vision', icon: Eye },
  reasoning: { label: 'Reasoning', icon: Brain },
  tool_calling: { label: 'Tools', icon: Wrench },
  fast: { label: 'Fast', icon: Zap },
  pdf_comprehension: { label: 'PDF', icon: FileText },
  image_generation: { label: 'Images', icon: Image },
};

const COST_LABELS: Record<CatalogModel['costTier'], string> = {
  free: 'Free',
  low: '$',
  medium: '$$',
  high: '$$$',
  premium: '$$$$',
};

export function SettingsModelsPage() {
  const { data: models, isLoading } = useModels();
  const [filter, setFilter] = useState('');

  const term = filter.trim().toLowerCase();
  const visible = (models ?? []).filter(
    (model) =>
      !term ||
      model.displayName.toLowerCase().includes(term) ||
      model.providerLabel.toLowerCase().includes(term),
  );

  return (
    <div>
      <h1 className="text-2xl font-bold">Available Models</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Models an administrator has made available to your role.
      </p>

      <div className="mt-6 max-w-sm">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search models..."
        />
      </div>

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : visible.length === 0 ? (
        <p className="mt-10 text-sm text-[var(--text-muted)]">
          {models?.length === 0
            ? 'No models are available to you yet. Ask an administrator to enable one.'
            : 'No models matched your search.'}
        </p>
      ) : (
        <div className="mt-6 flex flex-col">
          {visible.map((model) => (
            <div
              key={model.id}
              className="flex items-start gap-4 border-b border-[var(--border-subtle)] py-4 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-[var(--text-primary)]">{model.displayName}</p>
                  <span className="text-xs font-bold text-[var(--success)]">
                    {COST_LABELS[model.costTier]}
                  </span>
                  {model.isDefault && <Badge variant="accent">default</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {model.providerLabel}
                  {model.contextWindow
                    ? ` · ${(model.contextWindow / 1000).toFixed(0)}k context`
                    : ''}
                </p>
                {model.description && (
                  <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{model.description}</p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                {model.capabilities.map((capability) => {
                  const meta = CAPABILITY_META[capability];
                  if (!meta) return null;
                  return (
                    <span
                      key={capability}
                      className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[0.6875rem] text-[var(--text-secondary)]"
                    >
                      <meta.icon className="size-3" />
                      {meta.label}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
