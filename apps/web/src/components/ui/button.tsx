import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentProps, useState } from 'react';
import { cn } from '~/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        /** Deep plum call to action, matching the New Chat button. */
        primary:
          'bg-[var(--accent-button)] text-[var(--accent-button-foreground)] border border-[var(--accent-button-border)]/60 hover:bg-[var(--accent-button-hover)]',
        /** Saturated magenta used for selected/active states. */
        accent:
          'bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-bright)]',
        secondary:
          'bg-[var(--bg-control)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
        ghost:
          'text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
        outline:
          'border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
        danger: 'bg-[var(--danger-solid)] text-[var(--danger-foreground)] hover:opacity-90',
        link: 'text-[var(--accent-bright)] underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4',
        lg: 'h-10 px-5',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * A focused button that becomes disabled loses focus to the body in browsers
 * (the focus fixup rule), and most buttons here disable themselves while their
 * request runs (`disabled={mutation.isPending}`), so a keyboard user pressing
 * Test search or Discover models was sent back to the skip link (#269).
 *
 * So a button that is disabled while it has focus keeps it: it is marked
 * aria-disabled instead, looks the same, and ignores activation (click, which
 * Enter and Space fire, and the pointer and key presses menus open on), so it
 * still cannot be pressed twice. Once focus leaves, or the button is disabled
 * without focus, it is natively disabled as before.
 */
export function Button({
  className,
  variant,
  size,
  asChild,
  disabled,
  onClick,
  onPointerDown,
  onKeyDown,
  onFocus,
  onBlur,
  ...props
}: ButtonProps) {
  const [focused, setFocused] = useState(false);
  const holdFocus = !asChild && Boolean(disabled) && focused;
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(
        buttonVariants({ variant, size }),
        holdFocus && 'pointer-events-none opacity-50',
        className,
      )}
      {...props}
      disabled={holdFocus ? undefined : disabled}
      aria-disabled={holdFocus ? true : props['aria-disabled']}
      onFocus={(event) => {
        if (event.target === event.currentTarget) setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        if (event.target === event.currentTarget) setFocused(false);
        onBlur?.(event);
      }}
      onClick={(event) => {
        // Also stops a submit button submitting its form again.
        if (holdFocus) return event.preventDefault();
        onClick?.(event);
      }}
      onPointerDown={(event) => {
        if (!holdFocus) onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (!holdFocus) onKeyDown?.(event);
      }}
    />
  );
}

export { buttonVariants };
