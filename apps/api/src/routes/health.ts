import { Hono } from 'hono';
import { sql as sqlClient } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { AppBindings } from '../middleware/context.js';

export const healthRoutes = new Hono<AppBindings>();

healthRoutes.get('/live', (c) => c.json({ status: 'ok' }));

healthRoutes.get('/ready', async (c) => {
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
