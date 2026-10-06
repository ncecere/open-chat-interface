import type { ReactNode } from 'react';
import { cn } from '~/lib/utils';

/**
 * A page that cannot show what was asked for: a conversation, project or
 * share link that is gone, an address with no page, or a feature this account
 * does not have. One layout for all of them (#113, #131), centred, with its
 * reason and a way on.
 */
export function UnavailableState({
  title,
  children,
  actions,
  alert = false,
  className,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Announced at once: a load that failed, rather than a page that is simply not here. */
  alert?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full items-center justify-center p-6', className)}>
      <section role={alert ? 'alert' : undefined} className="max-w-md space-y-4 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-[var(--text-muted)]">{children}</p>
        <div className="flex items-center justify-center gap-4">{actions}</div>
      </section>
    </div>
  );
}
