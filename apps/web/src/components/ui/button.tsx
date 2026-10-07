import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentProps, useId } from 'react';
import { toast } from 'sonner';
import { cn } from '~/lib/utils';
import { FILLED_FOCUS_RING, FOCUS_RING } from './focus-ring';
import { useHoldFocus } from './hold-focus';

const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 ${FOCUS_RING}`,
  {
    variants: {
      variant: {
        /** Deep plum call to action, matching the New Chat button. */
        primary: `bg-[var(--accent-button)] text-[var(--accent-button-foreground)] border border-[var(--accent-button-border)]/60 hover:bg-[var(--accent-button-hover)] ${FILLED_FOCUS_RING}`,
        /** Saturated magenta used for selected/active states. */
        accent: `bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-bright)] ${FILLED_FOCUS_RING}`,
        secondary: `bg-[var(--bg-control)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)] ${FILLED_FOCUS_RING}`,
        ghost:
          'text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
        outline:
          'border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
        danger: `bg-[var(--danger-solid)] text-[var(--danger-foreground)] hover:opacity-90 ${FILLED_FOCUS_RING}`,
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
  /**
   * Why this change is off right now: the read-only message from
   * `useReadOnlyLock().title`, undefined when it is on (#357).
   *
   * A natively disabled button is skipped by Tab and never read out, and a
   * `title` shows on hover only, so a keyboard, screen-reader or touch user
   * never met the reason. A locked button is marked aria-disabled instead, so
   * it can be focused; the reason is its description (and its title, for the
   * pointer); and pressing it, with Enter, Space or a tap, announces the
   * reason in a toast rather than doing nothing. It still cannot be activated.
   */
  locked?: string;
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
 * without focus, it is natively disabled as before. Switches, selects and
 * fields do the same through `useHoldFocus` (#292).
 *
 * A `locked` button stays aria-disabled the whole time instead (#357).
 */
export function Button({
  className,
  variant,
  size,
  asChild,
  disabled,
  locked,
  onClick,
  onPointerDown,
  onKeyDown,
  onFocus,
  onBlur,
  ...props
}: ButtonProps) {
  const { hold, track } = useHoldFocus(disabled);
  const reasonId = useId();
  const reason = asChild ? undefined : locked;
  const holdFocus = !asChild && hold;
  // Held or locked: focusable, but it ignores every press.
  const inert = holdFocus || Boolean(reason);
  const Comp = asChild ? Slot : 'button';
  const button = (
    <Comp
      className={cn(
        buttonVariants({ variant, size }),
        holdFocus && !reason && 'pointer-events-none opacity-50',
        // The pointer still reaches a locked button: hover shows the title
        // and a tap announces the reason.
        reason && 'cursor-not-allowed opacity-50',
        className,
      )}
      {...props}
      title={reason ?? props.title}
      disabled={inert ? undefined : disabled}
      aria-disabled={inert ? true : props['aria-disabled']}
      aria-describedby={
        reason
          ? [props['aria-describedby'], reasonId].filter(Boolean).join(' ')
          : props['aria-describedby']
      }
      {...track(onFocus, onBlur)}
      onClick={(event) => {
        // Also stops a submit button submitting its form again.
        if (inert) {
          event.preventDefault();
          // One toast however often it is pressed; the live region announces it.
          if (reason) toast(reason, { id: 'locked-control' });
          return;
        }
        onClick?.(event);
      }}
      onPointerDown={(event) => {
        if (!inert) onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (!inert) onKeyDown?.(event);
      }}
    />
  );
  if (!reason) return button;
  return (
    <>
      {button}
      <span id={reasonId} hidden>
        {reason}
      </span>
    </>
  );
}

export { buttonVariants };
