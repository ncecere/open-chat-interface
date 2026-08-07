import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm',
        'text-[var(--text-primary)] transition-colors',
        'focus:border-[var(--border-strong)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
