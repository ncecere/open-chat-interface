import { Check, Copy, GitFork, Globe2, Pencil, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { useModels } from '~/hooks/use-models';

function ModelAttribution({ slug, effort }: { slug: string | null; effort: string | null }) {
  const { data: models } = useModels();
  if (!slug) return null;
  const model = models?.find((entry) => entry.slug === slug);

  return (
    <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-[var(--text-muted)]">
      <span className="max-w-52 truncate">{model?.displayName ?? slug}</span>
      {effort && <span className="capitalize">({effort})</span>}
    </span>
  );
}

export function MessageActions({
  text,
  onRetry,
  onEdit,
  onFork,
  modelSlug,
  effort,
  searched,
}: {
  text: string;
  onRetry?: () => void;
  onEdit?: () => void;
  onFork?: () => Promise<void>;
  modelSlug?: string | null;
  effort?: string | null;
  searched?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-2 flex min-h-8 flex-wrap items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy message"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
      </Button>
      {onFork && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Fork conversation here"
          onClick={() => void onFork()}
        >
          <GitFork />
        </Button>
      )}
      {onEdit && (
        <Button variant="ghost" size="icon-sm" aria-label="Edit message" onClick={onEdit}>
          <Pencil />
        </Button>
      )}
      {onRetry && (
        <Button variant="ghost" size="icon-sm" aria-label="Retry" onClick={onRetry}>
          <RefreshCw />
        </Button>
      )}
      {modelSlug && <ModelAttribution slug={modelSlug} effort={effort ?? null} />}
      {searched && (
        <Globe2 className="ml-0.5 size-3.5 text-[var(--text-muted)]" aria-label="Web search used" />
      )}
    </div>
  );
}
