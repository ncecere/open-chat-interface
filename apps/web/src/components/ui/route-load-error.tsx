import { useRouter } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { AUTO_RETRY_MS, useAutoRetry } from '~/hooks/use-auto-retry';
import { useT } from '~/lib/i18n';

/** How often the page tries again by itself (for two minutes). */
export const ROUTE_RETRY_MS = AUTO_RETRY_MS;

// Do not display exception details (including failed session responses) to users.
// A document reload also obtains a fresh asset manifest after a deployment.
export function RouteLoadError() {
  const t = useT();
  const router = useRouter();
  // A few seconds of database or network trouble should not need a reload:
  // load the page again every few seconds for two minutes, and it replaces
  // this as soon as it loads (#164).
  useAutoRetry(true, () => void router.invalidate());
  return (
    <main role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-lg font-semibold">{t('ui.routeError.title')}</h1>
      <p className="text-sm text-[var(--text-muted)]">{t('ui.routeError.hint')}</p>
      <Button onClick={() => window.location.reload()}>{t('ui.routeError.reload')}</Button>
      <a href="/" className="text-sm underline">
        {t('ui.routeError.back')}
      </a>
    </main>
  );
}
