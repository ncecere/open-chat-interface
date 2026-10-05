import { and, eq, gte, or, schema } from '@oci/db';
import { db } from '../../db/index.js';

/** The most recent scheduled start at or before `now`. */
export function scheduledSlot(now: Date, hourUtc: number): Date {
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0),
  );
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

/** Whether today's slot is already covered: any scheduled attempt, or a successful manual backup. */
export async function slotCovered(slot: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.backupRun.id })
    .from(schema.backupRun)
    .where(
      and(
        gte(schema.backupRun.startedAt, slot),
        or(eq(schema.backupRun.trigger, 'schedule'), eq(schema.backupRun.status, 'succeeded')),
      ),
    )
    .limit(1);
  return Boolean(row);
}
