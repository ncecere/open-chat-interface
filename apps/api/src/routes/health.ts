import { Hono } from 'hono';
import { sql as sqlClient } from '../db/index.js';
import { drainState } from '../lib/drain.js';
import { logger } from '../lib/logger.js';
import type { AppBindings } from '../middleware/context.js';

export const healthRoutes = new Hono<AppBindings>();

/** The process is up. Stays 200 while it drains, so it is not restarted mid-drain. */
healthRoutes.get('/live', (c) => c.json({ status: 'ok' }));

/**
 * Whether to send this replica new traffic. 503 while the database is
 * unreachable, and from the first shutdown signal (v0.11), with the reason, so
 * a load balancer or Kubernetes stops routing here before the process exits.
 */
healthRoutes.get('/ready', async (c) => {
  const draining = drainState();
  if (draining) {
    return c.json(
      {
        status: 'draining',
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

  const ready = database === 'ok';
  return c.json({ status: ready ? 'ok' : 'degraded', checks: { database } }, ready ? 200 : 503);
});
