import { retryOnConnectionError } from '../../lib/db-connection.js';
import { logger } from '../../lib/logger.js';
import { requestStartedAt } from '../observability/request-timing.js';

/**
 * A new message sent while the database is unreachable (#326).
 *
 * docs/OPERATIONS.md promises that a new message whose saving meets a failover
 * is retried for up to 10 s. That held only for the prompt's own transaction
 * (persist-turn.ts): a message sent while the database was already away
 * failed within milliseconds, in the session lookup or the conversation's
 * reads, and the person's text was lost. Now every step of a new turn up to
 * its saving waits out a lost connection too, within one deadline counted
 * from when the request arrived, so the browser (which has no timeout of its
 * own; the bundled proxy waits minutes) hears back within about 10 s.
 *
 * Each step is safe to run again: the session lookup and the reads change
 * nothing, and the turn's two earlier writes (the conversation's claim and the
 * usage reservation) are keyed by the run's ID, which stays the same across
 * attempts, so an attempt whose commit was lost with its connection is
 * recognised rather than written twice (thread-claim.ts, quota/reservation.ts).
 */
export const TURN_PATIENCE_MS = 10_000;

/**
 * Tells the browser whether the message of a failed send can have been
 * stored. `no`: the request failed before the prompt's transaction began, so
 * nothing of it exists and the browser puts the text back in the message box.
 * Absent: it may have been stored, and the browser reloads the saved messages
 * to find out.
 */
export const MESSAGE_SAVED_HEADER = 'X-OCI-Message-Saved';

/** What a person is told when their message was not sent for a lost connection. */
export const MESSAGE_NOT_SENT_TEXT =
  'The connection to the database was interrupted, so your message was not sent. Send it again in a moment.';

const deadlines = new WeakMap<Request, number>();
const saving = new WeakSet<Request>();

/** POST /api/chat: a new message or a retry, not an approval's continuation. */
export function isNewTurnRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return false;
  const path = new URL(request.url).pathname;
  return path === '/api/chat' || path === '/api/chat/';
}

/** When this turn stops waiting for the database (`Date.now()` time). */
export function turnDeadline(request: Request): number {
  let deadline = deadlines.get(request);
  if (deadline === undefined) {
    const waited = Math.max(0, performance.now() - requestStartedAt(request));
    deadline = Date.now() - waited + TURN_PATIENCE_MS;
    deadlines.set(request, deadline);
  }
  return deadline;
}

/** The prompt's transaction is about to run: from here the message may be stored. */
export function noteTurnSaving(request: Request): void {
  saving.add(request);
}

/** A new turn's request that failed before its message could be stored. */
export function turnNotSaved(request: Request): boolean {
  return isNewTurnRequest(request) && !saving.has(request);
}

/**
 * Runs one step of a new turn, again while it fails with a lost connection,
 * until the turn's deadline. Without a deadline (a turn that is not a new
 * message, such as an approval's continuation) it runs once.
 */
export function retryTurnStep<T>(
  deadline: number | undefined,
  step: string,
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  if (deadline === undefined) return operation(1);
  return retryOnConnectionError(operation, {
    deadline,
    initialDelayMs: 200,
    // Short pauses: the turn starts within a second of the database's return.
    maxDelayMs: 1_000,
    onRetry: ({ attempt, delayMs, error }) =>
      logger.warn(
        { step, attempt, delayMs, err: error instanceof Error ? error.message : String(error) },
        'Database unreachable while starting a reply; retrying',
      ),
  });
}
