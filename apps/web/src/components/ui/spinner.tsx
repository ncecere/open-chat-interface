import { Loader2 } from 'lucide-react';
import { useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-[var(--text-muted)]', className)} />;
}

export function FullPageSpinner() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t('ui.spinner.loadingPage')}
      className="flex h-full w-full items-center justify-center"
    >
      <Spinner className="size-6" />
    </div>
  );
}
