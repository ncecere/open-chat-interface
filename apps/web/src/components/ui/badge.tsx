import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold',
  {
    variants: {
      variant: {
        accent: 'bg-[var(--accent)] text-[var(--accent-foreground)]',
        soft: 'bg-[var(--accent-soft)] text-[var(--text-primary)]',
        neutral: 'bg-[var(--bg-control)] text-[var(--text-secondary)]',
        outline: 'border border-[var(--border-strong)] text-[var(--text-secondary)]',
        success: 'bg-[var(--success)]/15 text-[var(--success)]',
        warning: 'bg-[var(--warning)]/15 text-[var(--warning)]',
        danger: 'bg-[var(--danger)]/20 text-[var(--danger-on-tint)]',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
