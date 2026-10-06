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
 *
 * Product decision (#327): a send that fails is tried again, twice, after
 * one and then five minutes, with the same link (both kinds work for an
 * hour). Nothing told the person that their email had failed, and after a
 * short mail outage nothing was ever sent. The retries live in this
 * process's memory only: a restart drops them, and the person can still ask
 * again (Resend verification email, Forgot password). A newer request for the
 * same email to the same account replaces a retry still waiting, so an outage
 * does not end in a burst of old links.
 */
const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000];
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;

/** Shorter delays for tests; null restores the defaults. */
export function setAccountEmailRetryDelays(delays: number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

const inFlight = new Set<Promise<void>>();
/** The latest request for each kind of email and account, and its waiting retry. */
const latest = new Map<string, { request: symbol; timer?: ReturnType<typeof setTimeout> }>();

type Send = () => Promise<{ delivered: boolean; notConfigured?: boolean }>;

/** Starts `send` without waiting for it. Never throws, and never rejects unhandled. */
export function sendAfterResponse(kind: string, userId: string, send: Send): void {
  const key = `${kind}:${userId}`;
  const previous = latest.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const request = Symbol(key);
  latest.set(key, { request });
  attempt({ key, request, kind, userId, send, retry: 0 });
}

function attempt(job: {
  key: string;
  request: symbol;
  kind: string;
  userId: string;
  send: Send;
  retry: number;
}): void {
  const { key, request, kind, userId } = job;
  const task = (async () => {
    let outcome: Awaited<ReturnType<Send>> = { delivered: false };
    try {
      outcome = await job.send();
    } catch (error) {
      logger.error({ error, userId, kind }, 'Account email could not be sent');
    }
    const current = latest.get(key);
    if (outcome.delivered || current?.request !== request) {
      if (current?.request === request) latest.delete(key);
      return;
    }
    // Nothing to retry against until an administrator sets email up.
    const delay = outcome.notConfigured ? undefined : retryDelaysMs[job.retry];
    if (delay === undefined) {
      latest.delete(key);
      // sendEmail has logged the reason; this says which account is affected.
      logger.warn({ userId, kind }, 'Account email not delivered; not trying again');
      return;
    }
    logger.warn(
      { userId, kind, retryInSeconds: Math.round(delay / 1000) },
      'Account email not delivered; trying again later',
    );
    const timer = setTimeout(() => attempt({ ...job, retry: job.retry + 1 }), delay);
    // A waiting retry does not keep the process alive.
    timer.unref?.();
    latest.set(key, { request, timer });
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
