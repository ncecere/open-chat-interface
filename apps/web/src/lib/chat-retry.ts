/**
 * Sending again when a server refuses a turn because it is shutting down
 * (v0.11). A replica that is draining answers a new chat turn with `503` and
 * `Retry-After` before reading it, so nothing was stored and sending the same
 * request again cannot duplicate the message; the retry reaches a replica that
 * is ready. Any other failure is returned as it came.
 */

import { noteReadOnlyResponse } from '~/lib/read-only';
import { noteUnauthorizedResponse } from '~/lib/session-ended';

/** Retries after the first refusal; then the refusal is shown as an error. */
export const DRAIN_RETRIES = 2;
const MAX_WAIT_MS = 5_000;

/** Milliseconds to wait before sending again, or null when this is not a drain refusal. */
export function drainRetryDelay(response: Response): number | null {
  if (response.status !== 503) return null;
  const header = response.headers.get('Retry-After');
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_WAIT_MS, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.min(MAX_WAIT_MS, Math.max(0, at - Date.now()));
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `fetch`, sending a refused POST again up to `retries` times. */
export async function fetchRetryingDrain(
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = DRAIN_RETRIES,
): Promise<Response> {
  // Only a body that can be sent again; the chat transport sends JSON text.
  const repeatable =
    init?.method?.toUpperCase() === 'POST' &&
    (init.body === undefined || init.body === null || typeof init.body === 'string');
  let response = await send(input, init);
  for (let attempt = 0; repeatable && attempt < retries; attempt++) {
    const delay = drainRetryDelay(response);
    if (delay === null) break;
    await response.body?.cancel().catch(() => undefined);
    await wait(delay, init?.signal);
    response = await send(input, init);
  }
  // Read-only maintenance mode (423, never retried): the page says so at once.
  await noteReadOnlyResponse(response);
  // A session that ended while the page was open: to sign-in (#165).
  noteUnauthorizedResponse(response);
  return response;
}
