import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '~/lib/utils';
import { HELD_CLASS, useHoldFocus } from './hold-focus';

/**
 * A switch that saves on toggle disables itself while it saves, which sent
 * focus to the body and kept a screen reader from hearing the new state
 * (#292). While it is disabled and has focus it stays focused, aria-disabled,
 * and ignores presses (Space and Enter fire click; preventing it stops Radix
 * toggling), as the shared Button does (#269).
 */
export function Switch({
  className,
  disabled,
  onClick,
  onKeyDown,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  const { hold, track } = useHoldFocus(disabled);
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'data-[state=checked]:bg-[var(--accent)] data-[state=unchecked]:bg-[var(--bg-control-hover)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        hold && HELD_CLASS,
        className,
      )}
      {...props}
      disabled={hold ? false : disabled}
      aria-disabled={hold ? true : props['aria-disabled']}
      {...track(onFocus, onBlur)}
      onClick={(event) => {
        if (hold) return event.preventDefault();
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        if (!hold) onKeyDown?.(event);
      }}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform',
          'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
