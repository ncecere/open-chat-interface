import { AlertTriangle } from 'lucide-react';
import { useId } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { apiErrorMessage } from '~/lib/api-client';
import { useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

/**
 * Shown in place of a settings page's content whose query failed, so the page
 * never spins forever. Retrying refetches the same query. (The administration
 * console has its own, in English.) The API's own message is shown as it is.
 */
export function LoadError({
  title,
  query,
  className,
}: {
  title: string;
  query: { error: unknown; isFetching: boolean; refetch: () => unknown };
  className?: string;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center',
        className,
      )}
    >
      <AlertTriangle className="size-8 text-[var(--danger)]" aria-hidden="true" />
      <p id={titleId} role="alert" className="text-sm font-medium text-[var(--text-primary)]">
        {title}
      </p>
      <p className="max-w-md text-xs text-[var(--text-muted)]">
        {apiErrorMessage(query.error, t('settings.loadError.fallback'))}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={query.isFetching}
        aria-describedby={titleId}
        onClick={() => void query.refetch()}
      >
        {query.isFetching && <Spinner />}
        {t('settings.loadError.retry')}
      </Button>
    </div>
  );
}
