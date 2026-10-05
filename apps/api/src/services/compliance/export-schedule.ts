import { and, eq, gt, gte, or, schema } from '@oci/db';
import { db } from '../../db/index.js';

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;

/** The most recent scheduled start at or before `now`: the hour, or today's hour (UTC). */
export function complianceSlot(now: Date, schedule: 'hourly' | 'daily', hourUtc: number): Date {
  if (schedule === 'hourly') {
    const slot = new Date(now);
    slot.setUTCMinutes(0, 0, 0);
    return slot;
  }
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0),
  );
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

/**
 * Whether the current slot is covered: a successful export since it began, or
 * a scheduled attempt in the last hour (so a failure is retried hourly
 * rather than on every tick).
 */
export async function slotCovered(slot: Date, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.complianceExportRun.id })
    .from(schema.complianceExportRun)
    .where(
      and(
        gte(schema.complianceExportRun.startedAt, slot),
        or(
          eq(schema.complianceExportRun.status, 'succeeded'),
          and(
            eq(schema.complianceExportRun.trigger, 'schedule'),
            gt(schema.complianceExportRun.startedAt, new Date(now.getTime() - HOUR_MS)),
          ),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}
