import { Button } from '~/components/ui/button';

// Do not display exception details (including failed session responses) to users.
// A document reload also obtains a fresh asset manifest after a deployment.
export function RouteLoadError() {
  return (
    <main role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-lg font-semibold">Could not load this page</h1>
      <p className="text-sm text-[var(--text-muted)]">Reload the page and try again.</p>
      <Button onClick={() => window.location.reload()}>Reload page</Button>
      <a href="/" className="text-sm underline">
        Back to chat
      </a>
    </main>
  );
}
