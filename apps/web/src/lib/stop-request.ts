/**
 * Asking the server to stop a reply, and asking again when the request did not
 * get through (#351).
 *
 * A Stop pressed while the database was away answered a retryable 500 (or the
 * connection failed), the page swallowed it, and it went on saying "Stopping
 * the reply…" while the reply ran to its end. Stopping is safe to repeat, so
 * a request that failed for a reason that may pass is sent again, with a
 * growing pause, for as long as the person still wants the reply stopped.
 */

/** Pauses before each further attempt; the last one repeats. */
export const STOP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 5_000];

/** What a failed attempt means: the server may take it a moment later, or never will. */
function passing(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Sends the stop request until the server has taken it. `delivered`: the
 * server answered it (whether or not a reply was still running there).
 * `refused`: it answered with an error that sending again will not change
 * (the session ended, the conversation is gone). `cancelled`: the caller no
 * longer wants it (`signal` aborted), so nothing more is sent.
 *
 * `onDelayed` is called after each attempt that did not get through, so the
 * page can say Stop has not reached the server yet. The request itself is not
 * tied to `signal`: one already on its way is allowed to land.
 */
export async function requestStop(
  threadId: string,
  signal: AbortSignal,
  onDelayed: () => void,
): Promise<'delivered' | 'refused' | 'cancelled'> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return 'cancelled';
    let status: number | null = null;
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(threadId)}/stream`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // The connection failed (the API is restarting, the network dropped).
    }
    if (status !== null && status >= 200 && status < 300) return 'delivered';
    if (status !== null && !passing(status)) return 'refused';
    if (signal.aborted) return 'cancelled';
    onDelayed();
    const delay = STOP_RETRY_DELAYS_MS[Math.min(attempt, STOP_RETRY_DELAYS_MS.length - 1)]!;
    if (!(await wait(delay, signal))) return 'cancelled';
  }
}
