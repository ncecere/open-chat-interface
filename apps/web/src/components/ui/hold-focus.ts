import { type FocusEvent, useState } from 'react';

/**
 * Browsers blur a focused control the moment it becomes disabled (the focus
 * fixup rule), and most controls here disable themselves while their request
 * runs (`disabled={mutation.isPending}`): a button pressed, a switch that saves
 * on toggle, a select that saves on change, a field whose Enter submits the
 * form. A keyboard user was sent back to the body, and a screen reader never
 * announced the switch's new state (#269, #292).
 *
 * So a control that is disabled while it has focus keeps it: it is marked
 * aria-disabled instead and ignores activation (each control blocks its own
 * presses while `hold` is set), so it still cannot be pressed twice. Once focus
 * leaves, or the control is disabled without focus, it is natively disabled as
 * before.
 *
 * `track` wraps the control's own onFocus/onBlur; `owns`, when given, says a
 * blur to that element keeps the hold (a select's popup, which focus moves into
 * and returns from).
 */
export function useHoldFocus(disabled: boolean | undefined) {
  const [focused, setFocused] = useState(false);
  const hold = Boolean(disabled) && focused;
  function track<E extends Element>(
    onFocus?: (event: FocusEvent<E>) => void,
    onBlur?: (event: FocusEvent<E>) => void,
    owns?: (target: Element) => boolean,
  ) {
    return {
      onFocus: (event: FocusEvent<E>) => {
        if (event.target === event.currentTarget) setFocused(true);
        onFocus?.(event);
      },
      onBlur: (event: FocusEvent<E>) => {
        const next = event.relatedTarget;
        const kept = next instanceof Element && owns?.(next);
        if (event.target === event.currentTarget && !kept) setFocused(false);
        onBlur?.(event);
      },
    };
  }
  return { hold, track, setFocused };
}

/** How a held control looks: as though disabled. */
export const HELD_CLASS = 'cursor-not-allowed opacity-50';
