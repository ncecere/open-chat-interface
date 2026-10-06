import type {
  AriaAttributes,
  ComponentProps,
  FocusEventHandler,
  KeyboardEvent,
  KeyboardEventHandler,
} from 'react';
import { cn } from '~/lib/utils';
import { HELD_CLASS, useHoldFocus } from './hold-focus';

/** Types `readOnly` applies to; a checkbox or file input is disabled as before. */
const READ_ONLY_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/**
 * Forms disable their fields while they save, so pressing Enter in one
 * submitted the form and then sent focus to the body (#292). While a field is
 * disabled and has focus it stays focused, read-only and aria-disabled, and
 * ignores its own key handlers and Enter (which would submit the form again),
 * as the shared Button does (#269).
 */
function useHeldField<E extends HTMLInputElement | HTMLTextAreaElement>(props: {
  disabled?: boolean;
  readOnly?: boolean;
  type?: string;
  'aria-disabled'?: AriaAttributes['aria-disabled'];
  onKeyDown?: KeyboardEventHandler<E>;
  onFocus?: FocusEventHandler<E>;
  onBlur?: FocusEventHandler<E>;
}) {
  const { hold: focusedWhileDisabled, track } = useHoldFocus(props.disabled);
  const hold = focusedWhileDisabled && READ_ONLY_TYPES.has(props.type ?? 'text');
  return {
    hold,
    disabled: hold ? false : props.disabled,
    readOnly: hold || props.readOnly,
    'aria-disabled': hold ? true : props['aria-disabled'],
    ...track<E>(props.onFocus, props.onBlur),
    onKeyDown: (event: KeyboardEvent<E>) => {
      if (!hold) return props.onKeyDown?.(event);
      if (event.key === 'Enter') event.preventDefault();
    },
  };
}

const FIELD_CLASS = 'disabled:cursor-not-allowed disabled:opacity-50';

export function Input({
  className,
  disabled,
  readOnly,
  onKeyDown,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<'input'>) {
  const { hold, ...held } = useHeldField<HTMLInputElement>({
    disabled,
    readOnly,
    onKeyDown,
    onFocus,
    onBlur,
    type: props.type,
    'aria-disabled': props['aria-disabled'],
  });
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm',
        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
        'transition-colors focus:border-[var(--border-strong)]',
        FIELD_CLASS,
        hold && HELD_CLASS,
        className,
      )}
      {...props}
      {...held}
    />
  );
}

export function Textarea({
  className,
  disabled,
  readOnly,
  onKeyDown,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<'textarea'>) {
  const { hold, ...held } = useHeldField<HTMLTextAreaElement>({
    disabled,
    readOnly,
    onKeyDown,
    onFocus,
    onBlur,
    'aria-disabled': props['aria-disabled'],
  });
  return (
    <textarea
      className={cn(
        'w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 py-2 text-sm',
        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
        'transition-colors focus:border-[var(--border-strong)]',
        FIELD_CLASS,
        hold && HELD_CLASS,
        className,
      )}
      {...props}
      {...held}
    />
  );
}
