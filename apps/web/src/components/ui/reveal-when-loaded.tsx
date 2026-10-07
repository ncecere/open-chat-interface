import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Spinner } from '~/components/ui/spinner';
import { cn } from '~/lib/utils';

/** However slow a request, the page is shown after this long. */
const MAX_WAIT_MS = 3_000;

/**
 * Whether the first loads of a page have settled: no query is waiting for its
 * first data. Pages lay themselves out hidden until then, so sections filling
 * in one by one do not push each other (and the cards beside them) around in
 * view: System health, Roles & access and the settings pages scored 0.3-0.8
 * on cumulative layout shift (#104). Content laid out but invisible does not
 * count as moving. A new `resetKey` (the next page) starts over; otherwise,
 * once settled it stays settled, so refetches change nothing. Never longer
 * than three seconds.
 */
export function useFirstLoadSettled(resetKey: string): boolean {
  const queryClient = useQueryClient();
  const [settled, setSettled] = useState<{ key: string; ready: boolean }>({
    key: resetKey,
    ready: false,
  });
  const ready = settled.key === resetKey && settled.ready;

  useEffect(() => {
    if (ready) return;
    const cache = queryClient.getQueryCache();
    const loading = () =>
      cache
        .getAll()
        .some(
          (query) => query.state.status === 'pending' && query.state.fetchStatus === 'fetching',
        );
    const done = () => setSettled({ key: resetKey, ready: true });
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      // A frame later, so queries started by what just rendered are counted.
      frame = requestAnimationFrame(() => {
        if (!loading()) done();
      });
    };
    const unsubscribe = cache.subscribe(check);
    const timer = setTimeout(done, MAX_WAIT_MS);
    check();
    return () => {
      unsubscribe();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [queryClient, ready, resetKey]);

  return ready;
}

/** The spinner shown over a page laid out hidden while it loads. */
export function LoadingOverlay({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="absolute inset-x-0 top-16 z-10">
      <Spinner className="mx-auto size-6" />
    </div>
  );
}

/** A page shown only once its first loads have settled; see useFirstLoadSettled. */
export function RevealWhenLoaded({
  resetKey,
  children,
  className,
}: {
  resetKey: string;
  children: ReactNode;
  className?: string;
}) {
  const ready = useFirstLoadSettled(resetKey);
  return (
    <div className={cn('relative', className)} aria-busy={!ready}>
      {!ready && <LoadingOverlay />}
      <div className={ready ? undefined : 'invisible'}>{children}</div>
    </div>
  );
}
