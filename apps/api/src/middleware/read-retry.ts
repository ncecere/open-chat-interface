import { connectionLossCount, isConnectionError } from '../lib/db-connection.js';

/**
 * Requests caught by a database failover (v0.11 design, section 3).
 *
 * A request whose query was in flight when the primary changed fails with a
 * connection error. What happens next depends on the method:
 *
 * - GET, HEAD and OPTIONS only read, so the API runs the request once more,
 *   after a short pause (`readRetry.delayMs`), on a new connection. The client sees one slower answer
 *   instead of an error. Only once: a second failure is reported.
 * - Anything else may have changed something (or may have committed just as
 *   the connection dropped), so it is never repeated behind the client's
 *   back. It answers `500` with `retryable: true` in the error body and an
 *   `X-OCI-Retryable: database-connection` header, so a client that knows the
 *   operation is safe to repeat can send it again. Not `503`: that status is
 *   reserved for a draining replica (lib/drain.ts), and the bundled proxy
 *   takes a replica that answers `503` out of rotation.
 *
 * A failure counts as a lost connection when the error says so, or when the
 * error is an unexpected one (or a handler's own 500 response) and the pool
 * lost a connection while the request ran: Better Auth, for one, reports a
 * failed session lookup as its own error, and answers its own endpoints with
 * its own 500, without the cause.
 */

export const RETRYABLE_HEADER = 'X-OCI-Retryable';
export const RETRYABLE_REASON = 'database-connection';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The pause before a read runs again: long enough for a dropped pool to reconnect. */
export const readRetry = { delayMs: 250 };

/** The pool's connection-loss count when each request started. */
const lossesAtStart = new WeakMap<Request, number>();

/**
 * Whether an unexpected error in this request should be reported as a lost
 * database connection (and so marked retryable).
 */
export function lostConnectionDuring(request: Request | undefined, error: unknown): boolean {
  if (isConnectionError(error)) return true;
  if (!request) return false;
  const start = lossesAtStart.get(request);
  return start !== undefined && connectionLossCount() !== start;
}

function marked(response: Response): boolean {
  return response.headers.get(RETRYABLE_HEADER) === RETRYABLE_REASON;
}

/** A 500 caused by a lost connection: marked by the error handler, or the pool lost one meanwhile. */
function lostConnection(response: Response, lossesBefore: number): boolean {
  return response.status === 500 && (marked(response) || connectionLossCount() !== lossesBefore);
}

/** Adds the retryable header to a 500 that came from elsewhere (a library's own response). */
function markRetryable(response: Response): Response {
  if (marked(response)) return response;
  const headers = new Headers(response.headers);
  headers.set(RETRYABLE_HEADER, RETRYABLE_REASON);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type FetchHandler = (request: Request, ...rest: never[]) => Response | Promise<Response>;

/**
 * Wraps the application's fetch handler: records when each request started
 * relative to connection losses, and runs a read once more when it failed
 * because its database connection was lost.
 */
export function withReadRetry<F extends FetchHandler>(fetch: F): F {
  return (async (request: Request, ...rest: never[]) => {
    let before = connectionLossCount();
    lossesAtStart.set(request, before);
    const response = await fetch(request, ...rest);
    if (!lostConnection(response, before)) return response;
    if (!READ_METHODS.has(request.method.toUpperCase())) return markRetryable(response);
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, readRetry.delayMs));
    before = connectionLossCount();
    lossesAtStart.set(request, before);
    const again = await fetch(request, ...rest);
    return lostConnection(again, before) ? markRetryable(again) : again;
  }) as F;
}
