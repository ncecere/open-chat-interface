import { useRef } from 'react';
import {
  currentOpener,
  type FocusPlace,
  focusPlace,
  keepFocusWhenRemoved,
  rememberPlace,
  trackFocus,
} from '~/lib/focus-return';

// From the start, not the first dialog: the opener may be focused before any
// dialog has rendered (a Select whose choice opens a confirmation).
trackFocus();

/**
 * WCAG 2.4.3 Focus Order for a Radix dialog opened from component state.
 *
 * Such dialogs have no DialogTrigger, so Radix has nothing to hand focus back
 * to and it falls to the body. These handlers remember the opener when the
 * dialog opens and restore it when it closes; if the opener has gone (its row
 * was deleted), focus goes to the neighbouring row or the section's heading
 * (#41, #128).
 *
 * The opener is read in onOpenAutoFocus, which Radix fires on every open
 * before it moves focus into the dialog. An effect cannot do this: the
 * content's own effects (Radix's FocusScope) run first and see an element
 * inside the dialog, never the opener.
 */
export function useFocusReturn() {
  const placeRef = useRef<FocusPlace | null>(null);

  return {
    onOpenAutoFocus() {
      const opener = currentOpener();
      placeRef.current = opener ? rememberPlace(opener) : null;
    },
    /** Call after the caller's own handler; does nothing if that prevented the default. */
    onCloseAutoFocus(event: Event) {
      if (event.defaultPrevented) return;
      const place = placeRef.current;
      if (!place) return;
      event.preventDefault();
      const restored = place.element.isConnected;
      focusPlace(place);
      // The action may remove the opener's row after the dialog has closed,
      // when its list refetches.
      if (restored) keepFocusWhenRemoved(place.element, place);
    },
  };
}
