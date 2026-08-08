import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../../middleware/context.js';
import { parseQuery } from '../../middleware/validate.js';
import {
  activitySummary,
  dailyActivity,
  dailyUsage,
  denialSummary,
  idleModels,
  modelUsage,
  storageSummary,
  topConsumers,
  usageRange,
  usageTotals,
} from '../../services/usage-report.js';

export const usageRoutes = new Hono<AppBindings>();

/** Fixed choices rather than a free range, so a query cannot be unbounded. */
const querySchema = z.object({
  days: z
    .enum(['7', '30', '90'])
    .optional()
    .transform((value) => Number(value ?? '30')),
});

/** Activity and volume: what people are doing, without reference to cost. */
usageRoutes.get('/overview', async (c) => {
  const { days } = parseQuery(c, querySchema);

  const [range, totals, activity, daily] = await Promise.all([
    usageRange(days),
    usageTotals(days),
    activitySummary(days),
    dailyActivity(days),
  ]);

  return c.json({ range, totals, activity, daily });
});

/** Spend, split by model and by person. */
usageRoutes.get('/spend', async (c) => {
  const { days } = parseQuery(c, querySchema);

  const [range, totals, daily, models, consumers, idle] = await Promise.all([
    usageRange(days),
    usageTotals(days),
    dailyUsage(days),
    modelUsage(days),
    topConsumers(days),
    idleModels(days),
  ]);

  return c.json({ range, totals, daily, models, consumers, idleModels: idle });
});

/** Where limits are biting, which is usually a configuration signal. */
usageRoutes.get('/limits', async (c) => {
  const { days } = parseQuery(c, querySchema);
  const [range, denials] = await Promise.all([usageRange(days), denialSummary(days)]);
  return c.json({ range, denials });
});

/** Object storage consumption. Not time-ranged: storage is a gauge. */
usageRoutes.get('/storage', async (c) => {
  return c.json(await storageSummary());
});
