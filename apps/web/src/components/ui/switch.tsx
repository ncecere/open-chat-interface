import * as SwitchPrimitive from '@radix-ui/react-switch';
import { type ComponentProps, useId } from 'react';
import { toast } from 'sonner';
import { cn } from '~/lib/utils';
import { useFieldDescribedBy } from './field-hint';
import { HELD_CLASS, useHoldFocus } from './hold-focus';

/**
 * A switch that saves on toggle disables itself while it saves, which sent
 * focus to the body and kept a screen reader from hearing the new state
 * (#292). While it is disabled and has focus it stays focused, aria-disabled,
 * and ignores presses (Space and Enter fire click; preventing it stops Radix
 * toggling), as the shared Button does (#269).
 *
 * `locked` is the Button's: why the setting cannot be changed right now
 * (read-only mode). It stays focusable, described by the reason, and a press
 * announces the reason instead of toggling (#357).
 */
export function Switch({
  className,
  disabled,
  locked,
  onClick,
  onKeyDown,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root> & { locked?: string }) {
  const { hold: held, track } = useHoldFocus(disabled);
  const reasonId = useId();
  const hold = held || Boolean(locked);
  // Described by the hint of the Field it is in, too (#295).
  const fieldDescribedBy = useFieldDescribedBy(props['aria-describedby']);
  const describedBy = locked
    ? [fieldDescribedBy, reasonId].filter(Boolean).join(' ')
    : fieldDescribedBy;
  const control = (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'data-[state=checked]:bg-[var(--accent)] data-[state=unchecked]:bg-[var(--bg-control-hover)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        hold && HELD_CLASS,
        className,
      )}
      {...props}
      title={locked ?? props.title}
      disabled={hold ? false : disabled}
      aria-disabled={hold ? true : props['aria-disabled']}
      aria-describedby={describedBy}
      {...track(onFocus, onBlur)}
      onClick={(event) => {
        if (hold) {
          event.preventDefault();
          if (locked) toast(locked, { id: 'locked-control' });
          return;
        }
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
  if (!locked) return control;
  return (
    <>
      {control}
      <span id={reasonId} hidden>
        {locked}
      </span>
    </>
  );
}
