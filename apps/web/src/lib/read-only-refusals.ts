import type { MutationObserver, QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ApiError } from '~/lib/api-client';
import {
  READ_ONLY_MESSAGE_START,
  readOnlyStatus,
  subscribeReadOnlyStatus,
  useReadOnlyStatus,
} from '~/lib/read-only';

/**
 * A change refused for read-only maintenance says so beside the control
 * ("Read-only for maintenance until about 7:50 AM EDT: …"). Once read-only is
 * turned off, the banner's poll (or any answer) clears the store, but the
 * refusal stayed until the next action, next to a page with no banner, saying
 * the service was read-only when it was not (#308). These clear it then.
 */

/** Whether an error, or the text shown for one, is a read-only refusal. */
export function isReadOnlyRefusal(error: unknown): boolean {
  if (error instanceof ApiError && error.code === 'READ_ONLY') return true;
  const text = typeof error === 'string' ? error : (error as Error | null)?.message;
  return typeof text === 'string' && text.startsWith(READ_ONLY_MESSAGE_START);
}

/**
 * Resets every mutation whose error is a read-only refusal once read-only is
 * off, so a page's `mutation.error` alert goes. The mutation cache names the
 * observer each time one starts or stops watching a mutation, which is the
 * only way to reach `useMutation`'s reset from outside the component.
 * Installed once, on the app's QueryClient; returns the uninstall.
 */
export function clearReadOnlyRefusalsWhenLifted(queryClient: QueryClient): () => void {
  // biome-ignore lint/suspicious/noExplicitAny: observers of every mutation's types.
  const observers = new Set<MutationObserver<any, any, any, any>>();
  const stopWatching = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === 'observerAdded') observers.add(event.observer);
    else if (event.type === 'observerRemoved') observers.delete(event.observer);
  });
  const stopListening = subscribeReadOnlyStatus(() => {
    if (readOnlyStatus().active) return;
    // A copy: reset() stops the observer watching, which removes it from the set.
    for (const observer of [...observers]) {
      if (isReadOnlyRefusal(observer.getCurrentResult().error)) observer.reset();
    }
  });
  return () => {
    stopWatching();
    stopListening();
  };
}

/**
 * The same for a refusal a form keeps in its own state (a message, or a list
 * of problems): `clear` runs once read-only is off while it is shown.
 */
export function useClearReadOnlyRefusal(
  shown: string | null | undefined | ReadonlyArray<{ text: string }>,
  clear: () => void,
): void {
  const { active } = useReadOnlyStatus();
  const refused =
    typeof shown === 'string'
      ? isReadOnlyRefusal(shown)
      : (shown ?? []).some((problem) => isReadOnlyRefusal(problem.text));
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    if (refused && !active) clearRef.current();
  }, [refused, active]);
}
