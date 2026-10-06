import { useEffect, useRef } from 'react';

/** How often a failed load tries again by itself, and for how long (two minutes). */
export const AUTO_RETRY_MS = 5_000;
export const AUTO_RETRY_ATTEMPTS = 24;

/**
 * While `failed`, calls `retry` every AUTO_RETRY_MS for two minutes, so a few
 * seconds (or a minute) of database or network trouble does not need a click
 * or a reload once it is over (#164, #233). Starts again from the first
 * attempt each time the load fails anew after succeeding.
 */
export function useAutoRetry(failed: boolean, retry: () => void) {
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (!failed) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts >= AUTO_RETRY_ATTEMPTS) clearInterval(timer);
      latest.current();
    }, AUTO_RETRY_MS);
    return () => clearInterval(timer);
  }, [failed]);
}
