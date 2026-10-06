import { useEffect, useRef } from 'react';

/**
 * Clears a form's error once the form changes (#178, #217).
 *
 * A validation or save error is about the values that were submitted. Once
 * any of them changes it may no longer hold, so it goes, and the next attempt
 * reports afresh. Left on screen it contradicted the corrected field, and on
 * a settings page whose corrected form matched what was saved (Save
 * disabled) it stayed indefinitely.
 *
 * `values` is everything the form submits; it is compared by content, so a
 * new object with the same values is not an edit. `clear` resets whatever
 * holds the error: a local message, a mutation (`mutation.reset()`), or both.
 * Use it in every form that keeps an error from its last attempt.
 */
export function useClearOnEdit(values: unknown, clear: () => void): void {
  const key = JSON.stringify(values);
  const previous = useRef(key);
  const latestClear = useRef(clear);
  latestClear.current = clear;

  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    latestClear.current();
  }, [key]);
}
