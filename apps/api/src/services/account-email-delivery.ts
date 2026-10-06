import { logger } from '../lib/logger.js';
import { noteRedisFailure, sharedRedis } from './chat-streams.js';

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

/**
 * Emails of one kind to one account are sent at most once in this many
 * seconds (#330). Accepting an invitation, signing in before verifying and
 * pressing Resend each sent a verification link: three in 25 seconds, all
 * valid for an hour. The later requests are answered as before (the answer
 * never says whether anything was sent) but send nothing while a link
 * delivered within the window is still fresh. Counted from delivery, so a
 * failed send does not hold back the next request.
 */
export const ACCOUNT_EMAIL_COOLDOWN_SECONDS = 60;
const COOLDOWN_PREFIX = 'oci:account-email:delivered';
/** Per replica when Redis is unavailable, as the rate limits fall back. */
const localDelivered = new Map<string, number>();

async function deliveredRecently(key: string): Promise<boolean> {
  const redis = await sharedRedis().catch(() => null);
  if (redis) {
    try {
      return (await redis.exists(`${COOLDOWN_PREFIX}:${key}`)) === 1;
    } catch (error) {
      noteRedisFailure(error);
    }
  }
  return (localDelivered.get(key) ?? 0) > Date.now();
}

async function noteDelivered(key: string, seconds: number): Promise<void> {
  const now = Date.now();
  localDelivered.set(key, now + seconds * 1000);
  if (localDelivered.size > 10_000)
    for (const [candidate, until] of localDelivered)
      if (until <= now) localDelivered.delete(candidate);
  const redis = await sharedRedis().catch(() => null);
  if (!redis) return;
  try {
    await redis.set(`${COOLDOWN_PREFIX}:${key}`, '1', 'EX', seconds);
  } catch (error) {
    noteRedisFailure(error);
  }
}

/** Starts `send` without waiting for it. Never throws, and never rejects unhandled. */
export function sendAfterResponse(
  kind: string,
  userId: string,
  send: Send,
  options: { cooldownSeconds?: number } = {},
): void {
  const key = `${kind}:${userId}`;
  const previous = latest.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const request = Symbol(key);
  latest.set(key, { request });
  attempt({ key, request, kind, userId, send, retry: 0, cooldown: options.cooldownSeconds ?? 0 });
}

function attempt(job: {
  key: string;
  request: symbol;
  kind: string;
  userId: string;
  send: Send;
  retry: number;
  cooldown: number;
}): void {
  const { key, request, kind, userId } = job;
  const task = (async () => {
    let outcome: Awaited<ReturnType<Send>> = { delivered: false };
    try {
      if (job.cooldown > 0 && (await deliveredRecently(key))) {
        logger.info({ userId, kind }, 'Account email skipped: one was delivered a moment ago');
        outcome = { delivered: true };
      } else {
        outcome = await job.send();
        if (outcome.delivered && job.cooldown > 0) await noteDelivered(key, job.cooldown);
      }
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
