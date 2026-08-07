import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm',
        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
        'transition-colors focus:border-[var(--border-strong)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 py-2 text-sm',
        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
        'transition-colors focus:border-[var(--border-strong)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
