import { Hono } from 'hono';
import { sql as sqlClient } from '../db/index.js';
import { drainState } from '../lib/drain.js';
import { logger } from '../lib/logger.js';
import { processRole } from '../lib/role.js';
import type { AppBindings } from '../middleware/context.js';
import { observeReadiness } from '../services/observability/events.js';

export const healthRoutes = new Hono<AppBindings>();

/** The process is up. Stays 200 while it drains, so it is not restarted mid-drain. */
healthRoutes.get('/live', (c) => c.json({ status: 'ok' }));

/**
 * How long the database may be unreachable before readiness fails (v0.11).
 * A failover makes every replica's database unreachable at once for a few
 * seconds; failing readiness at the first error would take every replica out
 * of rotation together and turn requests the API retries (or marks retryable)
 * into a full outage. Past this, the outage is real and readiness says so.
 */
export const readiness = {
  databaseGraceMs: 30_000,
  /**
   * How long a dependency check may take before it counts as failing (#232).
   * A database whose host does not resolve, or whose address drops packets
   * during a failover, kept readiness waiting for 5-15 s or until the driver's
   * connect timeout; a probe that gives up after 1-3 s counted that as a
   * failure and took the replica out of rotation inside the grace above.
   * Below the Helm chart's 2 s probe timeout.
   */
  checkTimeoutMs: 1_000,
};
let databaseDownSince: number | null = null;
/**
 * The database check in progress. A probe that arrives while an earlier
 * check still waits joins it rather than queuing another query behind it,
 * so probes every 2 s through an outage do not pile up on the pool.
 */
let databaseCheck: Promise<unknown> | null = null;

async function checkDatabase(): Promise<'ok' | 'error'> {
  if (!databaseCheck) {
    const check: Promise<unknown> = Promise.resolve(sqlClient`select 1`).finally(() => {
      if (databaseCheck === check) databaseCheck = null;
    });
    databaseCheck = check;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No answer within ${readiness.checkTimeoutMs} ms`)),
      readiness.checkTimeoutMs,
    );
  });
  try {
    await Promise.race([databaseCheck, timeout]);
    return 'ok';
  } catch (error) {
    logger.error({ error }, 'Database readiness check failed');
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether to send this replica new traffic. 503 from the first shutdown signal
 * (v0.11), with the reason, so a load balancer or Kubernetes stops routing
 * here before the process exits; and 503 once the database has been
 * unreachable for longer than `readiness.databaseGraceMs` (before that the
 * answer is 200 with `status: degraded`). The same on a worker
 * (OCI_ROLE=worker), whose body names its role.
 */
healthRoutes.get('/ready', async (c) => {
  const draining = drainState();
  if (draining) {
    return c.json(
      {
        status: 'draining',
        role: processRole(),
        reason: `Shutting down (${draining.reason}); finishing replies in progress`,
        checks: {},
      },
      503,
      { 'Retry-After': '1' },
    );
  }
  const database = await checkDatabase();

  if (database === 'ok') databaseDownSince = null;
  else databaseDownSince ??= Date.now();
  const ready =
    databaseDownSince === null || Date.now() - databaseDownSince < readiness.databaseGraceMs;
  observeReadiness(ready);
  return c.json(
    {
      status: database === 'ok' ? 'ok' : 'degraded',
      role: processRole(),
      checks: { database },
      ...(databaseDownSince === null ? {} : { databaseDownForMs: Date.now() - databaseDownSince }),
    },
    ready ? 200 : 503,
  );
});
