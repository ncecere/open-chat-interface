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
export const readiness = { databaseGraceMs: 30_000 };
let databaseDownSince: number | null = null;

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
  let database: 'ok' | 'error' = 'ok';

  try {
    await sqlClient`select 1`;
  } catch (error) {
    logger.error({ error }, 'Database readiness check failed');
    database = 'error';
  }

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
