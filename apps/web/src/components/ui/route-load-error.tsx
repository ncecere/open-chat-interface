import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Button } from '~/components/ui/button';

/** How often the page tries again by itself, and for how long. */
export const ROUTE_RETRY_MS = 5_000;
const ROUTE_RETRY_ATTEMPTS = 24;

// Do not display exception details (including failed session responses) to users.
// A document reload also obtains a fresh asset manifest after a deployment.
export function RouteLoadError() {
  const router = useRouter();
  // A few seconds of database or network trouble should not need a reload:
  // load the page again every few seconds for two minutes, and it replaces
  // this as soon as it loads (#164).
  useEffect(() => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts >= ROUTE_RETRY_ATTEMPTS) clearInterval(timer);
      void router.invalidate();
    }, ROUTE_RETRY_MS);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <main role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-lg font-semibold">Could not load this page</h1>
      <p className="text-sm text-[var(--text-muted)]">
        Trying again by itself. If it does not load, reload the page.
      </p>
      <Button onClick={() => window.location.reload()}>Reload page</Button>
      <a href="/" className="text-sm underline">
        Back to chat
      </a>
    </main>
  );
}
