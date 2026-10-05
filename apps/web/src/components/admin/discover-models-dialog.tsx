import {
  DEFAULT_MODEL_ROLES,
  type DiscoveredModel,
  type ModelCapability,
  type Provider,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

/** Best-effort capability guesses from the upstream model ID. */
function inferCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();
  const capabilities: ModelCapability[] = [];

  if (/gpt-4|gpt-5|claude|gemini|llava|vision|vl\b/.test(id)) capabilities.push('vision');
  if (/o[134]|reason|think|sonnet|opus|gemini-[23]/.test(id)) capabilities.push('reasoning');
  if (!/embed|whisper|tts|moderation|dall-e|image/.test(id)) capabilities.push('tool_calling');
  if (/mini|flash|haiku|small|turbo|8b|7b/.test(id)) capabilities.push('fast');
  if (/claude|gpt-4|gpt-5|gemini/.test(id)) capabilities.push('pdf_comprehension');

  return capabilities;
}

function toSlug(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

/** Models that are not chat completions and should not enter the catalog. */
function isChatModel(modelId: string): boolean {
  return !/embed|whisper|tts|moderation|dall-e|rerank|audio|image|search|guard/i.test(modelId);
}

export function DiscoverModelsDialog({
  provider,
  models,
  onClose,
}: {
  provider: Provider;
  models: DiscoveredModel[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return models
      .filter((model) => isChatModel(model.upstreamModelId))
      .filter((model) => !term || model.upstreamModelId.toLowerCase().includes(term))
      .sort((a, b) => a.upstreamModelId.localeCompare(b.upstreamModelId));
  }, [models, filter]);

  const addModels = useMutation({
    mutationFn: async (ids: string[]) => {
      // The API creates one model at a time so each gets its own audit entry.
      for (const [index, upstreamModelId] of ids.entries()) {
        await api.post('/admin/models', {
          providerId: provider.id,
          upstreamModelId,
          slug: toSlug(upstreamModelId),
          displayName: upstreamModelId,
          capabilities: inferCapabilities(upstreamModelId),
          supportedEfforts: [],
          enabled: true,
          visibleToRoles: [...DEFAULT_MODEL_ROLES],
          sortOrder: index,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] });
      queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] });
      queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY });
      onClose();
    },
  });

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Models available from {provider.label}</DialogTitle>
        <DialogDescription>
          Select which models to expose. Nothing is available to users until it is added here.
        </DialogDescription>
      </DialogHeader>

      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter models..."
      />

      <div className="scrollbar-thin mt-3 max-h-80 overflow-y-auto rounded-lg border border-[var(--border-subtle)]">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-[var(--text-muted)]">No models matched.</p>
        ) : (
          visible.map((model) => {
            const isSelected = selected.has(model.upstreamModelId);
            return (
              <button
                key={model.upstreamModelId}
                type="button"
                disabled={model.alreadyInCatalog}
                onClick={() => toggle(model.upstreamModelId)}
                className={cn(
                  'flex w-full items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5 text-left last:border-0',
                  'transition-colors disabled:opacity-45',
                  isSelected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control-hover)]',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded border',
                    isSelected
                      ? 'border-[var(--accent)] bg-[var(--accent)]'
                      : 'border-[var(--border-strong)]',
                  )}
                >
                  {isSelected && <Check className="size-3 text-white" />}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm">{model.upstreamModelId}</span>

                {model.alreadyInCatalog && <Badge variant="success">in catalog</Badge>}
              </button>
            );
          })
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={selected.size === 0 || addModels.isPending}
          onClick={() => addModels.mutate([...selected])}
        >
          {addModels.isPending && <Spinner />}
          Add {selected.size > 0 ? selected.size : ''} to catalog
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
