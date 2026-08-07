import type { CatalogModel, CostTier, ModelCapability } from '@oci/shared';
import { Brain, ChevronDown, Eye, FileText, Image, Wrench, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { cn } from '~/lib/utils';

const COST_LABELS: Record<CostTier, string> = {
  free: 'Free',
  low: '$',
  medium: '$$',
  high: '$$$',
  premium: '$$$$',
};

const CAPABILITY_ICONS: Partial<Record<ModelCapability, typeof Eye>> = {
  vision: Eye,
  reasoning: Brain,
  tool_calling: Wrench,
  fast: Zap,
  pdf_comprehension: FileText,
  image_generation: Image,
};

export function ModelPicker({
  models,
  selected,
  onSelect,
}: {
  models: CatalogModel[];
  selected: CatalogModel | null;
  onSelect: (model: CatalogModel) => void;
}) {
  if (models.length === 0) {
    return (
      <span className="px-2 text-[0.8125rem] text-[var(--text-muted)]">No models available</span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[0.8125rem] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-control-hover)]">
        {selected?.displayName ?? 'Select model'}
        {selected && (
          <span className="text-[0.6875rem] font-bold text-[var(--success)]">
            {COST_LABELS[selected.costTier]}
          </span>
        )}
        <ChevronDown className="size-4 text-[var(--text-muted)]" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="max-h-96 w-80 overflow-y-auto">
        {models.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onSelect={() => onSelect(model)}
            className={cn(
              'flex-col items-start gap-1 py-2',
              selected?.id === model.id && 'bg-[var(--accent-soft)]',
            )}
          >
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
                {model.displayName}
              </span>
              <span className="text-[0.6875rem] font-bold text-[var(--success)]">
                {COST_LABELS[model.costTier]}
              </span>
            </span>

            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-[var(--text-muted)]">
                {model.providerLabel}
              </span>
              <span className="flex items-center gap-1">
                {model.capabilities.map((capability) => {
                  const Icon = CAPABILITY_ICONS[capability];
                  return Icon ? (
                    <Icon key={capability} className="size-3 text-[var(--text-muted)]" />
                  ) : null;
                })}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
