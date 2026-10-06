import { logger } from '../lib/logger.js';

/**
 * Account emails (a password reset, an email verification) go out after the
 * request has been answered (#328).
 *
 * Forgot password awaited the SMTP send for an address with an account and
 * answered at once for one without, so its response time said which
 * addresses have accounts: about 7× slower, and about 10 s while the mail
 * server was unreachable. Better Auth evens out the database work itself
 * (a dummy lookup for an unknown address, a 500 ms floor on resend
 * verification), but not a slow or failing mail server. Sending in the
 * background makes the answer independent of the mail server, so the
 * response is the same either way. Whether delivery worked is never part of
 * the answer anyway: these endpoints must not reveal whether an account
 * exists.
 *
 * Everything that decides the outcome (the rate limits, read-only mode, the
 * token row, a database outage) still happens in the request; only the send
 * is deferred. A send still running is waited for on shutdown
 * (`accountEmailsInFlight`, server.ts).
 */
const inFlight = new Set<Promise<void>>();

/** Starts `send` without waiting for it. Never throws, and never rejects unhandled. */
export function sendAfterResponse(
  kind: string,
  userId: string,
  send: () => Promise<{ delivered: boolean }>,
): void {
  const task = (async () => {
    try {
      const { delivered } = await send();
      // sendEmail has logged the reason; this says which account is affected.
      if (!delivered) logger.warn({ userId, kind }, 'Account email not delivered');
    } catch (error) {
      logger.error({ error, userId, kind }, 'Account email could not be sent');
    }
  })();
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
}

/** How many account emails are being sent right now, for the shutdown drain. */
export function accountEmailsInFlight(): number {
  return inFlight.size;
}

/** Resolves once every account email started so far has finished (tests, shutdown). */
export async function settleAccountEmails(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
