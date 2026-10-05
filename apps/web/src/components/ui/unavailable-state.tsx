import type { ReactNode } from 'react';

/**
 * A page that cannot show what was asked for: a conversation or project that
 * is gone, or a feature this account does not have. One layout for all of
 * them (#113), centred, with its reason and a way on; they were four.
 */
export function UnavailableState({
  title,
  children,
  actions,
  alert = false,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Announced at once: a load that failed, rather than a page that is simply not here. */
  alert?: boolean;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <section role={alert ? 'alert' : undefined} className="max-w-md space-y-4 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-[var(--text-muted)]">{children}</p>
        <div className="flex items-center justify-center gap-4">{actions}</div>
      </section>
    </div>
  );
}
