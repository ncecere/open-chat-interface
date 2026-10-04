/**
 * Database connection loss (v0.11 design, section 3, failover safety).
 *
 * When the primary changes (Patroni, a managed failover, a restart behind
 * HAProxy or a virtual IP) every connection to the old primary drops: open
 * transactions roll back, session advisory locks are released, and queries
 * in flight fail with one of the errors below. postgres.js opens new
 * connections for later queries on its own; what fails is only the work that
 * was in flight, and whether it may simply be run again depends on the work.
 */

/**
 * SQLSTATEs and driver codes that mean "the connection went away", not "the
 * statement was wrong". 57P01-57P03: the server is shutting down, crashed or
 * cannot accept connections yet; class 08: connection exceptions; the rest
 * are socket errors and postgres.js's own codes for a closed connection.
 * 25006 (read-only transaction) is what a write gets from a node that was
 * just demoted to a replica, before the proxy notices.
 *
 * CONNECTION_DESTROYED is left out on purpose: it is this process closing
 * its own pool on shutdown, which retrying would only prolong.
 */
export const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '25006',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
]);

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  if (typeof code === 'string') return code;
  return typeof errno === 'string' ? errno : undefined;
}

/**
 * Whether an error (or its cause: Drizzle wraps driver errors in a
 * DrizzleQueryError) is a lost database connection.
 */
export function isConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = codeOf(current);
    if (code && CONNECTION_ERROR_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

let closedConnections = 0;

/**
 * Called by the application pool whenever one of its connections closes
 * (postgres.js `onclose`). The pool has no idle or lifetime limit that closes
 * connections in normal operation, so a change in this count while a request
 * ran means a connection was lost under it.
 */
export function noteConnectionClosed(): void {
  closedConnections++;
}

/** Monotonic count of connections the application pool has lost. */
export function connectionLossCount(): number {
  return closedConnections;
}

export interface RetryOptions {
  /** Total time to keep trying after the first failure (default 30 s). */
  budgetMs?: number;
  /** First pause; doubles each attempt up to `maxDelayMs` (default 250 ms). */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each retry, for a log line. */
  onRetry?: (details: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Runs `operation`, and runs it again while it fails with a lost connection,
 * with backoff, for at most `budgetMs`: long enough for a failover to finish
 * (a Patroni switchover takes seconds, an unplanned failover up to its TTL).
 * Any other error, or the last connection error, is thrown as it came.
 *
 * Only for work that is safe to repeat: the operation must be idempotent, or
 * know from `attempt` that an earlier attempt may have committed.
 */
export async function retryOnConnectionError<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const budgetMs = options.budgetMs ?? 30_000;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  let delayMs = options.initialDelayMs ?? 250;
  let deadline: number | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      deadline ??= Date.now() + budgetMs;
      const wait = Math.min(delayMs, maxDelayMs, deadline - Date.now());
      if (wait <= 0) throw error;
      options.onRetry?.({ attempt, delayMs: wait, error });
      await new Promise((resolve) => setTimeout(resolve, wait));
      delayMs *= 2;
    }
  }
}
